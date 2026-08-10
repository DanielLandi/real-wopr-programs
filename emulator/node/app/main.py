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
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .attachment import FRONT_DOOR
from .budget import DailyBudget, MeteredJoshua
from .config import load_settings
from .execstack import decode as decode_stack, encode as encode_stack
from .games import load_catalog
from .gtwhub import GtwRoomHub
from .joshua import ClaudeJoshua, Joshua, LispJoshua, ScriptedJoshua
from .operators import parse_roster
from .rooms import RoomLocks
from .router import Router
from .runner import CoreRunner, RunnerConfig
from .session_turn import run_session_turn
from .store import make_store, normalize_room_code
from .systemrunner import SystemBusy, SystemFault, SystemRunner, SystemRunnerConfig, SystemTimeout
from .systems import load_programs, load_systems, validate_execs
from .tokens import sign_session, verify_session

log = logging.getLogger("wopr.bridge")

DEFAULT_LINKS = {
    "home-terminal": "dialup-300",
    "norad-terminal": "leased-9600",
    "norad-bigboard": "internal-bus",
    "wopr-panel": "internal-bus",
}


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


def create_app(settings=None, store=None, engines=None, runner=None) -> FastAPI:
    """App factory; tests inject fakes for store/engines/runner."""
    settings = settings or load_settings()
    store = store or make_store(settings.database_url)
    catalog = load_catalog(settings.games_dir)
    runner = runner or CoreRunner(RunnerConfig(
        bin_dir=settings.games_dir,
        timeout_s=settings.core_timeout_s,
        pool_size=settings.core_pool_size,
        queue_size=settings.core_queue_size,
    ))
    budget = DailyBudget(settings.joshua_claude_daily_calls)
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
                    default_engine=default_engine)
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
    async def create_session(body: CreateSession):
        if body.surface not in DEFAULT_LINKS:
            raise HTTPException(400, "unknown surface")
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
        seq = 0
        observer_task: asyncio.Task | None = None

        def envelope(kind: str, payload: str) -> str:
            nonlocal seq
            env = {"v": 1, "session": session_id, "seq": seq, "kind": kind,
                   "link": session.link_profile, "payload": payload, "eom": True}
            seq += 1
            return json.dumps(env)

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
                log.warning("system %s CONNECT failed, dropping line: %r",
                            session.system_id, exc)
                await ws.close()
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
                # (D3) and which already sends a control NO CARRIER the instant
                # this socket closes — out of band, ahead of teardown
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
                        log.warning("system %s INPUT failed, dropping line: %r",
                                    session.system_id, exc)
                        await ws.close()
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

                result = await router.handle(session_id, message)
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

    return app


app = create_app()
