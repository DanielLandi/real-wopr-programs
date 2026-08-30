"""The bridge's half of the executive: a CALL executor.

The routing decisions — the front door, the reserved words, what the terminal
is attached to, whose turn it is, what the prompt says, and W.O.P.R.'s own
voice — do not live here any more. They live in `wopr/main.f90`, the period
source at the top of the pack, and this module is what runs it: it gathers the
facts the executive cannot know for itself, spawns it, and executes whatever it
asks for.

A turn is a loop. The executive receives INPUT + STATE + FACTS and either
answers in DISPLAY (its own voice, which ends the turn) or emits a CALL and is
resumed with the REPLY. Four kinds of peer arrive here:

  a game id   a mount. NEW / MOVE / QUERY / QUIT against the core binary,
              under the room lock, with the store row written on the way back.
  joshua      the dialogue processor. One CHAT, and whatever it asks for
              afterwards is a request the executive is free to decline.
  roster      the NORAD roster. Is this callsign real, and is this its access
              code — the two questions whose answers must never ride in FACTS,
              because a clearance code in a frame every turn is a clearance
              code in every log.
  norad       the operator console: SITREP, TRACKS, EVENTS, SET DEFCON, and
              CEASE RANDOM FUNCTION. Phase 3 lifts this into a program of its
              own; until then it is a handler behind a CALL, which is exactly
              the seam that phase will cut along.

The room lock is taken lazily, on the first game CALL of a turn, and held to
the end of it. A move is two calls — the human's, then W.O.P.R.'s own — and
they have to be one atomic exchange against the room's row.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .attachment import Attachment, FRONT_DOOR, GAME, JOSHUA, NORAD_OPS
from .games import CATALOG_ORDER, UNLISTED, Game, interpretation_dir
from .gtwfeed import display_to_feed, tracks_text
from .joshua import Joshua
from .operators import Operator
from .rooms import RoomLocks, room_key
from .runner import CoreBusy, CoreError, CoreRunner, CoreTimeout
from .store import GameState, Store
from .systemrunner import (SystemBusy, SystemFault, SystemRunner,
                           SystemRunnerConfig, SystemTimeout)
from .systemwire import MAX_CALL_DEPTH, Reply

# ---------------------------------------------------------------------------
# W.O.P.R.'s voice, as the tests know it.
#
# The executive owns these texts now — they are string constants in
# `wopr/main.f90` and the pack's golden fixtures pin them byte-for-byte. The
# copies here are the vocabulary this repo's Python suites assert against, and
# `tests/test_executive.py` cross-checks that the Fortran still says exactly
# what they say, so a drift between the two is a test failure rather than a
# silent divergence.
#
# `UNRECOGNIZED_DIRECTIVE`, `CHANGES_LOCKED_OUT` and `CEASE_RANDOM_FUNCTION`
# are different: the operator console is still answered here, so those are
# live constants, not copies.
# ---------------------------------------------------------------------------
LOGON_REJECTION = ("INDENTIFICATION NOT RECOGNIZED BY SYSTEM"
                   "\n--CONNECTION TERMINATED--")
# sic: the film's own on-screen misspelling, reproduced deliberately
# (fidelity audit 2026-08-03, real-wopr#161).
BACKDOOR_GREETING = "GREETINGS PROFESSOR FALKEN."
HELP_NOT_AVAILABLE = "HELP NOT AVAILABLE"
HELP_GAMES_DEFINITION = ("'GAMES' REFERS TO MODELS, SIMULATIONS AND GAMES\n"
                         "WHICH HAVE TACTICAL AND STRATEGIC APPLICATIONS.")
CHESS_CODA = "HOW ABOUT A NICE GAME OF CHESS?"
NOWIN_RESULT = "A STRANGE GAME. THE ONLY WINNING MOVE IS NOT TO PLAY."
NOWIN_VERDICT = "A STRANGE GAME.\nTHE ONLY WINNING MOVE IS\nNOT TO PLAY."
NOT_IMPLEMENTED = "NOT YET IMPLEMENTED. SEE docs/contributing.md TO CLAIM IT."
CORE_TIMEOUT_TEXT = "WOPR CORE UNRESPONSIVE. REQUEST TERMINATED."
CORE_BUSY_TEXT = "ALL WOPR PROCESSORS COMMITTED. STAND BY."
ACCESS_CODE_PROMPT = "ACCESS CODE:"
IMPROPER_REQUEST = "       ** IMPROPER REQUEST **\n       ----------------------"
NO_GAME_IN_PROGRESS = "NO GAME IN PROGRESS."
JOSHUA_CAPPED = "SESSION RESOURCES EXHAUSTED. SHALL WE PLAY A GAME?"

UNRECOGNIZED_DIRECTIVE = "UNRECOGNIZED DIRECTIVE"
# The answer to CEASE RANDOM FUNCTION at the NORAD console: you cannot stop it.
CHANGES_LOCKED_OUT = "     >>> CHANGES LOCKED OUT <<<"
CEASE_RANDOM_FUNCTION = "CEASE RANDOM FUNCTION"

LOGON_LOCK_LIMIT = 3
_SET_DEFCON = re.compile(r"^SET DEFCON ([1-5])$")

#: The one line of the executive's STATE block the host reads:
#: ``MODE <mode> <program|-> <PENDING|-> <BACKDOOR|->``. Everything below it is
#: the program's own business. PACK.md states the same relationship for a
#: mount's CALL payload — for a mount the host is acting as the program's own
#: I/O — and the host needs exactly these four things: the mode, to know
#: whether a reconnecting terminal is still at the front door and must be
#: re-greeted; the attached program, to name it; the pending flag, to redact an
#: access code out of the event log *before* it is written; and the backdoor
#: flag, because the moment it flips is the moment the session is
#: authenticated and Joshua's history has to be seeded with the greeting he
#: just gave (or he repeats it on his first reply).
_MODE_BY_NAME = {"FRONT-DOOR": FRONT_DOOR, "JOSHUA": JOSHUA,
                 "GAME": GAME, "NORAD-OPS": NORAD_OPS}


@dataclass(frozen=True)
class _Header:
    """The host-visible first line of the executive's STATE block."""
    mode: str
    program: str
    pending: bool
    backdoor: bool


