"""The bridge's brain — a connection monitor, not a per-line classifier
(attachment.py). A session is attached to exactly one program, and a line
either is a reserved word (which outranks any attachment) or belongs entirely
to whatever the session is attached to: the game, Joshua, or NORAD ops."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from .attachment import Attachment, FRONT_DOOR, GAME, JOSHUA, NORAD_OPS, prompt_for
from .games import (Game, interpretation_dir, list_games_text,
                    list_interpretations_text, match_slot, resolve_selector)
from .gtwfeed import display_to_feed, tracks_text
from .joshua import Joshua
from .operators import Operator
from .rooms import RoomLocks, room_key
from .runner import CoreBusy, CoreError, CoreRunner, CoreTimeout
from .scenarios import montage_text
from .store import GameState, Store
from .wire import TERMINAL_STATUSES

LOGON_REJECTION = ("INDENTIFICATION NOT RECOGNIZED BY SYSTEM"
                   "\n--CONNECTION TERMINATED--")
# sic: the film's own on-screen misspelling, reproduced deliberately
# (fidelity audit 2026-08-03, real-wopr#161).
BACKDOOR_GREETING = "GREETINGS PROFESSOR FALKEN."
HELP_NOT_AVAILABLE = "HELP NOT AVAILABLE"
# What WOPR answers when asked what a "game" is — the one HELP topic it has.
# Verbatim from the scene (owner batch approval 2026-08-03, real-wopr#161).
HELP_GAMES_DEFINITION = ("'GAMES' REFERS TO MODELS, SIMULATIONS AND GAMES\n"
                         "WHICH HAVE TACTICAL AND STRATEGIC APPLICATIONS.")
CHESS_CODA = "HOW ABOUT A NICE GAME OF CHESS?"
# The verdict. The games put it on the wire as one canonical sentence (their
# RESULT line, and their goldens, are untouched by this); the film's screen
# breaks it across three lines, so the break belongs to the rendering here.
NOWIN_RESULT = "A STRANGE GAME. THE ONLY WINNING MOVE IS NOT TO PLAY."
NOWIN_VERDICT = "A STRANGE GAME.\nTHE ONLY WINNING MOVE IS\nNOT TO PLAY."
NOT_IMPLEMENTED = "NOT YET IMPLEMENTED. SEE docs/contributing.md TO CLAIM IT."
CORE_TIMEOUT_TEXT = "WOPR CORE UNRESPONSIVE. REQUEST TERMINATED."
CORE_BUSY_TEXT = "ALL WOPR PROCESSORS COMMITTED. STAND BY."
ACCESS_CODE_PROMPT = "ACCESS CODE:"
UNRECOGNIZED_DIRECTIVE = "UNRECOGNIZED DIRECTIVE"
# How the film's WOPR heads a line it cannot parse. A banner and its underline,
# with the reason printed under it — the indentation and the rule are how it
# appears on screen, so they are part of the text, not formatting of this file.
IMPROPER_REQUEST = "       ** IMPROPER REQUEST **\n       ----------------------"
# The answer to CEASE RANDOM FUNCTION at the NORAD console: you cannot stop it.
CHANGES_LOCKED_OUT = "     >>> CHANGES LOCKED OUT <<<"
CEASE_RANDOM_FUNCTION = "CEASE RANDOM FUNCTION"
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
    # Words that always mean the monitor, in every mode. Seven literals and
    # seven distinct answers: HELP GAMES used to alias LIST GAMES, but the
    # film gives it its own definition text, so it stands on its own now.
    # The objection this design answers is that *Joshua's* vocabulary
    # should not pull you out of a game, and six commands do not. LIST GAMES
    # and NEW are required by the evals — E03 asserts the catalog in exact
    # order on both Joshua engines, so Joshua cannot own that answer. NEW and
    # LOGON are listed bare because that is the command being reserved, but
    # both take an argument (NEW TICTACTOE, LOGON CRYSTAL); _logon_line and
    # _reserved match the prefix, never the bare word alone — except a bare
    # LOGON, which is a rejection rather than a fall-through.
    RESERVED = frozenset({"LIST GAMES", "HELP GAMES", "NEW", "QUIT", "STATUS",
                          "HELP", "LOGON"})

    def __init__(self, runner: CoreRunner, store: Store, engines: dict[str, Joshua],
                 catalog: dict[str, Game], joshua_session_cap: int = 50,
                 locks: "RoomLocks | None" = None,
                 operators: dict[str, Operator] | None = None,
                 default_engine: str = ""):
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
        # session_id -> engine name. Scratch, like _attach and _joshua_history:
        # a restart already loses the conversation this would belong to.
        self._engine_choice: dict[str, str] = {}
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
        """True once the session has opened the JOSHUA backdoor.

        Nothing in production consults this any more: the WS layer used to
        greet only unauthenticated lines with LOGON:, but that conflated the
        backdoor with a NORAD roster logon (an operator's reconnect kept its
        attachment yet was never "authenticated" by this method's definition)
        and got re-greeted wrongly. The greeting is decided by
        `attachment(session_id).mode == FRONT_DOOR` instead. Left in place —
        only test_is_authenticated_tracks_the_backdoor reaches it — for a
        later phase that may still want a pure backdoor check."""
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
            if upper in ("JOSHUA", "LOGON JOSHUA"):
                # The backdoor abandons any in-flight operator logon prompt
                # with no failure increment — otherwise the next line is
                # swallowed as a wrong access-code attempt against stale
                # state. Shared here (not just in _front_door's own copy of
                # this check) so the carve-out holds in every mode: LOGON is
                # reserved and reaches _pending_logon from GAME, NORAD_OPS,
                # and JOSHUA attachments too, not only the front door.
                self._pending_logon.pop(session_id, None)
                return None
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
        NORAD terminal, gets past it. Reserved words do not work here — except
        the two the film shows David using before he is ever admitted.
        """
        # Checked first so a pending access-code prompt is abandoned (not
        # matched as the code) before the bare-JOSHUA branch below fires;
        # _logon_line owns that carve-out so every mode shares one copy of it.
        logon = await self._logon_line(session_id, raw, upper)
        if logon is not None:
            return logon
        if upper in ("JOSHUA", "LOGON JOSHUA"):
            self._attach[session_id] = Attachment(mode=JOSHUA)
            self._authenticated.add(session_id)
            self._joshua_history.setdefault(session_id, []).append(
                {"role": "assistant", "content": BACKDOOR_GREETING})
            return RouteResult(text=BACKDOOR_GREETING, route="bridge",
                               detail={"backdoor": True})
        # The door answers two questions before it opens, because the film
        # shows it doing so: David reads the HELP GAMES definition and then
        # the whole games list while still locked out. This reverses the
        # earlier no-leak stance (the amendment is dated 2026-08-03 in
        # real-wopr's executive-design spec; audit: real-wopr#161). Nothing
        # else moves — no game starts and no session is authenticated here.
        if upper == "LIST GAMES":
            return RouteResult(text=list_games_text(self.catalog), route="bridge",
                               detail={"authenticated": False})
        if upper == "HELP GAMES":
            return RouteResult(text=HELP_GAMES_DEFINITION, route="bridge",
                               detail={"authenticated": False})
        if upper == "HELP" or upper.startswith("HELP "):
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
        if upper == "LIST GAMES":
            return RouteResult(text=list_games_text(self.catalog), route="bridge")
        if upper == "HELP GAMES":
            # A definition, not a catalog: HELP GAMES stopped aliasing
            # LIST GAMES on 2026-08-03 — in the film they are two different
            # answers, and the door now serves both of them (real-wopr#161).
            return RouteResult(text=HELP_GAMES_DEFINITION, route="bridge")
        if upper.startswith("LIST "):
            # LIST <TITLE> is the one door into a slot's interpretations (§8).
            # Anything that names no slot falls through — the attached program
            # or Joshua owns the line, exactly as before.
            slot = match_slot(self.catalog, upper[5:])
            if slot is not None:
                if slot.status != "implemented":
                    return RouteResult(text=f"{slot.title}\n{NOT_IMPLEMENTED}", route="bridge")
                return RouteResult(text=list_interpretations_text(slot), route="bridge")
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
            # An optional trailing token picks an interpretation: NEW <id> <n>
            # or <name>/<author>. Bare NEW <id> is always core (§8).
            game_arg, _, sel = upper[4:].strip().partition(" ")
            return await self._new_game(session_id, game_arg.lower(), room,
                                        selector=sel.strip() or None)
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
                    # A bare Enter is not a move, so it must not be refused like
                    # one: MOVE with an empty INPUT fails as an invalid move,
                    # and QUERY reads the board back without asking anything.
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
        if upper == CEASE_RANDOM_FUNCTION and active is not None:
            # The film's whole argument, at the console (#116). `active` is the
            # room's latest *playing* game, the same view TRACKS and SITREP get,
            # so any live simulation locks changes out — the film had tic-tac-toe
            # on screen while the launch routine ran, so what is displayed is
            # beside the point. With nothing running there is nothing to cease,
            # and the line falls through to UNRECOGNIZED DIRECTIVE below.
            return RouteResult(text=CHANGES_LOCKED_OUT, route="bridge",
                               detail={"cease": "locked"})
        m = _SET_DEFCON.match(upper)
        if m:
            return await self._set_defcon(session_id, int(m.group(1)))

        # NORAD staff not knowing the backdoor is the plot: without it they get
        # the terse machine, never Joshua.
        return RouteResult(text=UNRECOGNIZED_DIRECTIVE, route="bridge")

    # -- destinations ---------------------------------------------------------

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

    async def _core_move(self, session_id: str, game: GameState, move: str | None) -> RouteResult:
        game_meta = self.catalog.get(game.game_id)
        timeout = game_meta.timeout_s if game_meta else None
        try:
            idir = self._pinned_dir(game_meta, game)
        except KeyError:
            return RouteResult(text=f"UNKNOWN INTERPRETATION: {game.interpretation.upper()}",
                               route="core", detail={"error": "unknown interpretation"})
        try:
            resp = await self.runner.run(game.game_id, "MOVE", game.state, move, timeout_s=timeout,
                                         interp_dir=idir)
        except CoreTimeout:
            await self.store.log_event(session_id, "error", "system",
                                       {"game": game.game_id, "error": "timeout"})
            return RouteResult(text=CORE_TIMEOUT_TEXT, route="core", detail={"error": "timeout"})
        except CoreBusy:
            return RouteResult(text=CORE_BUSY_TEXT, route="core", detail={"error": "busy"})
        except CoreError as exc:
            # Logged before the text is decided, and with what the game actually
            # said: the user-facing line changes below, the diagnostic must not.
            await self.store.log_event(session_id, "error", "wopr",
                                       {"game": game.game_id, "error": str(exc)})
            # Two very different things arrive as CoreError. A game that parsed
            # the frame and *declared* STATUS ERROR has rejected the line — a
            # judgement, and the film's answer to it is IMPROPER REQUEST (#120).
            # Anything else (no frame at all, or a frame the game never marked
            # ERROR while its binary died) is a genuine fault; dressing that up
            # in film flavour would hide it, which is worse than the raw dump.
            if exc.response is not None and exc.response.status == "ERROR":
                # The film prints a banner, its underline, and then a reason
                # line — so the game's own RESULT goes underneath rather than in
                # the bin. It is terse uppercase machine text, exactly what a
                # 1983 system prints; what #44 objected to was the raw "ERROR: "
                # prefix putting a Python exception on the teletype, not the
                # machine saying which target it failed to recognise. A game
                # that gave no reason gets the banner alone.
                reason = exc.response.result
                text = f"{IMPROPER_REQUEST}\n\n{reason}" if reason else IMPROPER_REQUEST
                return RouteResult(text=text, route="core",
                                   detail={"error": str(exc), "refused": True})
            return RouteResult(text=f"ERROR: {exc}", route="core", detail={"error": str(exc)})

        await self.store.upsert_game(GameState(
            session_id=game.session_id, game_id=game.game_id, state=resp.state,
            status=resp.status, turn=game.turn + 1, interpretation=game.interpretation,
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
                status=resp.status, turn=game.turn + 1, interpretation=game.interpretation,
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
            # Every game that reaches NO-WIN says the same sentence, so the
            # three-line form is keyed on the sentence itself, not on the id:
            # GTW and tic-tac-toe both arrive here.
            texts.append(NOWIN_VERDICT
                         if status == "NO-WIN" and resp.result == NOWIN_RESULT
                         else resp.result)
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
            idir = self._pinned_dir(game_meta, game)
        except KeyError:
            return RouteResult(text=f"UNKNOWN INTERPRETATION: {game.interpretation.upper()}",
                               route="core", detail={"error": "unknown interpretation"})
        try:
            resp = await self.runner.run(game.game_id, "QUERY", game.state, None, timeout_s=timeout,
                                         interp_dir=idir)
        except CoreTimeout:
            return RouteResult(text=CORE_TIMEOUT_TEXT, route="core", detail={"error": "timeout"})
        except CoreBusy:
            return RouteResult(text=CORE_BUSY_TEXT, route="core", detail={"error": "busy"})
        except CoreError as exc:
            return RouteResult(text=f"ERROR: {exc}", route="core", detail={"error": str(exc)})
        return RouteResult(text=resp.display, route="core",
                           detail={"game": game.game_id, "status": game.status})

    async def _new_game(self, session_id: str, game_id: str, room: str | None,
                        selector: str | None = None) -> RouteResult:
        game = self.catalog.get(game_id)
        if game is None:
            return RouteResult(text=f"UNKNOWN GAME: {game_id.upper()}", route="bridge")
        if game.status != "implemented":
            return RouteResult(text=f"{game.title}\n{NOT_IMPLEMENTED}", route="bridge")
        # Bare start is always the core interpretation (§8); a selector — the
        # number, name, or author LIST <TITLE> printed — picks another.
        pin = "core" if selector is None else resolve_selector(game, selector)
        if pin is None:
            return RouteResult(text=f"UNKNOWN INTERPRETATION: {selector}", route="bridge")
        idir = interpretation_dir(game, pin)

        async with self.locks.lock(room_key(room)):
            if room is not None:
                existing = await self.store.get_latest_game(game_id, room)
                if existing is not None:
                    # The room's game was started under its own pin; attaching
                    # must run THAT reconstruction — its STATE is not portable.
                    try:
                        existing_dir = interpretation_dir(game, existing.interpretation)
                    except KeyError:
                        return RouteResult(
                            text=f"UNKNOWN INTERPRETATION: {existing.interpretation.upper()}",
                            route="core", detail={"error": "unknown interpretation"})
                    try:
                        resp = await self.runner.run(game_id, "QUERY", existing.state, None,
                                                     timeout_s=game.timeout_s,
                                                     interp_dir=existing_dir)
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
                resp = await self.runner.run(game_id, "NEW", None, None, timeout_s=game.timeout_s,
                                             interp_dir=idir)
            except CoreTimeout:
                return RouteResult(text=CORE_TIMEOUT_TEXT, route="core", detail={"error": "timeout"})
            except CoreBusy:
                return RouteResult(text=CORE_BUSY_TEXT, route="core", detail={"error": "busy"})
            except CoreError as exc:
                return RouteResult(text=f"ERROR: {exc}", route="core", detail={"error": str(exc)})

            await self.store.upsert_game(GameState(
                session_id=session_id, game_id=game_id, state=resp.state, status=resp.status, turn=0,
                interpretation=pin,
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
        reply = await self._engine_for(session_id).chat(session_id, history, raw)
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
