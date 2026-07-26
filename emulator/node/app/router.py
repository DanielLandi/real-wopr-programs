"""The bridge's brain — a connection monitor, not a per-line classifier
(attachment.py). A session is attached to exactly one program, and a line
either is a reserved word (which outranks any attachment) or belongs entirely
to whatever the session is attached to: the game, Joshua, or NORAD ops."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from .attachment import Attachment, FRONT_DOOR, GAME, JOSHUA, NORAD_OPS, prompt_for
from .games import Game, list_games_text
from .gtwfeed import display_to_feed, tracks_text
from .joshua import Joshua
from .operators import Operator
from .rooms import RoomLocks, room_key
from .runner import CoreBusy, CoreError, CoreRunner, CoreTimeout
from .scenarios import montage_text
from .store import GameState, Store
from .wire import TERMINAL_STATUSES

LOGON_REJECTION = "IDENTIFICATION NOT RECOGNIZED BY SYSTEM\n--CONNECTION TERMINATED--"
BACKDOOR_GREETING = "GREETINGS PROFESSOR FALKEN."
HELP_NOT_AVAILABLE = "HELP NOT AVAILABLE"
CHESS_CODA = "HOW ABOUT A NICE GAME OF CHESS?"
NOT_IMPLEMENTED = "NOT YET IMPLEMENTED. SEE docs/contributing.md TO CLAIM IT."
CORE_TIMEOUT_TEXT = "WOPR CORE UNRESPONSIVE. REQUEST TERMINATED."
CORE_BUSY_TEXT = "ALL WOPR PROCESSORS COMMITTED. STAND BY."
ACCESS_CODE_PROMPT = "ACCESS CODE:"
UNRECOGNIZED_DIRECTIVE = "UNRECOGNIZED DIRECTIVE"
LOGON_LOCK_LIMIT = 3
_SET_DEFCON = re.compile(r"^SET DEFCON ([1-5])$")

@dataclass
class RouteResult:
    text: str
    route: str  # core | bridge | joshua
    detail: dict[str, Any] = field(default_factory=dict)
    # What the user's prompt should be after this turn. A status bar only
    # exists on rich surfaces; a prompt works on a teletype too.
    prompt: str = ">"


class Router:
    # Words that always mean the monitor, in every mode. Seven literals, six
    # distinct commands — HELP GAMES is an alias for LIST GAMES, not a seventh
    # one. The objection this design answers is that *Joshua's* vocabulary
    # should not pull you out of a game, and six commands do not. LIST GAMES
    # and NEW are required by the evals — E03 asserts the catalog in exact
    # order on both Joshua engines, so Joshua cannot own that answer. NEW and
    # LOGON are listed bare because that is the command being reserved, but
    # both take an argument (NEW TICTACTOE, LOGON CRYSTAL); _logon_line and
    # _reserved match the prefix, never the bare word alone — except a bare
    # LOGON, which is a rejection rather than a fall-through.
    RESERVED = frozenset({"LIST GAMES", "HELP GAMES", "NEW", "QUIT", "STATUS",
                          "HELP", "LOGON"})

    def __init__(self, runner: CoreRunner, store: Store, joshua: Joshua,
                 catalog: dict[str, Game], joshua_session_cap: int = 50,
                 locks: "RoomLocks | None" = None,
                 operators: dict[str, Operator] | None = None):
        self.runner = runner
        self.store = store
        self.joshua = joshua
        self.catalog = catalog
        self.joshua_session_cap = joshua_session_cap
        self.locks = locks or RoomLocks()
        self._joshua_counts: dict[str, int] = {}
        self._joshua_history: dict[str, list[dict]] = {}
        self._authenticated: set[str] = set()
        self.operators = operators or {}
        self._pending_logon: dict[str, str] = {}   # session_id -> callsign
        self._logon_failures: dict[str, int] = {}
        # What each session is connected to. In phase 2 this moves into the
        # executive's own STATE block; it lives here for now, alongside the
        # other per-session scratch.
        self._attach: dict[str, Attachment] = {}

    def attachment(self, session_id: str) -> Attachment:
        """What this session is connected to. New sessions are at the front door."""
        return self._attach.setdefault(session_id, Attachment(mode=FRONT_DOOR))

    def _attach_game(self, session_id: str, game_id: str) -> None:
        """Connect the terminal to a game. Everything typed now goes to it."""
        current = self.attachment(session_id)
        parent = current.parent if current.mode == GAME else current.mode
        self._attach[session_id] = Attachment(mode=GAME, program=game_id,
                                              parent=parent)

    def _detach(self, session_id: str) -> None:
        """Return to whatever attached the program — Joshua, or NORAD ops.

        `parent` is carried through, not dropped: WOPR answers a losing move
        inside the same turn, so this runs twice, and a second detach that
        re-derived the parent from a default would strand a NORAD operator in
        Joshua — the one place the film says they must never end up.

        E11 closed the game-attach route into a non-default parent — an
        operator console never attaches to a game — but it did not make the
        carry idle. `_logon_code` gives an operator `parent=NORAD_OPS`, and
        `QUIT` is reserved in every mode, so an operator ending the room's
        simulation reaches here with no game attachment of their own. Defaulting
        the parent there drops them into Joshua with every instrument gone.
        """
        att = self.attachment(session_id)
        self._attach[session_id] = Attachment(mode=att.parent, parent=att.parent)

    def is_authenticated(self, session_id: str) -> bool:
        """True once the session has opened the JOSHUA backdoor. The WS layer
        uses this to greet only unauthenticated lines with LOGON: — a comms
        resync reconnects the same session and must not be re-greeted."""
        return session_id in self._authenticated

    async def _logon(self, session_id: str, upper: str) -> RouteResult:
        session = await self.store.get_session(session_id)
        callsign = upper[6:].strip() if upper.startswith("LOGON ") else ""
        if (session is None or session.surface != "norad-terminal"
                or callsign not in self.operators
                or self._logon_failures.get(session_id, 0) >= LOGON_LOCK_LIMIT):
            # One rejection for every failure mode — no roster leakage, and
            # the home terminal stays byte-identical to today.
            return RouteResult(text=LOGON_REJECTION, route="bridge")
        self._pending_logon[session_id] = callsign
        return RouteResult(text=ACCESS_CODE_PROMPT, route="bridge",
                           detail={"logon": "pending"})

    async def _logon_line(self, session_id: str, raw: str,
                          upper: str) -> RouteResult | None:
        """The roster logon, from wherever the session happens to be.

        A logon changes what the terminal is attached to, which is precisely
        what makes a word reserved. api-contract.md §4.6 documents the exchange
        unconditionally and offers the backdoor as the way for an operator to
        play — so an operator who takes it has to be able to log back on, and a
        NORAD user who tried JOSHUA first has to be able to reach the console at
        all. Returns None when the line is no part of a logon.
        """
        if session_id in self._pending_logon:
            # The access code is arbitrary text: catch it before the attached
            # program does, or a game eats the operator's clearance code.
            return await self._logon_code(session_id, raw)
        if upper == "LOGON" or (upper.startswith("LOGON ") and upper != "LOGON JOSHUA"):
            # LOGON JOSHUA is the backdoor, which each mode answers itself.
            return await self._logon(session_id, upper)
        return None

    async def _logon_code(self, session_id: str, raw: str) -> RouteResult:
        callsign = self._pending_logon.pop(session_id)
        op = self.operators[callsign]
        if raw.strip().upper() != op.code:
            self._logon_failures[session_id] = self._logon_failures.get(session_id, 0) + 1
            return RouteResult(text=LOGON_REJECTION, route="bridge",
                               detail={"logon": "failed"})
        await self.store.set_operator(session_id, callsign, op.level)
        session = await self.store.get_session(session_id)
        defcon = session.defcon if session else 5
        # Clearance replaces whatever the terminal was on, rather than layering
        # over it: this console now *is* the operator's, and an operator who
        # detaches must land on the console, never in Joshua. A game the session
        # was attached to keeps running in the store — the console can still
        # watch it (TRACKS) and end it (QUIT), which is all E11 lets it do.
        self._attach[session_id] = Attachment(mode=NORAD_OPS, parent=NORAD_OPS)
        return RouteResult(
            text=f"CLEARANCE ACCEPTED - {callsign} LEVEL {op.level}\nDEFCON {defcon}. READY.",
            route="bridge", detail={"logon": "accepted", "callsign": callsign})

    async def _session_room(self, session_id: str) -> str | None:
        session = await self.store.get_session(session_id)
        return session.room_code if session else None

    async def _active_game(self, session_id: str, room: str | None) -> GameState | None:
        if room is not None:
            return await self.store.get_latest_game(None, room)
        return await self.store.get_active_game(session_id)

    async def handle(self, session_id: str, text: str) -> RouteResult:
        raw = text.strip()
        logged = "[REDACTED]" if session_id in self._pending_logon else raw
        await self.store.log_event(session_id, "input", "user", {"text": logged})
        result = await self._dispatch(session_id, raw)
        # Computed after dispatch, not before: dispatch is what changes the
        # attachment, so reading it earlier would report the mode the user
        # was leaving, not the one the reply just landed them in.
        att = self.attachment(session_id)
        game = self.catalog.get(att.program) if att.program else None
        result.prompt = prompt_for(att, abbrev=game.abbrev if game else "")
        await self.store.log_event(session_id, "route", "system",
                                   {"input": logged, "route": result.route, **result.detail})
        return result

    async def _front_door(self, session_id: str, raw: str, upper: str) -> RouteResult:
        """Nothing reaches a program until the door opens.

        The film's front door: only the JOSHUA backdoor, or a roster logon on a
        NORAD terminal, gets past it. Reserved words do not work here — E01
        requires LIST GAMES to be refused without leaking the catalog.
        """
        if upper in ("JOSHUA", "LOGON JOSHUA"):
            self._attach[session_id] = Attachment(mode=JOSHUA)
            self._authenticated.add(session_id)
            # The backdoor abandons any in-flight operator logon prompt with no
            # failure increment — otherwise the next command is swallowed as a
            # wrong access-code attempt against a stale state.
            self._pending_logon.pop(session_id, None)
            self._joshua_history.setdefault(session_id, []).append(
                {"role": "assistant", "content": BACKDOOR_GREETING})
            return RouteResult(text=BACKDOOR_GREETING, route="bridge",
                               detail={"backdoor": True})
        logon = await self._logon_line(session_id, raw, upper)
        if logon is not None:
            return logon
        # HELP GAMES is a catalog request, not a plea for help. At the front
        # door it gets the rejection like LIST GAMES does — never the softer
        # HELP NOT AVAILABLE, and never the catalog.
        if upper == "HELP" or (upper.startswith("HELP ") and upper != "HELP GAMES"):
            return RouteResult(text=HELP_NOT_AVAILABLE, route="bridge")
        return RouteResult(text=LOGON_REJECTION, route="bridge",
                           detail={"authenticated": False})

    async def _reserved(self, session_id: str, raw: str, upper: str,
                        att: Attachment) -> RouteResult | None:
        """Monitor commands, which outrank whatever the session is attached to.

        Returns None when the line is not one — the caller then hands it to the
        attached program untouched.
        """
        logon = await self._logon_line(session_id, raw, upper)
        if logon is not None:
            return logon
        if upper in ("LIST GAMES", "HELP GAMES"):
            return RouteResult(text=list_games_text(self.catalog), route="bridge")
        if upper == "HELP" or upper.startswith("HELP "):
            return RouteResult(text=HELP_NOT_AVAILABLE, route="bridge")
        if upper.startswith("NEW "):
            # The operator console is observational (spec E11): it displays a
            # simulation, it does not attach to one. Falling through to
            # _norad_ops gives the console's own refusal rather than a special
            # case here.
            if att.mode == NORAD_OPS:
                return None
            room = await self._session_room(session_id)
            return await self._new_game(session_id, upper[4:].strip().lower(), room)
        if upper == "QUIT":
            room = await self._session_room(session_id)
            active = await self._active_game(session_id, room)
            return await self._quit(session_id, active, room)
        if upper == "STATUS":
            room = await self._session_room(session_id)
            active = await self._active_game(session_id, room)
            return await self._status(session_id, active)
        return None

    async def _dispatch(self, session_id: str, raw: str) -> RouteResult:
        upper = raw.upper()
        att = self.attachment(session_id)

        if att.mode == FRONT_DOOR:
            return await self._front_door(session_id, raw, upper)

        reserved = await self._reserved(session_id, raw, upper, att)
        if reserved is not None:
            return reserved

        # Attached to a game: everything typed is the game's, including lines
        # Joshua would recognise. Routing is by attachment, not by inspecting
        # the line, which is why no game declares a move pattern any more.
        if att.mode == GAME:
            room = await self._session_room(session_id)
            async with self.locks.lock(room_key(room)):
                fresh = await self._active_game(session_id, room)
                if fresh is None or fresh.game_id != att.program:
                    # The row vanished or changed under us (a hub tick, another
                    # surface). Detach rather than move a game we are not on.
                    self._detach(session_id)
                    return RouteResult(text="NO GAME IN PROGRESS.", route="bridge")
                if not upper:
                    # A bare Enter is not a move. MOVE with an empty INPUT
                    # fails as an invalid move and prints a bare ERROR: dump
                    # (#44); QUERY reads the board back without risking that.
                    return await self._query_game(session_id, fresh)
                return await self._core_move(session_id, fresh, upper)

        if att.mode == NORAD_OPS:
            return await self._norad_ops(session_id, upper)

        return await self._converse(session_id, raw, await self._session_room(session_id))

    async def _norad_ops(self, session_id: str, upper: str) -> RouteResult:
        """The NORAD operator console. Joshua is not present here.

        Phase 3 lifts this out into a program of its own; it is a mode with a
        handler inside the router until then.
        """
        if upper in ("JOSHUA", "LOGON JOSHUA"):
            self._attach[session_id] = Attachment(mode=JOSHUA)
            self._authenticated.add(session_id)
            self._joshua_history.setdefault(session_id, []).append(
                {"role": "assistant", "content": BACKDOOR_GREETING})
            return RouteResult(text=BACKDOOR_GREETING, route="bridge",
                               detail={"backdoor": True})

        room = await self._session_room(session_id)
        active = await self._active_game(session_id, room)
        if upper == "SITREP":
            return await self._sitrep(session_id, active)
        if upper == "TRACKS":
            return await self._tracks(session_id, room)
        if upper == "EVENTS":
            return await self._events(session_id)
        m = _SET_DEFCON.match(upper)
        if m:
            return await self._set_defcon(session_id, int(m.group(1)))

        # NORAD staff not knowing the backdoor is the plot: without it they get
        # the terse machine, never Joshua.
        return RouteResult(text=UNRECOGNIZED_DIRECTIVE, route="bridge")

    # -- destinations ---------------------------------------------------------

    async def _core_move(self, session_id: str, game: GameState, move: str | None) -> RouteResult:
        game_meta = self.catalog.get(game.game_id)
        timeout = game_meta.timeout_s if game_meta else None
        try:
            resp = await self.runner.run(game.game_id, "MOVE", game.state, move, timeout_s=timeout)
        except CoreTimeout:
            await self.store.log_event(session_id, "error", "system",
                                       {"game": game.game_id, "error": "timeout"})
            return RouteResult(text=CORE_TIMEOUT_TEXT, route="core", detail={"error": "timeout"})
        except CoreBusy:
            return RouteResult(text=CORE_BUSY_TEXT, route="core", detail={"error": "busy"})
        except CoreError as exc:
            await self.store.log_event(session_id, "error", "wopr",
                                       {"game": game.game_id, "error": str(exc)})
            return RouteResult(text=f"ERROR: {exc}", route="core", detail={"error": str(exc)})

        await self.store.upsert_game(GameState(
            session_id=game.session_id, game_id=game.game_id, state=resp.state,
            status=resp.status, turn=game.turn + 1,
        ))
        await self.store.log_event(session_id, "core", "wopr",
                                   {"game": game.game_id, "status": resp.status, "move": move})

        texts = [resp.display]
        status = resp.status

        # WOPR plays its own side: after a human move that leaves the game
        # PLAYING, invoke the engine (MOVE with INPUT omitted — T1 convention).
        # Self-resolving games (hearts/gin-rummy/poker) already answer every
        # non-human seat inside the human's MOVE and die on an inputless MOVE,
        # so they opt out of the follow-up via the manifest flag.
        self_resolving = game_meta.self_resolving if game_meta else False
        if move is not None and status == "PLAYING" and not self_resolving:
            follow = await self._core_move(session_id, GameState(
                session_id=game.session_id, game_id=game.game_id, state=resp.state,
                status=resp.status, turn=game.turn + 1,
            ), None)
            texts.append(follow.text)
            status = follow.detail.get("status", status)
            if status in TERMINAL_STATUSES:
                self._detach(session_id)
            return RouteResult(text="\n\n".join(texts), route="core",
                               detail={"game": game.game_id, "status": status})

        # The film's climax (fidelity-notes.md §2): a live GTW exchange ending
        # NO-WIN triggers the all-scenarios sweep before the famous verdict.
        if game.game_id == "gtw" and status == "NO-WIN":
            texts.append(montage_text())
        if resp.result:
            texts.append(resp.result)
        if game.game_id == "gtw" and status == "NO-WIN":
            texts.append(CHESS_CODA)
        if status in TERMINAL_STATUSES:
            self._detach(session_id)
        return RouteResult(text="\n\n".join(texts), route="core",
                           detail={"game": game.game_id, "status": status})

    async def _query_game(self, session_id: str, game: GameState) -> RouteResult:
        """Re-read a game's display without moving it — what a bare Enter gets,
        since MOVE with no INPUT is an invalid move to the core, not a peek."""
        game_meta = self.catalog.get(game.game_id)
        timeout = game_meta.timeout_s if game_meta else None
        try:
            resp = await self.runner.run(game.game_id, "QUERY", game.state, None, timeout_s=timeout)
        except CoreTimeout:
            return RouteResult(text=CORE_TIMEOUT_TEXT, route="core", detail={"error": "timeout"})
        except CoreBusy:
            return RouteResult(text=CORE_BUSY_TEXT, route="core", detail={"error": "busy"})
        except CoreError as exc:
            return RouteResult(text=f"ERROR: {exc}", route="core", detail={"error": str(exc)})
        return RouteResult(text=resp.display, route="core",
                           detail={"game": game.game_id, "status": game.status})

    async def _new_game(self, session_id: str, game_id: str, room: str | None) -> RouteResult:
        game = self.catalog.get(game_id)
        if game is None:
            return RouteResult(text=f"UNKNOWN GAME: {game_id.upper()}", route="bridge")
        if game.status != "implemented":
            return RouteResult(text=f"{game.title}\n{NOT_IMPLEMENTED}", route="bridge")

        async with self.locks.lock(room_key(room)):
            if room is not None:
                existing = await self.store.get_latest_game(game_id, room)
                if existing is not None:
                    try:
                        resp = await self.runner.run(game_id, "QUERY", existing.state, None,
                                                     timeout_s=game.timeout_s)
                    except CoreTimeout:
                        return RouteResult(text=CORE_TIMEOUT_TEXT, route="core",
                                           detail={"error": "timeout"})
                    except CoreBusy:
                        # Same in-character line _core_move uses for a busy
                        # core — never a bare ERROR: dump (#44).
                        return RouteResult(text=CORE_BUSY_TEXT, route="core",
                                           detail={"error": "busy"})
                    except CoreError as exc:
                        return RouteResult(text=f"ERROR: {exc}", route="core",
                                           detail={"error": str(exc)})
                    self._attach_game(session_id, game_id)
                    return RouteResult(
                        text=f"SIMULATION ALREADY IN PROGRESS\n\n{resp.display}",
                        route="bridge", detail={"game": game_id, "attached": True})

            try:
                resp = await self.runner.run(game_id, "NEW", None, None, timeout_s=game.timeout_s)
            except CoreTimeout:
                return RouteResult(text=CORE_TIMEOUT_TEXT, route="core", detail={"error": "timeout"})
            except CoreBusy:
                return RouteResult(text=CORE_BUSY_TEXT, route="core", detail={"error": "busy"})
            except CoreError as exc:
                return RouteResult(text=f"ERROR: {exc}", route="core", detail={"error": str(exc)})

            await self.store.upsert_game(GameState(
                session_id=session_id, game_id=game_id, state=resp.state, status=resp.status, turn=0,
            ))
            await self.store.log_event(session_id, "core", "wopr", {"game": game_id, "event": "NEW"})
            hint = f"\n\n{game.title}. INPUT: {game.input_syntax.upper()}" if game.input_syntax else ""
            self._attach_game(session_id, game_id)
            return RouteResult(text=resp.display + hint, route="bridge", detail={"game": game_id})

    async def _quit(self, session_id: str, active: GameState | None,
                    room: str | None) -> RouteResult:
        if active is None:
            return RouteResult(text="NO GAME IN PROGRESS.", route="bridge")
        # Serialize with the room's hub ticks; re-read inside the lock so we
        # quit the freshest state, not the pre-lock snapshot — otherwise a
        # concurrent tick's upsert (advancing state/turn) could be clobbered
        # by this stale copy, or a game that already ended could be
        # resurrected back to PLAYING-then-QUIT.
        async with self.locks.lock(room_key(room)):
            fresh = await self._active_game(session_id, room)
            if fresh is None:
                return RouteResult(text="NO GAME IN PROGRESS.", route="bridge")
            fresh.status = "QUIT"
            await self.store.upsert_game(fresh)
            self._detach(session_id)
            return RouteResult(text=f"{fresh.game_id.upper()} TERMINATED.", route="bridge")

    async def _status(self, session_id: str, active: GameState | None) -> RouteResult:
        session = await self.store.get_session(session_id)
        defcon = session.defcon if session else 5
        sim = f"SIMULATION: {active.game_id.upper()} TURN {active.turn}" if active else "SIMULATION: IDLE"
        return RouteResult(text=f"{sim}\nDEFCON {defcon}", route="bridge")

    async def _sitrep(self, session_id: str, active: GameState | None) -> RouteResult:
        session = await self.store.get_session(session_id)
        level = await self.store.get_clearance_level(session.user_id if session else None)
        defcon = session.defcon if session else 5
        sim = (f"SIMULATION: {active.game_id.upper()} TURN {active.turn}"
               if active else "SIMULATION: IDLE")
        room = session.room_code if session and session.room_code else "NONE"
        link = session.link_profile.upper() if session else "UNKNOWN"
        callsign = session.user_id if session else "UNKNOWN"
        return RouteResult(
            text=(f"SITREP {callsign} LEVEL {level}\nDEFCON {defcon}\n{sim}\n"
                  f"CONFERENCE: {room}\nLINK: {link}"),
            route="bridge")

    async def _tracks(self, session_id: str, room: str | None) -> RouteResult:
        active = await self._active_game(session_id, room)
        if active is None or active.game_id != "gtw":
            return RouteResult(text="NO ACTIVE TRACKS", route="bridge")
        game = self.catalog.get("gtw")
        try:
            resp = await self.runner.run("gtw", "QUERY", active.state, None,
                                         timeout_s=game.timeout_s if game else None)
        except CoreTimeout:
            return RouteResult(text=CORE_TIMEOUT_TEXT, route="core", detail={"error": "timeout"})
        except CoreBusy:
            return RouteResult(text=CORE_BUSY_TEXT, route="core", detail={"error": "busy"})
        except CoreError as exc:
            return RouteResult(text=f"ERROR: {exc}", route="core", detail={"error": str(exc)})
        feed = display_to_feed(resp.display, active.status)
        return RouteResult(text=tracks_text(feed), route="bridge", detail={"game": "gtw"})

    async def _events(self, session_id: str) -> RouteResult:
        rows = await self.store.get_recent_events(session_id, limit=10)
        if not rows:
            return RouteResult(text="NO EVENTS LOGGED", route="bridge")
        lines = []
        for r in rows:
            payload = r.get("payload", {})
            summary = ""
            for key in ("text", "route", "defcon", "game", "system"):
                if key in payload:
                    summary = f"{key} {payload[key]}"
                    break
            lines.append(f"{r['kind'].upper():<8}{r['actor'].upper():<8}{summary.upper()[:44]}")
        return RouteResult(text="\n".join(lines), route="bridge")

    async def _set_defcon(self, session_id: str, level: int) -> RouteResult:
        session = await self.store.get_session(session_id)
        clearance = await self.store.get_clearance_level(session.user_id if session else None)
        # Same rule as POST /api/session/{id}/defcon: 1 is most privileged,
        # you may only command at or above your numeric floor.
        if level < clearance:
            return RouteResult(text="CLEARANCE DENIED", route="bridge",
                               detail={"defcon": level, "denied": True})
        await self.store.set_defcon(session_id, level)
        return RouteResult(text=f"DEFCON {level} SET", route="bridge",
                           detail={"defcon": level})

    async def _converse(self, session_id: str, raw: str, room: str | None) -> RouteResult:
        count = self._joshua_counts.get(session_id, 0)
        if count >= self.joshua_session_cap:
            return RouteResult(text="SESSION RESOURCES EXHAUSTED. SHALL WE PLAY A GAME?",
                               route="joshua", detail={"capped": True})
        self._joshua_counts[session_id] = count + 1

        history = self._joshua_history.setdefault(session_id, [])
        reply = await self.joshua.chat(session_id, history, raw)
        history.append({"role": "user", "content": raw})
        history.append({"role": "assistant", "content": reply.text})
        del history[:-20]  # bound the context (and the token bill, D5)

        await self.store.log_event(session_id, "joshua", "joshua",
                                   {"input": raw, "reply": reply.text,
                                    "start_game": reply.start_game_id})

        if reply.start_game_id:
            # Joshua asks; the monitor attaches. Joshua never reaches a game
            # itself — which is the film's argument, in the architecture.
            started = await self._new_game(session_id, reply.start_game_id, room)
            return RouteResult(text=f"{reply.text}\n\n{started.text}", route="joshua",
                               detail={"start_game": reply.start_game_id})
        return RouteResult(text=reply.text, route="joshua")