@dataclass
class RouteResult:
    text: str
    route: str  # core | bridge | joshua
    detail: dict[str, Any] = field(default_factory=dict)
    # What the user's prompt should be after this turn. A status bar only
    # exists on rich surfaces; a prompt works on a teletype too.
    prompt: str = ">"
    # What the machine is still trying to find out, if anything — carried up
    # from JoshuaReply.seeks so the hosting session can act on it later.
    seeks: str | None = None


class ExecutiveUnavailable(RuntimeError):
    """The executive is not there, or did not answer in the protocol.

    Raised rather than papered over: a bridge that quietly fell back to
    deciding routing in Python would be a second, undocumented executive with
    its own behaviour, and nobody would find out until the two disagreed. A
    missing or unparseable executive is a deployment fault and should read
    like one.

    Note what this is NOT: a saturated pool or a slow spawn. Those are
    ordinary and transient, they were answered in character before the
    executive existed, and they are answered in character below.
    """


class _ExecutiveBusy(Exception):
    """Transient: no slot, or no answer in time. Carries what to say."""

    def __init__(self, text: str, reason: str):
        super().__init__(reason)
        self.text = text
        self.reason = reason


class Router:
    # Words that always mean the monitor, in every mode but the front door.
    # The executive is what enforces this now; the set is kept here because
    # the suites assert against it — most usefully test_monitor's check that
    # no game in the pack declares an input syntax colliding with one.
    RESERVED = frozenset({"LIST GAMES", "HELP GAMES", "NEW", "QUIT", "STATUS",
                          "HELP", "LOGON"})

    def __init__(self, runner: CoreRunner, store: Store, engines: dict[str, Joshua],
                 catalog: dict[str, Game], joshua_session_cap: int = 50,
                 locks: "RoomLocks | None" = None,
                 operators: dict[str, Operator] | None = None,
                 default_engine: str = "",
                 executive_dir: Path | None = None):
        self.runner = runner
        self.store = store
        # Every dialogue processor this exchange can serve, by name. One Joshua,
        # several reconstructions of him — a session picks which one answers it
        # (?joshua=), and JOSHUA_ENGINE only decides what it gets if it doesn't.
        if not engines:
            raise ValueError("Router needs at least one Joshua engine")
        self.engines = engines
        self.default_engine = default_engine or next(iter(engines))
        if self.default_engine not in engines:
            raise ValueError(f"default engine {self.default_engine!r} is not in the registry")
        # session_id -> engine name. Scratch, like the executive's STATE and
        # _joshua_history: a restart already loses the conversation this would
        # belong to.
        self._engine_choice: dict[str, str] = {}
        self.catalog = catalog
        self.joshua_session_cap = joshua_session_cap
        self.locks = locks or RoomLocks()
        self._joshua_counts: dict[str, int] = {}
        self._joshua_history: dict[str, list[dict]] = {}
        self._authenticated: set[str] = set()
        self.operators = operators or {}
        # The executive's COMMAREA, per session, stored verbatim. The host is
        # the executive's monitor: it keeps the block and hands it back, and
        # reads only the header line (see _MODE_BY_NAME above).
        self._state: dict[str, str] = {}

        # The pack lays the executive out like every other program:
        # <pack>/wopr/harness/bin/wopr. Two places are worth looking, in this
        # order: beside the games the runner was pointed at (a real pack), and
        # beside this module (which ships inside the pack too, at
        # <pack>/emulator/node/app/). The second is what makes a test that
        # builds a synthetic games/ directory still find the real executive.
        self._exec = SystemRunner(
            SystemRunnerConfig(systems_dir=executive_dir or _find_executive_root(runner),
                               timeout_s=5.0))

    # -- what the host is allowed to know -------------------------------------

    def attachment(self, session_id: str) -> Attachment:
        """What this session is connected to. New sessions are at the front door.

        Read off the executive's STATE header, not decided here.
        """
        head = self._header(session_id)
        return Attachment(mode=head.mode, program=head.program)

    def _header(self, session_id: str) -> _Header:
        state = self._state.get(session_id)
        if not state:
            return _Header(FRONT_DOOR, "", False, False)
        parts = state.split("\n", 1)[0].split()
        if len(parts) < 5 or parts[0] != "MODE":
            return _Header(FRONT_DOOR, "", False, False)
        return _Header(mode=_MODE_BY_NAME.get(parts[1], FRONT_DOOR),
                       program="" if parts[2] == "-" else parts[2],
                       pending=parts[3] == "PENDING",
                       backdoor=parts[4] == "BACKDOOR")

    def select_engine(self, session_id: str, name: str) -> None:
        """Bind a session to one dialogue processor for its whole life.

        Raises KeyError for a processor this exchange cannot serve. The caller
        turns that into a 400 rather than quietly substituting another: someone
        comparing two reconstructions and silently handed the wrong one would
        draw a wrong conclusion from it.
        """
        if name not in self.engines:
            raise KeyError(name)
        self._engine_choice[session_id] = name

    def engine_name(self, session_id: str) -> str:
        return self._engine_choice.get(session_id, self.default_engine)

    def _engine_for(self, session_id: str) -> Joshua:
        return self.engines[self.engine_name(session_id)]

    def is_authenticated(self, session_id: str) -> bool:
        """True once the session has opened the JOSHUA backdoor.

        Nothing in production consults this any more: the greeting is decided
        by `attachment(session_id).mode == FRONT_DOOR` instead, because that is
        the question being asked. Left in place for a later phase that may
        still want a pure backdoor check."""
        return session_id in self._authenticated

    async def open_backdoor(self, session_id: str) -> str:
        """Put the session behind the front door, as Joshua, and give back the
        line he answers with.

        The door the word JOSHUA opens, taken as a whole — so it is opened the
        way anyone else opens it, by handing the executive that word and
        letting it decide. A caller that printed BACKDOOR_GREETING without
        going through here would greet as Joshua and then answer as a locked
        door, because the attachment is what routes the NEXT line.

        Two of the callers are the film's own backdoor word typed at a
        terminal. The third is a `trunk-caller` session — the machine end of a
        call THIS host placed. That end has no visitor to type anything: the
        machine dialled out, so the machine speaks first, and what it has to
        say is the same greeting it gives David. Returning the text rather
        than a RouteResult is what lets that caller send it as a connect-time
        frame, with no turn to attach it to.
        """
        result = await self._dispatch(session_id, "JOSHUA")
        return result.text

    # -- a turn ---------------------------------------------------------------

    async def handle(self, session_id: str, text: str) -> RouteResult:
        raw = text.strip()
        logged = "[REDACTED]" if self._header(session_id).pending else raw
        await self.store.log_event(session_id, "input", "user", {"text": logged})
        result = await self._dispatch(session_id, raw)
        await self.store.log_event(session_id, "route", "system",
                                   {"input": logged, "route": result.route, **result.detail})
        return result

    async def _dispatch(self, session_id: str, raw: str) -> RouteResult:
        turn = _Turn(self, session_id)
        return await turn.run(raw)

    # -- gathering the facts --------------------------------------------------

    async def _facts(self, session_id: str) -> str:
        """What the executive cannot know for itself, every turn.

        Not seeded once and cached in STATE: every one of these is durable,
        shared with other surfaces, and mutable behind the executive's back —
        DEFCON has an HTTP endpoint, the room hub advances a game on its own
        ticks. A cached copy would mean deciding from a stale one, which is the
        bug class the room locks exist to prevent.
        """
        session = await self.store.get_session(session_id)
        room = session.room_code if session else None
        lines = [
            f"SURFACE {session.surface if session else '-'}",
            f"ROOM {room or '-'}",
            f"DEFCON {session.defcon if session else 5}",
            f"CLEARANCE {await self.store.get_clearance_level(session.user_id if session else None)}",
        ]
        row = await self._active_game(session_id, room)
        if row is not None:
            lines.append(f"GAMEROW {row.game_id} {row.status} {row.turn} {row.interpretation}")
        # The catalog in recitation order, with the film's scroll marked out:
        # RECITED slots are read aloud, TRAILING is the one that comes after
        # the blank line, UNLISTED slots are startable but never recited. The
        # order and the exclusions stay in games.py, which is their one home.
        for game_id in CATALOG_ORDER:
            game = self.catalog[game_id]
            state = "IMPLEMENTED" if game.status == "implemented" else "PLACEHOLDER"
            if game_id == "gtw":
                flag = "TRAILING"
            elif game_id in UNLISTED:
                flag = "UNLISTED"
            else:
                flag = "RECITED"
            lines.append(f"GAME {game_id} {state} {flag} {game.title}")
            if game.abbrev:
                lines.append(f"ABBREV {game_id} {game.abbrev}")
            if game.input_syntax:
                lines.append(f"SYNTAX {game_id} {game.input_syntax}")
            if game.self_resolving:
                lines.append(f"SELFRES {game_id}")
            for interp in game.interpretations:
                lines.append(f"INTERP {game_id} {interp.name} {interp.author}")
        return "\n".join(lines)

    async def _session_room(self, session_id: str) -> str | None:
        session = await self.store.get_session(session_id)
        return session.room_code if session else None

    async def _active_game(self, session_id: str, room: str | None) -> GameState | None:
        if room is not None:
            return await self.store.get_latest_game(None, room)
        return await self.store.get_active_game(session_id)

    @staticmethod
    def _pinned_dir(game_meta: Game | None, row: GameState) -> str | None:
        """The runner subdirectory for this row's pinned interpretation.

        Raises KeyError when the pin names a reconstruction the catalog no
        longer has — refused loudly upstream, never run under the wrong binary
        (§8: STATE is not portable across interpretations).
        """
        if game_meta is None:
            return None
        return interpretation_dir(game_meta, row.interpretation)


