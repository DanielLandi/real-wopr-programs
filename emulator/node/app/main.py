"""API / Emulation Bridge — FastAPI entry point.

REST for session lifecycle + catalog, WebSocket for the live link-shaped
stream (api-contract.md). The WS endpoint is INTERNAL-ONLY in deployment:
ingress never routes /ws/*, only the comms layer reaches it (deployment.md D3).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import secrets
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .attachment import FRONT_DOOR
from .budget import DailyBudget, MeteredJoshua
from .callback import place_seat_call
from .config import load_settings
from .execstack import decode as decode_stack, encode as encode_stack
from .games import load_catalog
from .gtwhub import GtwRoomHub
from .joshua import ClaudeJoshua, Joshua, LispJoshua, ScriptedJoshua
from .operators import parse_roster
from .rooms import RoomLocks
from .router import ExecutiveUnavailable, Router
from .runner import CoreRunner, RunnerConfig
from .session_turn import run_session_turn
from .store import make_store, normalize_room_code
from .systemrunner import SystemBusy, SystemFault, SystemRunner, SystemRunnerConfig, SystemTimeout
from .systems import load_programs, load_systems, validate_execs
from .tokens import sign_session, verify_session

log = logging.getLogger("wopr.bridge")

# Every surface this bridge will mint a session for. The value is the link
# profile stamped into each envelope's `link` field; the comms layer resolves
# the profile it actually PACES at from its own `surface_links` (relay/src/
# config.ts), which is authoritative — so a surface missing HERE is not a
# cosmetic gap, it is a 400 on POST /api/session and a call that cannot exist.
#
# The two trunk surfaces are the machine ends of a machine-to-machine call, and
# every such call mints an ordinary session here (relay/src/local-leg.ts's
# `openLocalLeg`): `trunk-call` is the end that ANSWERS, `trunk-caller` the end
# that PLACED. Their profiles mirror the relay's: a call is paced once, by the
# answering end (dialup-1200), and the calling end must not shape as well
# (`off`) or two shapers in series halve throughput for no fiction.
DEFAULT_LINKS = {
    "home-terminal": "dialup-300",
    "norad-terminal": "leased-9600",
    "norad-bigboard": "internal-bus",
    "wopr-panel": "internal-bus",
    "trunk-call": "dialup-1200",
    "trunk-caller": "off",
}

# Of those, the ones that exist for the RELAY and for nobody else (#74).
# `POST /api/session` authenticates no caller, deliberately — every visitor
# surface is one a stranger is supposed to be able to open, and a minted
# session is not access to anything: it lands at LOGON:, paced at the
# surface's baud. The two machine surfaces are the exception on both counts.
# A `trunk-caller` session is behind the front door from the moment it
# connects (see the WS handler below) and its profile is `off` — baud 0 — so
# it also skips the output shaping that is the only server-side bound on
# generated text, and for the `claude` engine on token spend per connection.
#
# Hence a guard scoped to these two, and NOT to the endpoint: authenticating
# the endpoint as a whole would refuse every browser that dials this
# exchange. Named rather than inferred from a `trunk-` prefix — a machine
# surface need not be called `trunk-anything` — with a test asserting the
# other direction, so a third trunk surface added without a guard fails in
# CI rather than in production.
INTERNAL_SURFACES = frozenset({"trunk-call", "trunk-caller"})


def _internal_token_ok(given: str | None, expected: str) -> bool:
    """Constant-time, over bytes.

    Bytes rather than str because `compare_digest` raises TypeError on a
    non-ASCII str, and this value comes off a public endpoint's headers —
    which starlette decodes as latin-1, so a caller could otherwise turn a
    refusal into a 500 by typing an umlaut.
    """
    if not given:
        return False
    return secrets.compare_digest(given.encode("utf-8", "replace"),
                                  expected.encode("utf-8"))


# Module-level on purpose: with `from __future__ import annotations`, FastAPI
# resolves annotation strings against module globals — local classes break it.
class CreateSession(BaseModel):
    surface: str
    link_profile: str | None = None
    room_code: str | None = None
    system: str | None = None
    # Which reconstruction of Joshua answers this session (?joshua= on the
    # surface). None takes the exchange's default.
    joshua: str | None = None


class CreateRoom(BaseModel):
    room_code: str | None = None


class DefconChange(BaseModel):
    level: int = Field(ge=1, le=5)


class RegisterExchange(BaseModel):
    id: str = Field(pattern=r"^[a-z0-9-]{2,40}$")
    name: str = Field(min_length=2, max_length=60)
    region: str = Field(min_length=2, max_length=40)
    api: str = Field(pattern=r"^https://", max_length=200)
    link: str = Field(pattern=r"^wss://", max_length=200)
    joshua: Literal["claude", "period"]
    operator: str | None = Field(default=None, max_length=24)


def _session_store_dir(settings, session_id: str):
    """Where a store's STATE lives for one dialled session.

    A store is shared by design — that is what makes it a database, and in a
    federation (one operator, one machine) sharing is exactly right. The
    monolith is different: it serves many unrelated strangers on one box, and a
    shared store means the first visitor to change David's biology grade
    changes it for everyone who dials in afterwards. The film's moment only
    works if each visitor finds the F themselves.

    So here, and only here, a store is scoped to the session that dialled it.
    """
    return settings.systems_dir.parent / ".wopr" / "sessions" / str(session_id)


def _timeout_for(programs):
    """Per-frame timeout for run_session_turn: each program on the stack keeps
    its own manifest timeout, including one an EXEC pushes mid-turn."""
    return lambda program: programs[program].timeout_s if program in programs else None


def _execs_for(programs):
    """Per-frame allow-list for run_session_turn: what a program may EXEC,
    straight from its manifest (validated once at startup, not per turn)."""
    return lambda program: programs[program].execs if program in programs else ()


# Processors a session may ask for by name. `scripted` is deliberately absent:
# it is the D5 kill-switch and the stand-in the tests and the Lisp engine fall
# through to, not one of the two reconstructions of Joshua on offer.
SELECTABLE_ENGINES = frozenset({"lisp", "claude"})

# Registered only when a key is present, so it is also the only engine whose
# availability can change while the exchange is up (the D5 budget).
METERED_ENGINE = "claude"


def build_engines(settings, catalog, budget=None) -> dict[str, "Joshua"]:
    """Every dialogue processor this exchange can actually serve.

    An engine is registered only when the thing it needs is present, so that
    `?joshua=` gets an honest 400 rather than something that answers in the
    wrong voice: `lisp` without its binary would quietly behave as `scripted`,
    and `claude` without a key would answer FALLBACK_LINE forever.

    `scripted` is always here — it is the D5 kill-switch and the backstop the
    Lisp engine falls through to — but it is never selectable (see
    SELECTABLE_ENGINES).
    """
    scripted = ScriptedJoshua({g.id: g.title for g in catalog.values()
                               if g.status == "implemented"})
    engines: dict[str, Joshua] = {"scripted": scripted}
    if settings.joshua_lisp_bin.exists():
        # The Falken Dialogue Processor (joshua/) — period Lisp with
        # anachronistic statistics; the scripted engine backs it up.
        engines["lisp"] = LispJoshua(settings.joshua_lisp_bin, fallback=scripted)
    if os.environ.get("ANTHROPIC_API_KEY"):
        claude = ClaudeJoshua(settings.joshua_model, settings.joshua_max_tokens,
                              settings.joshua_timeout_s)
        engines[METERED_ENGINE] = MeteredJoshua(claude, budget) if budget else claude
    return engines


def _fault_cause(exc: BaseException) -> str:
    """The EVENTS-row word for why a system turn failed."""
    if isinstance(exc, SystemBusy):
        return "busy"
    if isinstance(exc, SystemTimeout):
        return "timeout"
    return "fault"


def create_app(settings=None, store=None, engines=None, runner=None) -> FastAPI:
    """App factory; tests inject fakes for store/engines/runner.

    This is the module's only way to get an app: there is no module-level
    instance, so importing `app.main` reads no environment, warns about no
    missing token and opens no store (#84). Servers name the factory —
    `uvicorn app.main:create_app --factory`.
    """
    settings = settings or load_settings()
    if not settings.internal_token:
        # Loud once, at startup, rather than once per refusal: POST
        # /api/session is public, so a per-request warning is a log flood any
        # stranger can pull, while an unset token is a deployment-level fact.
        # Without it the machine surfaces refuse every mint (#74), so an
        # exchange that wants machine calls and forgot the variable would
        # otherwise learn about it only as a NO CARRIER on somebody else's
        # far end.
        log.warning(
            "BRIDGE_INTERNAL_TOKEN is unset: machine calls cannot mint a "
            "session (surfaces %s are refused) and /ws/session/{id} falls "
            "back to its session token alone",
            ", ".join(sorted(INTERNAL_SURFACES)),
        )
    store = store or make_store(settings.database_url)
    catalog = load_catalog(settings.games_dir)
    runner = runner or CoreRunner(RunnerConfig(
        bin_dir=settings.games_dir,
        timeout_s=settings.core_timeout_s,
        pool_size=settings.core_pool_size,
        queue_size=settings.core_queue_size,
    ))
    budget = DailyBudget(settings.joshua_claude_daily_calls)
    exchange_register_budget = DailyBudget(settings.exchange_register_daily)
    engines = engines or build_engines(settings, catalog, budget)
    # JOSHUA_ENGINE is no longer the switch — it is what a session gets when it
    # asks for nothing. Asking for one this exchange cannot serve falls back to
    # the always-present scripted engine rather than failing to boot.
    default_engine = settings.joshua_engine if settings.joshua_engine in engines else "scripted"

    def serveable_processors() -> list[str]:
        """What `?joshua=` may name right now. Ground truth, not intent.

        The metered engine drops off the list once its daily ceiling is reached,
        so a caller is never offered something the exchange can no longer
        afford, and the refusal below is the same one a typo gets.
        """
        names = [n for n in engines if n in SELECTABLE_ENGINES]
        if METERED_ENGINE in names and not budget.available():
            names.remove(METERED_ENGINE)
        return sorted(names)
    locks = RoomLocks()
    router = Router(runner, store, engines, catalog,
                    joshua_session_cap=settings.joshua_session_cap, locks=locks,
                    operators=parse_roster(settings.wopr_operators),
                    default_engine=default_engine,
                    executive_dir=settings.executive_dir)
    gtw_hub = GtwRoomHub(store, runner, catalog, locks)
    systems = load_systems(settings.systems_dir)
    # The dial-in phone book (systems) and the full program registry (programs)
    # answer different questions (systems.py docstring): a records program
    # reached only by EXEC has no number and so is invisible to load_systems,
    # but the stack still needs its timeout and its declared EXEC targets.
    # validate_execs runs once here, at process start, so a manifest typo is a
    # boot failure and never a caller's turn.
    programs = load_programs(settings.systems_dir)
    validate_execs(programs)
    system_runner = SystemRunner(
        SystemRunnerConfig(systems_dir=settings.systems_dir, timeout_s=settings.system_timeout_s),
        systems,
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        yield
        close = getattr(store, "close", None)
        if close is not None:
            await close()

    app = FastAPI(title="real-wopr bridge", version="0.3.0", lifespan=lifespan)
    app.state.router = router
    app.state.store = store
    app.state.settings = settings
    app.state.room_locks = locks
    app.state.gtw_hub = gtw_hub
    app.state.systems = systems
    app.state.system_runner = system_runner
    app.state.exchange_register_budget = exchange_register_budget

    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.cors_origins),
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # -- REST (api-contract.md §2) --------------------------------------------

    @app.get("/health")
    def health() -> dict:
        return {"status": "ok", "service": "wopr-node", "contract": "WOPR/1",
                # Which reconstructions of Joshua this exchange can serve right
                # now. Nothing renders a menu from it — it is how someone
                # passing ?joshua= finds out what a given exchange has.
                "joshua_processors": serveable_processors(),
                "joshua_default": default_engine}

    @app.post("/api/session", status_code=201)
    async def create_session(body: CreateSession, request: Request):
        if body.surface not in DEFAULT_LINKS:
            raise HTTPException(400, "unknown surface")
        if body.surface in INTERNAL_SURFACES:
            # The relay's `openLocalLeg` is the only caller of these, and it
            # already holds BRIDGE_INTERNAL_TOKEN (relay/src/local-leg.ts).
            # Checked here, before the room/system/processor validation
            # below, so a refusal has no side effects — no room is created
            # and no `last_seen_at` is touched by an unauthorised caller.
            if not settings.internal_token:
                # Fail closed, and say exactly what a surface that does not
                # exist is told: with no token configured there is no header
                # any caller could send that would be right, so an exchange
                # that never configured one behaves as it did before the
                # trunk surfaces existed. Deliberately unlike the
                # `/ws/session/{id}` guard, which can afford to fail open
                # because it still verifies an HMAC session token — this
                # endpoint has no second factor, and fail-open here IS #74.
                raise HTTPException(400, "unknown surface")
            if not _internal_token_ok(
                    request.headers.get("x-wopr-internal-token"),
                    settings.internal_token):
                raise HTTPException(401, "unauthorized")
        link = body.link_profile or DEFAULT_LINKS[body.surface]
        if body.system is not None:
            if body.system not in systems:
                raise HTTPException(400, "unknown system")
            if body.room_code is not None:
                # A system-bound session never enters the router/room paths;
                # accepting both would silently manufacture an inert room.
                # Checked before room creation so the refusal has no side
                # effects (api-contract.md §2.2).
                raise HTTPException(400, "system sessions do not join rooms")
        code = None
        if body.room_code is not None:
            try:
                code = normalize_room_code(body.room_code)
            except ValueError:
                raise HTTPException(400, "malformed room code")
            if await store.get_room(code) is None:
                await store.create_room(code)   # create_room stamps last_seen_at
            else:
                # One cheap write per join keeps the room's last_seen_at
                # truthful for idle-room reaping — never per-tick (#44).
                await store.touch_room(code)
        if body.joshua is not None and body.joshua.lower() not in serveable_processors():
            # Never substitute another processor. Someone comparing the two
            # reconstructions and quietly handed the wrong one would draw a
            # wrong conclusion from it, which is the worst failure available
            # when the whole point is measurement.
            raise HTTPException(
                400,
                f"this exchange cannot serve joshua={body.joshua!r}; "
                f"available: {serveable_processors()}",
            )
        session = await store.create_session(body.surface, link, user_id=None, room_code=code,
                                             system_id=body.system)
        if body.joshua is not None:
            router.select_engine(session.id, body.joshua.lower())
        return {
            "session_id": session.id,
            "token": sign_session(settings.session_secret, session.id),
            "link_profile": session.link_profile,
            "room_code": session.room_code,
            "system": session.system_id,
            "joshua": router.engine_name(session.id),
        }

    @app.post("/api/room", status_code=201)
    async def create_room(body: CreateRoom | None = None):
        requested = body.room_code if body else None
        if requested is not None:
            try:
                requested = normalize_room_code(requested)
            except ValueError:
                raise HTTPException(400, "malformed room code")
            existing = await store.get_room(requested)
            if existing is not None:  # idempotent: never recreate/reset a room
                return {"room_code": existing.code}
        room = await store.create_room(requested)
        return {"room_code": room.code}

    @app.get("/api/room/{room_code}")
    async def get_room(room_code: str):
        try:
            code = normalize_room_code(room_code)
        except ValueError:
            raise HTTPException(400, "malformed room code")
        room = await store.get_room(code)
        if room is None:
            raise HTTPException(404, "unknown room")
        return {"room_code": room.code, "created_at": room.created_at,
                "last_seen_at": room.last_seen_at}

    @app.get("/api/session/{session_id}")
    async def get_session(session_id: str):
        session = await store.get_session(session_id)
        if session is None:
            raise HTTPException(404, "unknown session")
        return {
            "surface": session.surface,
            "defcon": session.defcon,
            "link_profile": session.link_profile,
            "last_seen_at": session.last_seen_at,
            "room_code": session.room_code,
            "system": session.system_id,
        }

    @app.get("/api/games")
    async def games():
        return [
            {"id": g.id, "title": g.title, "status": g.status,
             "players": g.players, "summary": g.summary}
            for g in catalog.values()
        ]

    @app.get("/api/games/{game_id}/state/{session_id}")
    async def game_state(game_id: str, session_id: str):
        if game_id not in catalog:
            raise HTTPException(404, "unknown game")
        active = await store.get_active_game(session_id)
        if active is None or active.game_id != game_id:
            raise HTTPException(404, "no active game state")
        # Display block only — the STATE block never leaves the bridge/DB.
        resp = await runner.run(game_id, "QUERY", active.state, None)
        return {"game_id": game_id, "status": active.status,
                "turn": active.turn, "display": resp.display}

    @app.post("/api/session/{session_id}/defcon")
    async def set_defcon(session_id: str, body: DefconChange):
        session = await store.get_session(session_id)
        if session is None:
            raise HTTPException(404, "unknown session")
        clearance = await store.get_clearance_level(session.user_id)
        # level 1 is most privileged; you may only command AT OR ABOVE your floor
        if body.level < clearance:
            raise HTTPException(403, "clearance denied")
        await store.set_defcon(session_id, body.level)
        await store.log_event(session_id, "route", "system", {"defcon": body.level})
        return {"defcon": body.level}

    @app.get("/api/exchanges")
    async def list_exchanges():
        return {"exchanges": await store.list_exchanges()}

    @app.post("/api/exchanges/register", status_code=201)
    async def register_exchange(body: RegisterExchange):
        if not exchange_register_budget.available():
            raise HTTPException(429, "registration quota exhausted")
        ok = await store.register_exchange(
            id=body.id, name=body.name, region=body.region, api=body.api,
            link=body.link, joshua=body.joshua, operator=body.operator)
        if not ok:
            raise HTTPException(409, "exchange id already registered")
        exchange_register_budget.spend()
        await store.log_event(None, "route", "system",
                              {"event": "exchange-registered", "id": body.id})
        return {"id": body.id, "approved": False}

    # -- WebSocket (api-contract.md §3) ----------------------------------------

    @app.websocket("/ws/session/{session_id}")
    async def ws_session(ws: WebSocket, session_id: str, token: str = Query(default="")):
        # D3: only the comms layer may connect (header), with a valid session token.
        if settings.internal_token and ws.headers.get("x-wopr-internal-token") != settings.internal_token:
            await ws.close(code=4403)
            return
        session = await store.get_session(session_id)
        if session is None or not verify_session(settings.session_secret, session_id, token):
            await ws.close(code=4401)
            return

        await ws.accept()
        pending: dict[str, str] = {}
        # Disclosed by the relay ahead of anything else on this session, and
        # the only way this host can ever ring this visitor back. A local,
        # not a registry: nothing outside this coroutine reads it, and it
        # must not outlive the session that was given it (spec §3).
        seat_handle: str | None = None
        # A latch, not a counter: the machine decided once. Set where the
        # turn result is read, acted on at the hangup, and — being a local —
        # incapable of outliving the session that formed it.
        seeks: str | None = None
        seq = 0
        observer_task: asyncio.Task | None = None

        def envelope(kind: str, payload: str) -> str:
            nonlocal seq
            env = {"v": 1, "session": session_id, "seq": seq, "kind": kind,
                   "link": session.link_profile, "payload": payload, "eom": True}
            seq += 1
            return json.dumps(env)

        async def drop_line(cause: str, exc: BaseException, at: str) -> None:
            """A fault the visitor cannot act on: log it, leave an EVENTS row,
            close the socket cleanly.

            One policy for both paths that can hit it — a system-bound session
            whose binary is missing, and a terminal turn whose executive is
            (#99). The visitor sees a hang-up either way; a clean close means
            the comms layer announces NO CARRIER as it does for any other
            drop, rather than the socket dying with a 500 that no terminal
            can render. What must NOT be lost is the operator's view: the
            log line names the binary, and the EVENTS row makes the drop
            visible in session history, where before neither path left one.
            Loud-in-the-transport was the alternative, and was rejected: a
            deploy that ships source without a binary (real-wopr#206) would
            fire this on every turn of every session, and a 500 storm is
            harder to read than one row per line that says why.
            """
            payload = {"event": "line-dropped", "cause": cause, "at": at,
                       "detail": str(exc)}
            if session.system_id is not None:
                payload["system"] = session.system_id
            log.warning("%s %s failed, dropping line: %r",
                        session.system_id or "executive", at, exc)
            await store.log_event(session_id, "route", "system", payload)
            await ws.close()

        # The system speaks first (fidelity-notes.md §1): terminals get the
        # film's LOGON: prompt as soon as the line is up. A system-bound
        # session instead dials straight into that system's own greeting.
        if session.system_id is not None:
            try:
                resp = await run_session_turn(
                    system_runner, decode_stack(None, session.system_id),
                    "CONNECT", None,
                    runtime_dir=_session_store_dir(settings, session_id),
                    timeout_for=_timeout_for(programs),
                    execs_for=_execs_for(programs))
            except (SystemFault, SystemTimeout, SystemBusy) as exc:
                await drop_line(_fault_cause(exc), exc, "CONNECT")
                return
            await store.set_system_state(session_id, encode_stack(resp.frames))
            # Event-log parity with the router path: a system session must be
            # visible in event history, not a silent stream of DISPLAY frames.
            await store.log_event(session_id, "route", "system",
                                  {"system": session.system_id, "event": "CONNECT",
                                   "line": resp.line})
            if resp.display != "":  # DISPLAY 0: nothing to paint
                await ws.send_text(envelope("output", f"\n{resp.display}\n"))
            if resp.prompt:
                await ws.send_text(envelope("prompt", resp.prompt))
            if resp.line == "DROP":
                # Close, and say nothing about it. Carrier loss is announced by
                # the comms layer, which is the only thing that connects here
                # (D3) and which sends a control NO CARRIER when this socket
                # closes — out of band, after it has played out the display
                # above at line rate (#62) and ahead of teardown
                # (relay/src/server.ts, issue #88). Announcing here as well is
                # what printed NO CARRIER twice on a period system's sign-off
                # (#49): once as this frame's text, once as the comms signal.
                await ws.close()
                return
        elif (session.surface in ("home-terminal", "norad-terminal")
              and router.attachment(session_id).mode == FRONT_DOOR):
            # A comms resync reconnects the same session: re-greeting a line
            # that already opened the backdoor, or an operator console that
            # already cleared LOGON, would flash a bogus LOGON:. The
            # attachment is consulted in-memory, deliberately: it does not
            # survive a restart either, so after a redeploy an operator is
            # back at the front door and must be told to log on again.
            # Adding a store-backed operator check would greet by the store
            # and answer by memory, and every command would come back
            # --CONNECTION TERMINATED--.
            # A trunk host's per-exchange banner (BRIDGE_LOGON_BANNER) rides
            # above LOGON:; unset on the main exchange, so it stays bare.
            greeting = "\nLOGON:\n"
            if settings.logon_banner:
                greeting = f"\n{settings.logon_banner}\n{greeting}"
            await ws.send_text(envelope("output", greeting))
        elif session.surface == "trunk-caller":
            # The machine end of a call THIS host PLACED (relay/src/local-leg.ts
            # mints one per outgoing call). Nobody is going to type here: there
            # is no visitor on this end, and the far end is whoever answered the
            # ring. The one who dialled is the one who speaks first, and this
            # call is Joshua's — he rings David back, so what lands on the
            # answering seat is his greeting, not a front door.
            #
            # `open_backdoor` is the same door the word JOSHUA opens at a
            # terminal, taken as a whole: it returns the greeting AND leaves the
            # session attached to Joshua and authenticated, so the first line the
            # answering seat types is conversation rather than
            # --CONNECTION TERMINATED--. A bare send of BACKDOOR_GREETING would
            # greet and then reject.
            #
            # Deliberately not `trunk-call`: that surface is a call this host
            # ANSWERED, where the far end dialled in and must knock like anyone
            # else.
            await ws.send_text(
                envelope("output", f"\n{await router.open_backdoor(session_id)}\n"))

        try:
            while True:
                raw = await ws.receive_text()
                try:
                    frame = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                kind = frame.get("kind")
                payload = frame.get("payload", "")
                if kind not in ("input", "control"):
                    continue
                # Reassemble chunked messages (comms-protocol.md §5).
                pending[kind] = pending.get(kind, "") + payload
                if not frame.get("eom", True):
                    continue
                message, pending[kind] = pending[kind], ""

                if kind == "control":
                    if message == "HANGUP":
                        await ws.close()
                        return
                    if message == "BREAK":
                        await store.log_event(session_id, "input", "user", {"control": "BREAK"})
                        await ws.send_text(envelope("output", "\n*** BREAK ***\n"))
                    elif message.startswith("ORIGIN seat "):
                        seat_handle = message[len("ORIGIN seat "):].strip() or None
                    elif message.startswith("ORIGIN world "):
                        # Provenance only: a machine called, and this says which
                        # slot it called from. Not a seat — ringing it back would
                        # ring an exchange, not a person — so unlike the seat
                        # handle above there is nothing to hold it for. Logged,
                        # which is the whole of what provenance is good for here,
                        # rather than bound to a local nothing reads: a variable
                        # that only pretends to record something is worse than
                        # the comment explaining why it is not recorded.
                        await store.log_event(
                            session_id, "route", "system",
                            {"origin": message[len("ORIGIN "):].strip()})
                    continue

                # A system-bound session speaks only SYSTEM/1 with its own
                # binary — it never reaches the bridge's own command surface
                # (OBSERVE GTW) or the game/Joshua router below.
                if session.system_id is not None:
                    # Same input/route event pair the router writes per turn
                    # (router.handle) — system turns are part of the history.
                    await store.log_event(session_id, "input", "user", {"text": message})
                    try:
                        resp = await run_session_turn(
                            system_runner,
                            decode_stack(await store.get_system_state(session_id),
                                         session.system_id),
                            "INPUT", message,
                            runtime_dir=_session_store_dir(settings, session_id),
                            timeout_for=_timeout_for(programs),
                            execs_for=_execs_for(programs))
                    except (SystemFault, SystemTimeout, SystemBusy) as exc:
                        await drop_line(_fault_cause(exc), exc, "INPUT")
                        return
                    await store.set_system_state(session_id, encode_stack(resp.frames))
                    await store.log_event(session_id, "route", "system",
                                          {"input": message, "route": "system",
                                           "system": session.system_id,
                                           "line": resp.line})
                    if resp.display != "":  # DISPLAY 0: nothing to paint
                        await ws.send_text(envelope("output", f"\n{resp.display}\n"))
                    if resp.prompt:
                        await ws.send_text(envelope("prompt", resp.prompt))
                    if resp.line == "DROP":
                        await ws.close()  # comms announces the drop, not us (#49)
                        return
                    continue

                if message.strip().upper() == "OBSERVE GTW":
                    if session.link_profile not in ("internal-bus", "leased-9600"):
                        # A 1-2 KB JSON line every 2.5 s would swamp a 300-baud link.
                        await ws.send_text(envelope("output", "\nFEED NOT AVAILABLE ON THIS LINE\n"))
                        continue
                    if observer_task is None:
                        async def relay() -> None:
                            async for line in gtw_hub.subscribe(session.room_code):
                                await ws.send_text(envelope("output", line))
                        observer_task = asyncio.create_task(relay())
                        await store.log_event(session_id, "route", "system",
                                              {"input": message, "route": "bridge",
                                               "observer": "gtw"})
                    continue

                try:
                    result = await router.handle(session_id, message)
                except ExecutiveUnavailable as exc:
                    # Busy and slow were answered in character inside the
                    # router; this is the executive being absent or
                    # unparseable, which is a deployment fault (router.py).
                    await drop_line("executive-unavailable", exc, "INPUT")
                    return
                if result.seeks and seeks is None:
                    seeks = result.seeks
                await ws.send_text(envelope("output", f"\n{result.text}\n"))
                # The mode the user is now in, carried as its own frame so it
                # never lands inside the teletype text (the evals assert on
                # that text, and E03 asserts what it ends with).
                await ws.send_text(envelope("prompt", result.prompt))
        except WebSocketDisconnect:
            return
        finally:
            if observer_task is not None:
                observer_task.cancel()
            # The hangup IS the trigger to dial. Until this moment the
            # visitor held their own seat, and a held seat is refused `busy`
            # (relay/src/seats.ts:187) — so this is the first instant the
            # call can succeed, and the last instant the handle is still
            # worth anything.
            if seeks and seat_handle:
                try:
                    outcome = await place_seat_call(
                        settings.trunk_url, settings.internal_token, seat_handle)
                except Exception as exc:            # noqa: BLE001
                    # place_seat_call promises never to raise. Not depending
                    # on that promise: an exception escaping here does not
                    # fail a callback, it fails the disconnect.
                    log.warning("callback: placement raised: %r", exc)
                else:
                    log.info("callback: %s -> %s", seeks, outcome)

    return app