class _Turn:
    """One user line, from the executive's first spawn to its last word.

    Holds the per-turn scratch the executor needs and the room lock once it has
    been taken, so a two-call move is one atomic exchange against the row.
    """

    def __init__(self, router: Router, session_id: str) -> None:
        self.r = router
        self.sid = session_id
        self.room: str | None = None
        self._lock_cm = None
        self.route = "bridge"
        self.detail: dict[str, Any] = {}
        self._detail_final = False
        self.seeks: str | None = None

    def _set_detail(self, detail: dict[str, Any], final: bool = False) -> None:
        """What this turn reports about itself.

        Locked once Joshua has asked for a game: the router this replaces
        returned only `{"start_game": ...}` for that turn and discarded
        whatever starting the game had to say about itself, so a later
        assignment here must not quietly start reporting it.
        """
        if self._detail_final:
            return
        self.detail = detail
        self._detail_final = final

    async def run(self, raw: str) -> RouteResult:
        self.room = await self.r._session_room(self.sid)
        facts = await self.r._facts(self.sid)
        was_backdoor = self.r._header(self.sid).backdoor

        try:
            return await self._loop(raw, facts, was_backdoor)
        except _ExecutiveBusy as exc:
            # The machine could not get to its own executive. Said in
            # character, the way a busy core has always been said, and the
            # COMMAREA is left exactly as it was — the next line the terminal
            # sends abandons the continuation this turn never finished.
            await self.r.store.log_event(self.sid, "error", "system",
                                         {"executive": exc.reason})
            return RouteResult(text=exc.text, route="bridge",
                               detail={"error": exc.reason},
                               prompt=self._prompt_from_state())
        finally:
            await self._unlock()

    def _prompt_from_state(self) -> str:
        """The prompt for a turn that never reached the executive.

        Derived from the header the last completed turn left behind, so a
        player whose move hit a busy pool keeps `[TTT]>` rather than being
        silently dropped back to a bare `>`.
        """
        head = self.r._header(self.sid)
        if head.mode == GAME:
            game = self.r.catalog.get(head.program)
            tag = (game.abbrev if game and game.abbrev else head.program)
            return f"[{tag.upper()}]>"
        if head.mode == NORAD_OPS:
            return "[NORAD]>"
        return ">"

    async def _loop(self, raw: str, facts: str, was_backdoor: bool) -> RouteResult:
        """Spawn, and keep spawning for as long as it asks for something."""
        reply: Reply | None = None
        for _ in range(MAX_CALL_DEPTH + 1):
            resp = await self._spawn(raw if reply is None else None, facts, reply)
            self.r._state[self.sid] = resp.state
            if resp.call is None:
                if self.r._header(self.sid).backdoor and not was_backdoor:
                    # The backdoor is the executive's decision; the host learns
                    # of it from the header, and has to, because the session
                    # becomes authenticated by it and Joshua's history needs
                    # the greeting he just gave — joshua.py reads
                    # `last_assistant` and would otherwise repeat it.
                    self.r._authenticated.add(self.sid)
                    self.r._joshua_history.setdefault(self.sid, []).append(
                        {"role": "assistant", "content": BACKDOOR_GREETING})
                    self._set_detail({"backdoor": True})
                return RouteResult(text=resp.display, route=self.route,
                                   detail=self.detail,
                                   prompt=resp.prompt or ">", seeks=self.seeks)
            reply = await self._execute(resp.call.peer, resp.call.payload)
        raise ExecutiveUnavailable(
            f"executive chained more than {MAX_CALL_DEPTH} calls in one turn")

    async def _spawn(self, user_input: str | None, facts: str,
                     reply: Reply | None):
        try:
            return await self.r._exec.run("wopr", "INPUT", self.r._state.get(self.sid),
                                          user_input, reply=reply, facts=facts)
        except SystemBusy as exc:
            raise _ExecutiveBusy(CORE_BUSY_TEXT, f"busy: {exc}") from exc
        except SystemTimeout as exc:
            raise _ExecutiveBusy(CORE_TIMEOUT_TEXT, f"timeout: {exc}") from exc
        except SystemFault as exc:
            raise ExecutiveUnavailable(f"executive did not answer: {exc}") from exc

    # -- the room lock --------------------------------------------------------

    async def _lock(self) -> None:
        """Serialize with the room's hub ticks, from the first game CALL of the
        turn to the end of it.

        Held across the whole turn rather than per call: a move is the human's
        call and then W.O.P.R.'s own, and a tick landing between them would
        move a row out from under the second one.
        """
        if self._lock_cm is not None:
            return
        self._lock_cm = self.r.locks.lock(room_key(self.room))
        await self._lock_cm.__aenter__()

    async def _unlock(self) -> None:
        if self._lock_cm is None:
            return
        cm, self._lock_cm = self._lock_cm, None
        await cm.__aexit__(None, None, None)

    # -- executing what the executive asked for -------------------------------

    async def _execute(self, peer: str, payload: str) -> Reply:
        lines = payload.split("\n")
        verb = lines[0].split(" ", 1)[0] if lines else ""
        arg = lines[0][len(verb):].strip() if lines else ""
        if peer == "joshua":
            return await self._joshua(arg)
        if peer == "roster":
            return await self._roster(verb, arg)
        if peer == "norad":
            return await self._norad(payload.strip())
        return await self._game(peer, verb, arg)

    # -- the games ------------------------------------------------------------

    async def _game(self, game_id: str, verb: str, arg: str) -> Reply:
        await self._lock()
        if verb == "NEW":
            return await self._game_new(game_id, arg)
        if verb == "QUIT":
            return await self._game_quit(game_id)
        row = await self.r._active_game(self.sid, self.room)
        if row is None or row.game_id != game_id:
            # The row vanished or changed under us (a hub tick, another
            # surface). The executive detaches rather than move a game it is
            # not on, and no core ran, so the turn stays the monitor's.
            return _ok(game_id, ["GONE"])
        if verb == "QUERY":
            return await self._game_query(row)
        return await self._game_move(row, arg or None)

    async def _game_new(self, game_id: str, pin: str) -> Reply:
        game = self.r.catalog.get(game_id)
        if game is None:                      # the executive checked; belt and braces
            return _fail(game_id, ["FAULT", f"unknown game {game_id}"])
        try:
            idir = interpretation_dir(game, pin)
        except KeyError:
            self.route = "core"
            return _fail(game_id, ["INTERP", pin])

        if self.room is not None:
            existing = await self.r.store.get_latest_game(game_id, self.room)
            if existing is not None:
                # The room's game was started under its own pin; attaching must
                # run THAT reconstruction — its STATE is not portable.
                try:
                    existing_dir = interpretation_dir(game, existing.interpretation)
                except KeyError:
                    self.route = "core"
                    return _fail(game_id, ["INTERP", existing.interpretation])
                resp = await self._core(game_id, "QUERY", existing.state, None,
                                        game.timeout_s, existing_dir)
                if isinstance(resp, Reply):
                    self.route = "core"
                    return resp
                self._set_detail({"game": game_id, "attached": True})
                return _ok(game_id, ["EXISTING", f"STATUS {resp.status}"]
                           + _display(resp.display))

        resp = await self._core(game_id, "NEW", None, None, game.timeout_s, idir)
        if isinstance(resp, Reply):
            self.route = "core"
            return resp
        await self.r.store.upsert_game(GameState(
            session_id=self.sid, game_id=game_id, state=resp.state, status=resp.status,
            turn=0, interpretation=pin))
        await self.r.store.log_event(self.sid, "core", "wopr",
                                     {"game": game_id, "event": "NEW"})
        self._set_detail({"game": game_id})
        return _ok(game_id, ["STARTED", f"STATUS {resp.status}"] + _display(resp.display))

    async def _game_move(self, row: GameState, move: str | None) -> Reply:
        self.route = "core"
        game = self.r.catalog.get(row.game_id)
        try:
            idir = self.r._pinned_dir(game, row)
        except KeyError:
            return _fail(row.game_id, ["INTERP", row.interpretation])
        resp = await self._core(row.game_id, "MOVE", row.state, move,
                                game.timeout_s if game else None, idir)
        if isinstance(resp, Reply):
            return resp
        await self.r.store.upsert_game(GameState(
            session_id=row.session_id, game_id=row.game_id, state=resp.state,
            status=resp.status, turn=row.turn + 1, interpretation=row.interpretation))
        await self.r.store.log_event(self.sid, "core", "wopr",
                                     {"game": row.game_id, "status": resp.status,
                                      "move": move})
        self._set_detail({"game": row.game_id, "status": resp.status})
        payload = ["MOVED", f"STATUS {resp.status}"]
        if resp.result:
            payload.append(f"RESULT {resp.result}")
        return _ok(row.game_id, payload + _display(resp.display))

    async def _game_query(self, row: GameState) -> Reply:
        """Re-read a game's display without moving it — what a bare Enter gets,
        since MOVE with no INPUT is an invalid move to the core, not a peek."""
        self.route = "core"
        game = self.r.catalog.get(row.game_id)
        try:
            idir = self.r._pinned_dir(game, row)
        except KeyError:
            return _fail(row.game_id, ["INTERP", row.interpretation])
        resp = await self._core(row.game_id, "QUERY", row.state, None,
                                game.timeout_s if game else None, idir)
        if isinstance(resp, Reply):
            return resp
        self._set_detail({"game": row.game_id, "status": row.status})
        return _ok(row.game_id, ["QUERIED", f"STATUS {row.status}"]
                   + _display(resp.display))

    async def _game_quit(self, game_id: str) -> Reply:
        """End the room's game. Re-read inside the lock so we quit the freshest
        state, not the snapshot FACTS was built from — otherwise a concurrent
        tick's upsert could be clobbered by a stale copy, or a game that already
        ended could be resurrected back to PLAYING-then-QUIT."""
        fresh = await self.r._active_game(self.sid, self.room)
        if fresh is None:
            return _ok(game_id, ["NONE"])
        fresh.status = "QUIT"
        await self.r.store.upsert_game(fresh)
        self._set_detail({"game": fresh.game_id, "status": "QUIT"})
        return _ok(game_id, ["DONE", fresh.game_id])

    async def _core(self, game_id: str, command: str, state: str | None,
                    move: str | None, timeout_s: float | None,
                    idir: str | None):
        """Run one core turn, or return the REPLY that says why it could not.

        A subsystem being down was an ordinary Tuesday in 1983, so every
        failure comes back as a well-formed answer the executive knows how to
        speak about, never as an exception through the turn.
        """
        try:
            return await self.r.runner.run(game_id, command, state, move,
                                           timeout_s=timeout_s, interp_dir=idir)
        except CoreTimeout:
            await self.r.store.log_event(self.sid, "error", "system",
                                         {"game": game_id, "error": "timeout"})
            self._set_detail({"error": "timeout"})
            return _timeout(game_id)
        except CoreBusy:
            self._set_detail({"error": "busy"})
            return _fail(game_id, ["BUSY"])
        except CoreError as exc:
            # Logged before the answer is decided, and with what the game
            # actually said: the user-facing line changes below, the diagnostic
            # must not.
            await self.r.store.log_event(self.sid, "error", "wopr",
                                         {"game": game_id, "error": str(exc)})
            # Two very different things arrive as CoreError. A game that parsed
            # the frame and *declared* STATUS ERROR has rejected the line — a
            # judgement, and the film's answer to it is IMPROPER REQUEST.
            # Anything else (no frame at all, or a binary that died) is a
            # genuine fault; dressing that up in film flavour would hide it.
            if exc.response is not None and exc.response.status == "ERROR":
                self._set_detail({"error": str(exc), "refused": True})
                return _fail(game_id, ["REFUSED", exc.response.result or ""])
            self._set_detail({"error": str(exc)})
            return _fail(game_id, ["FAULT", str(exc)])

    # -- the dialogue processor ----------------------------------------------

    async def _joshua(self, text: str) -> Reply:
        self.route = "joshua"
        count = self.r._joshua_counts.get(self.sid, 0)
        if count >= self.r.joshua_session_cap:
            # The session budget is the host's to keep, not the executive's:
            # it is a cost ceiling on an outside service, it is configured
            # here, and the executive would have to be told the number every
            # turn to enforce it. So the CALL is refused in kind — an answer
            # the executive prints like any other.
            self._set_detail({"capped": True}, final=True)
            return _ok("joshua", ["START -", "SEEKS -"] + _display(JOSHUA_CAPPED))
        self.r._joshua_counts[self.sid] = count + 1
        history = self.r._joshua_history.setdefault(self.sid, [])
        reply = await self.r._engine_for(self.sid).chat(self.sid, history, text)
        history.append({"role": "user", "content": text})
        history.append({"role": "assistant", "content": reply.text})
        del history[:-20]  # bound the context (and the token bill, D5)

        await self.r.store.log_event(self.sid, "joshua", "joshua",
                                     {"input": text, "reply": reply.text,
                                      "start_game": reply.start_game_id,
                                      "seeks": reply.seeks})
        self.seeks = reply.seeks
        if reply.start_game_id:
            self._set_detail({"start_game": reply.start_game_id}, final=True)
        # Joshua ASKS for the attach; the executive decides whether to honour
        # it. What comes back here is a request, not an instruction.
        return _ok("joshua", [f"START {reply.start_game_id or '-'}",
                              f"SEEKS {reply.seeks or '-'}"] + _display(reply.text))

    # -- the roster -----------------------------------------------------------

    async def _roster(self, verb: str, arg: str) -> Reply:
        """Is this callsign real, and is this its access code.

        The two questions that cannot be answered from FACTS: a roster in
        every frame is a roster in every log, and an access code even more so.
        So the executive asks, and only ever learns yes or no.
        """
        if verb == "HAS":
            known = arg in self.r.operators
            self._set_detail({"logon": "pending"} if known else {})
            return _ok("roster", ["YES" if known else "NO"])
        callsign, _, code = arg.partition(" ")
        op = self.r.operators.get(callsign)
        if op is None or code.strip() != op.code:
            self._set_detail({"logon": "failed"})
            return _ok("roster", ["REJECT"])
        await self.r.store.set_operator(self.sid, callsign, op.level)
        self._set_detail({"logon": "accepted", "callsign": callsign})
        return _ok("roster", ["ACCEPT", str(op.level)])

    # -- the operator console -------------------------------------------------

    async def _norad(self, line: str) -> Reply:
        """The NORAD operator console. Joshua is not present here.

        Phase 3 lifts this into a program of its own; it is a handler behind a
        CALL until then, which is exactly where that cut will be made.
        """
        text, detail = await self._norad_text(line)
        self._set_detail(detail)
        return _ok("norad", _display(text))

    async def _norad_text(self, upper: str) -> tuple[str, dict[str, Any]]:
        session = await self.r.store.get_session(self.sid)
        active = await self.r._active_game(self.sid, self.room)
        if upper == "SITREP":
            level = await self.r.store.get_clearance_level(
                session.user_id if session else None)
            defcon = session.defcon if session else 5
            sim = (f"SIMULATION: {active.game_id.upper()} TURN {active.turn}"
                   if active else "SIMULATION: IDLE")
            room = session.room_code if session and session.room_code else "NONE"
            link = session.link_profile.upper() if session else "UNKNOWN"
            callsign = session.user_id if session else "UNKNOWN"
            return (f"SITREP {callsign} LEVEL {level}\nDEFCON {defcon}\n{sim}\n"
                    f"CONFERENCE: {room}\nLINK: {link}"), {}
        if upper == "TRACKS":
            return await self._tracks(active)
        if upper == "EVENTS":
            return await self._events()
        if upper == CEASE_RANDOM_FUNCTION and active is not None:
            # The film's whole argument, at the console. `active` is the room's
            # latest *playing* game, the same view TRACKS and SITREP get, so any
            # live simulation locks changes out — the film had tic-tac-toe on
            # screen while the launch routine ran, so what is displayed is
            # beside the point. With nothing running there is nothing to cease,
            # and the line falls through to UNRECOGNIZED DIRECTIVE below.
            return CHANGES_LOCKED_OUT, {"cease": "locked"}
        m = _SET_DEFCON.match(upper)
        if m:
            return await self._set_defcon(session, int(m.group(1)))
        # NORAD staff not knowing the backdoor is the plot: without it they get
        # the terse machine, never Joshua.
        return UNRECOGNIZED_DIRECTIVE, {}

    async def _tracks(self, active: GameState | None) -> tuple[str, dict[str, Any]]:
        if active is None or active.game_id != "gtw":
            return "NO ACTIVE TRACKS", {}
        game = self.r.catalog.get("gtw")
        await self._lock()
        resp = await self._core("gtw", "QUERY", active.state, None,
                                game.timeout_s if game else None, None)
        if isinstance(resp, Reply):
            # The console gets the same in-character lines a player would.
            return _reply_error_text(resp), self.detail
        feed = display_to_feed(resp.display, active.status)
        return tracks_text(feed), {"game": "gtw"}

    async def _events(self) -> tuple[str, dict[str, Any]]:
        rows = await self.r.store.get_recent_events(self.sid, limit=10)
        if not rows:
            return "NO EVENTS LOGGED", {}
        lines = []
        for r in rows:
            payload = r.get("payload", {})
            summary = ""
            # A precedence order, so "origin" goes at the END rather than in
            # some tidier-looking spot: the machine-call provenance payload has
            # no other key today, and appending guarantees that a future
            # payload carrying both `origin` and, say, `route` still summarises
            # by `route` — no existing row's rendering changes as a side effect
            # of teaching EVENTS one more word (#78).
            for key in ("text", "route", "defcon", "game", "system", "origin"):
                if key in payload:
                    summary = f"{key} {payload[key]}"
                    break
            lines.append(f"{r['kind'].upper():<8}{r['actor'].upper():<8}{summary.upper()[:44]}")
        return "\n".join(lines), {}

    async def _set_defcon(self, session, level: int) -> tuple[str, dict[str, Any]]:
        clearance = await self.r.store.get_clearance_level(
            session.user_id if session else None)
        # Same rule as POST /api/session/{id}/defcon: 1 is most privileged, you
        # may only command at or above your numeric floor.
        if level < clearance:
            return "CLEARANCE DENIED", {"defcon": level, "denied": True}
        await self.r.store.set_defcon(self.sid, level)
        return f"DEFCON {level} SET", {"defcon": level}


# ---------------------------------------------------------------------------
# REPLY construction. The payload's shape is the two programs' business, not
# the wire's — SYSTEM/1 counts the lines and carries them.
# ---------------------------------------------------------------------------

def _find_executive_root(runner: CoreRunner) -> Path:
    """Where `wopr/harness/bin/wopr` lives, when nobody said.

    Production says: `Settings.executive_dir` (`BRIDGE_EXECUTIVE_DIR`) is
    passed in from `main.py`. This is for everyone else — a test that builds a
    synthetic `games/` directory should still find the real executive rather
    than have to know where it is.
    """
    bin_dir = getattr(getattr(runner, "cfg", None), "bin_dir", None)
    candidates = []
    if bin_dir is not None:
        candidates.append(Path(bin_dir).parent)
    candidates.append(Path(__file__).resolve().parents[3])
    for root in candidates:
        if (root / "wopr" / "harness" / "bin" / "wopr").exists():
            return root
    return candidates[0]


def _display(text: str) -> list[str]:
    lines = text.split("\n") if text else []
    return [f"DISPLAY {len(lines)}"] + lines


def _ok(peer: str, payload: list[str]) -> Reply:
    return Reply(peer=peer, status="OK", payload="\n".join(payload))


def _fail(peer: str, payload: list[str]) -> Reply:
    return Reply(peer=peer, status="FAIL", payload="\n".join(payload))


def _timeout(peer: str) -> Reply:
    return Reply(peer=peer, status="TIMEOUT", payload="")


def _reply_error_text(reply: Reply) -> str:
    """What a failed core call would look like on the teletype.

    Only the console needs this: the executive speaks for itself everywhere
    else, and the console is still answered here until phase 3 moves it.
    """
    lines = reply.payload.split("\n") if reply.payload else []
    kind = lines[0] if lines else ""
    if reply.status == "TIMEOUT":
        return CORE_TIMEOUT_TEXT
    if kind == "BUSY":
        return CORE_BUSY_TEXT
    if kind == "REFUSED":
        reason = lines[1] if len(lines) > 1 else ""
        return f"{IMPROPER_REQUEST}\n\n{reason}" if reason else IMPROPER_REQUEST
    if kind == "INTERP":
        return f"UNKNOWN INTERPRETATION: {(lines[1] if len(lines) > 1 else '').upper()}"
    return f"ERROR: {lines[1] if len(lines) > 1 else kind}"
