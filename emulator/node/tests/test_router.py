"""Destination tests: what each route actually does once the monitor has
chosen it. Mode and attachment behaviour lives in test_monitor.py.

Joshua is stubbed throughout — the scripted engine IS a deterministic stub."""

import asyncio
from pathlib import Path

import pytest

from app.attachment import NORAD_OPS
from app.games import load_catalog, list_games_text
from app.joshua import ScriptedJoshua
from app.rooms import RoomLocks, room_key
from app.router import Router, LOGON_REJECTION, CORE_BUSY_TEXT, CORE_TIMEOUT_TEXT
from app.runner import CoreBusy, CoreRunner, CoreTimeout, RunnerConfig
from app.store import MemoryStore

REPO = Path(__file__).resolve().parent.parent.parent.parent
REAL_BIN = REPO / "games"
GAMES_DIR = REPO / "games"

needs_core = pytest.mark.skipif(
    not (REAL_BIN / "tictactoe" / "harness" / "bin" / "tictactoe").exists(),
    reason="core not built (run tools/import-programs.sh)",
)


def make_router(store: MemoryStore, locks: RoomLocks | None = None,
                operators=None) -> Router:
    catalog = load_catalog(GAMES_DIR)
    runner = CoreRunner(RunnerConfig(bin_dir=REAL_BIN))
    joshua = ScriptedJoshua({g.id: g.title for g in catalog.values() if g.status == "implemented"})
    return Router(runner, store, {"scripted": joshua}, catalog, locks=locks, operators=operators)


class ContentionSignalingLock(asyncio.Lock):
    """asyncio.Lock whose public `contended` event fires when a second
    acquirer starts waiting — lets tests synchronize on "task X is parked on
    the room lock" without peeking at the private Lock._waiters (#44)."""

    def __init__(self) -> None:
        super().__init__()
        self.contended = asyncio.Event()

    async def acquire(self) -> bool:
        if self.locked():
            self.contended.set()
        return await super().acquire()


class SignalingRoomLocks(RoomLocks):
    """RoomLocks handing out ContentionSignalingLocks; same public surface."""

    def __init__(self) -> None:
        super().__init__()
        self._signal_locks: dict[str, ContentionSignalingLock] = {}

    def lock(self, key: str) -> ContentionSignalingLock:
        return self._signal_locks.setdefault(key, ContentionSignalingLock())


async def new_session(store: MemoryStore) -> str:
    s = await store.create_session("home-terminal", "dialup-300", None)
    return s.id


@pytest.fixture
def router_with_memory_store() -> tuple[Router, MemoryStore]:
    store = MemoryStore()
    return make_router(store), store


async def logon_as_joshua(router: Router, sid: str) -> None:
    r = await router.handle(sid, "JOSHUA")
    assert r.text == "GREETINGS PROFESSOR FALKEN."
    assert r.detail.get("backdoor") is True


def test_commands_are_rejected_until_joshua_backdoor():
    store = MemoryStore()
    router = make_router(store)

    async def flow():
        sid = await new_session(store)

        r = await router.handle(sid, "LIST GAMES")
        assert r.route == "bridge"
        assert r.text == LOGON_REJECTION
        assert "GLOBAL THERMONUCLEAR WAR" not in r.text

        r = await router.handle(sid, "LET'S PLAY TIC-TAC-TOE")
        assert r.route == "bridge"
        assert r.text == LOGON_REJECTION
        assert (await store.get_active_game(sid)) is None

        await logon_as_joshua(router, sid)
        r = await router.handle(sid, "LIST GAMES")
        assert "GLOBAL THERMONUCLEAR WAR" in r.text

    asyncio.run(flow())


def test_list_games_is_bridge_handled_and_film_ordered():
    store = MemoryStore()
    router = make_router(store)

    async def flow():
        sid = await new_session(store)
        await logon_as_joshua(router, sid)
        r = await router.handle(sid, "LIST GAMES")
        assert r.route == "bridge"
        assert r.text.splitlines()[0] == "FALKEN'S MAZE"
        assert r.text.splitlines()[-1] == "GLOBAL THERMONUCLEAR WAR"

    asyncio.run(flow())


def test_is_authenticated_tracks_the_backdoor():
    """The WS layer greets a fresh line with LOGON:; after a comms resync it
    must NOT re-greet a session that already opened the backdoor (#54)."""
    store = MemoryStore()
    router = make_router(store)

    async def flow():
        sid = await new_session(store)
        assert router.is_authenticated(sid) is False
        await logon_as_joshua(router, sid)
        assert router.is_authenticated(sid) is True
        # A different session on the same router is still unauthenticated.
        other = await new_session(store)
        assert router.is_authenticated(other) is False

    asyncio.run(flow())


def test_logon_is_rejected_by_the_bridge():
    store = MemoryStore()
    router = make_router(store)

    async def flow():
        sid = await new_session(store)
        r = await router.handle(sid, "LOGON")
        assert r.route == "bridge"
        assert r.text == LOGON_REJECTION

    asyncio.run(flow())


def test_joshua_backdoor_and_film_beat_order():
    """fidelity-notes.md §1: JOSHUA -> GREETINGS -> HOW ARE YOU FEELING TODAY?"""
    store = MemoryStore()
    router = make_router(store)

    async def flow():
        sid = await new_session(store)
        r = await router.handle(sid, "JOSHUA")
        assert r.text == "GREETINGS PROFESSOR FALKEN."
        assert r.detail.get("backdoor") is True
        r = await router.handle(sid, "HELLO. ARE YOU STILL THERE?")
        assert "HOW ARE YOU FEELING TODAY?" in r.text
        r = await router.handle(sid, "I'M FINE. HOW ARE YOU?")
        assert "SHALL WE PLAY A GAME?" in r.text

    asyncio.run(flow())


def test_help_is_not_available_but_help_games_is():
    store = MemoryStore()
    router = make_router(store)

    async def flow():
        sid = await new_session(store)
        assert (await router.handle(sid, "HELP")).text == "HELP NOT AVAILABLE"
        assert (await router.handle(sid, "HELP LOGON")).text == "HELP NOT AVAILABLE"
        assert (await router.handle(sid, "HELP GAMES")).text == LOGON_REJECTION
        await logon_as_joshua(router, sid)
        assert "GLOBAL THERMONUCLEAR WAR" in (await router.handle(sid, "HELP GAMES")).text

    asyncio.run(flow())


@needs_core
def test_gtw_request_gets_chess_counteroffer_first():
    """fidelity-notes.md §1: WOULDN'T YOU PREFER A GOOD GAME OF CHESS?"""
    store = MemoryStore()
    router = make_router(store)

    async def flow():
        sid = await new_session(store)
        await logon_as_joshua(router, sid)
        r = await router.handle(sid, "LET'S PLAY GLOBAL THERMONUCLEAR WAR")
        assert "GOOD GAME OF CHESS" in r.text
        assert (await store.get_active_game(sid)) is None
        r = await router.handle(sid, "LATER. LET'S PLAY GLOBAL THERMONUCLEAR WAR")
        assert "FINE." in r.text
        assert (await store.get_active_game(sid)) is not None

    asyncio.run(flow())


def test_placeholder_game_reports_not_implemented():
    store = MemoryStore()
    router = make_router(store)

    async def flow():
        sid = await new_session(store)
        await logon_as_joshua(router, sid)
        r = await router.handle(sid, "NEW bridge")
        assert r.route == "bridge"
        assert "NOT YET IMPLEMENTED" in r.text

    asyncio.run(flow())


def test_chat_routes_to_joshua():
    store = MemoryStore()
    router = make_router(store)

    async def flow():
        sid = await new_session(store)
        assert (await router.handle(sid, "HELLO ARE YOU JOSHUA")).text == LOGON_REJECTION
        await logon_as_joshua(router, sid)
        r = await router.handle(sid, "HELLO ARE YOU JOSHUA")
        assert r.route == "joshua"
        assert "HOW ARE YOU FEELING TODAY?" in r.text
        # The route decision is logged (api-contract.md §6).
        kinds = [e["kind"] for e in store.events]
        assert kinds.count("route") == 3 and "joshua" in kinds

    asyncio.run(flow())


@needs_core
def test_digit_without_active_game_goes_to_joshua_not_core():
    store = MemoryStore()
    router = make_router(store)

    async def flow():
        sid = await new_session(store)
        assert (await router.handle(sid, "5")).text == LOGON_REJECTION
        await logon_as_joshua(router, sid)
        r = await router.handle(sid, "5")
        assert r.route == "joshua"

    asyncio.run(flow())


@needs_core
def test_full_game_flow_move_routes_to_core_and_wopr_replies():
    store = MemoryStore()
    router = make_router(store)

    async def flow():
        sid = await new_session(store)
        await logon_as_joshua(router, sid)
        started = await router.handle(sid, "NEW tictactoe")
        assert started.route == "bridge"
        assert (await store.get_active_game(sid)) is not None

        r = await router.handle(sid, "5")
        assert r.route == "core"
        # WOPR played its own move after the human's: board shows an O reply
        # and the turn is back with the human (X).
        game = store.games[sid]
        board, turn_line = game.state.splitlines()
        assert board.count("X") == 1 and board.count("O") == 1
        assert turn_line == "TURN X"
        assert game.status == "PLAYING"
        assert "X" in r.text and "O" in r.text

    asyncio.run(flow())


@needs_core
def test_hearts_move_does_not_fire_inputless_follow_up():
    """Hearts resolves all four seats inside the human's MOVE and dies on an
    inputless follow-up. A self-resolving game must never get the "WOPR plays
    its own side" follow-up call (the T1 convention) — the player must see the
    trick DISPLAY, not ERROR: INPUT REQUIRED."""
    store = MemoryStore()
    router = make_router(store)

    async def flow():
        sid = await new_session(store)
        await logon_as_joshua(router, sid)
        await router.handle(sid, "NEW hearts")
        # SOUTH holds the deterministic fresh deal starting 6C; the opening
        # trick (2C 3C 7C) forces a club, so 6C is the legal opening play.
        r = await router.handle(sid, "6C")
        assert r.route == "core"
        assert "ERROR: INPUT REQUIRED" not in r.text
        assert "YOUR PLAY?" in r.text
        game = await store.get_active_game(sid)
        assert game is not None and game.status == "PLAYING"

    asyncio.run(flow())


@needs_core
def test_gin_rummy_move_does_not_fire_inputless_follow_up():
    """Gin-rummy is self-resolving (players=1); DEAL leaves it PLAYING but an
    inputless follow-up MOVE dies with INPUT REQUIRED."""
    store = MemoryStore()
    router = make_router(store)

    async def flow():
        sid = await new_session(store)
        await logon_as_joshua(router, sid)
        started = await router.handle(sid, "NEW gin-rummy")
        assert "TYPE DEAL" in started.text
        r = await router.handle(sid, "DEAL")
        assert r.route == "core"
        assert "ERROR: INPUT REQUIRED" not in r.text
        assert "DRAW OR TAKE" in r.text
        game = await store.get_active_game(sid)
        assert game is not None and game.status == "PLAYING"

    asyncio.run(flow())


@needs_core
def test_poker_move_does_not_fire_inputless_follow_up():
    """Poker is self-resolving (players=1); DEAL leaves it PLAYING but an
    inputless follow-up MOVE dies with INPUT REQUIRED."""
    store = MemoryStore()
    router = make_router(store)

    async def flow():
        sid = await new_session(store)
        await logon_as_joshua(router, sid)
        started = await router.handle(sid, "NEW poker")
        assert "TYPE DEAL" in started.text
        r = await router.handle(sid, "DEAL")
        assert r.route == "core"
        assert "ERROR: INPUT REQUIRED" not in r.text
        assert "BET OR CHECK?" in r.text
        game = await store.get_active_game(sid)
        assert game is not None and game.status == "PLAYING"

    asyncio.run(flow())


@needs_core
def test_natural_language_starts_game_via_joshua_intent():
    store = MemoryStore()
    router = make_router(store)

    async def flow():
        sid = await new_session(store)
        await logon_as_joshua(router, sid)
        r = await router.handle(sid, "LET'S PLAY TIC-TAC-TOE")
        assert r.route == "joshua"
        assert (await store.get_active_game(sid)) is not None

    asyncio.run(flow())


@needs_core
def test_quit_terminates_the_active_game():
    store = MemoryStore()
    router = make_router(store)

    async def flow():
        sid = await new_session(store)
        await logon_as_joshua(router, sid)
        await router.handle(sid, "NEW tictactoe")
        r = await router.handle(sid, "QUIT")
        assert "TERMINATED" in r.text
        assert (await store.get_active_game(sid)) is None

    asyncio.run(flow())


@needs_core
def test_room_terminals_share_one_game(router_with_memory_store):
    """Terminal B's digit move applies to the tictactoe game terminal A started,
    once B has joined it with NEW — the join gesture the rooms design already
    specifies ("typing NEW GTW when the room already has a running simulation
    joins it")."""
    router, store = router_with_memory_store

    async def flow():
        room = await store.create_room("AAAAAA")
        sa = await store.create_session("home-terminal", "dialup-300", None, room.code)
        sb = await store.create_session("norad-terminal", "leased-9600", None, room.code)
        await router.handle(sa.id, "JOSHUA")
        await router.handle(sb.id, "JOSHUA")
        await router.handle(sa.id, "NEW tictactoe")
        joined = await router.handle(sb.id, "NEW tictactoe")
        assert joined.detail.get("attached") is True
        before = await store.get_latest_game("tictactoe", room.code)
        moved = await router.handle(sb.id, "5")
        assert moved.route == "core"
        after = await store.get_latest_game("tictactoe", room.code)
        assert after.turn > before.turn
        assert after.session_id == sa.id  # ownership stays with the creator

    asyncio.run(flow())


@needs_core
def test_room_terminals_share_one_game_no_longer_without_joining(router_with_memory_store):
    """Deliberate change: a terminal in the room that never joined is still
    attached to Joshua, so its move-shaped line is Joshua's, not the game's.
    Routing is by attachment now, never by inspecting the line (E1/E2) — the
    move pattern that used to claim this line for the room's game is gone."""
    router, store = router_with_memory_store

    async def flow():
        room = await store.create_room("AAAAAA")
        sa = await store.create_session("home-terminal", "dialup-300", None, room.code)
        sb = await store.create_session("norad-terminal", "leased-9600", None, room.code)
        await router.handle(sa.id, "JOSHUA")
        await router.handle(sb.id, "JOSHUA")
        await router.handle(sa.id, "NEW tictactoe")
        before = await store.get_latest_game("tictactoe", room.code)
        # Copied, not aliased: an unmoved MemoryStore hands back the very same
        # GameState object, and comparing it with itself would assert nothing.
        before_turn, before_state = before.turn, before.state
        stray = await router.handle(sb.id, "5")
        assert stray.route == "joshua"
        after = await store.get_latest_game("tictactoe", room.code)
        assert after.turn == before_turn  # A's game did not move
        assert after.state == before_state
        assert after.state.splitlines()[0] == "........."  # board still empty

    asyncio.run(flow())


@needs_core
def test_new_attaches_to_rooms_running_game(router_with_memory_store):
    router, store = router_with_memory_store

    async def flow():
        room = await store.create_room("AAAAAA")
        sa = await store.create_session("home-terminal", "dialup-300", None, room.code)
        sb = await store.create_session("home-terminal", "dialup-300", None, room.code)
        await router.handle(sa.id, "JOSHUA")
        await router.handle(sb.id, "JOSHUA")
        await router.handle(sa.id, "NEW tictactoe")
        result = await router.handle(sb.id, "NEW tictactoe")
        assert "IN PROGRESS" in result.text
        games = [g for g in store.games.values()
                 if g.game_id == "tictactoe" and g.status == "PLAYING"]
        assert len(games) == 1

    asyncio.run(flow())


@needs_core
def test_roomless_sessions_stay_isolated(router_with_memory_store):
    router, store = router_with_memory_store

    async def flow():
        sa = await store.create_session("home-terminal", "dialup-300", None)
        sb = await store.create_session("home-terminal", "dialup-300", None)
        await router.handle(sa.id, "JOSHUA")
        await router.handle(sb.id, "JOSHUA")
        await router.handle(sa.id, "NEW tictactoe")
        result = await router.handle(sb.id, "STATUS")
        assert "IDLE" in result.text  # B has no game; A's is not shared

    asyncio.run(flow())


@needs_core
def test_move_does_not_resurrect_game_that_ended_while_lock_was_held():
    """If the room's game ends while a move is parked on the room lock, the
    move must NOT apply to the state it was queued against (which would upsert
    a finished game back to PLAYING)."""
    store = MemoryStore()
    router = make_router(store, locks=SignalingRoomLocks())

    async def flow():
        room = await store.create_room("AAAAAA")
        sa = await store.create_session("home-terminal", "dialup-300", None, room.code)
        sb = await store.create_session("norad-terminal", "leased-9600", None, room.code)
        await router.handle(sa.id, "JOSHUA")
        await router.handle(sb.id, "JOSHUA")
        await router.handle(sa.id, "NEW tictactoe")
        await router.handle(sb.id, "NEW tictactoe")  # B joins the room's game

        # Hold the room lock so B's move parks on it while we end the game
        # underneath it.
        lock = router.locks.lock(room_key(room.code))
        await lock.acquire()
        move_task = asyncio.create_task(router.handle(sb.id, "5"))
        # let the move reach the lock wait
        await asyncio.wait_for(lock.contended.wait(), 1.0)

        game = await store.get_latest_game("tictactoe", room.code)
        game.status = "QUIT"
        await store.upsert_game(game)
        lock.release()

        result = await move_task
        # Deliberate change: the line no longer falls through to Joshua when
        # there is no game to move. The terminal is attached, so the monitor
        # answers for the game that vanished and detaches it.
        assert result.route == "bridge"
        assert result.text == "NO GAME IN PROGRESS."
        assert await store.get_latest_game(None, room.code) is None  # not resurrected
        assert store.games[sa.id].status == "QUIT"  # not flipped back to PLAYING
        assert store.games[sa.id].turn == 0         # and not advanced by the move

    asyncio.run(flow())


@needs_core
def test_quit_does_not_clobber_concurrent_tick_under_room_lock():
    """QUIT re-reads state inside the room lock: if a concurrent tick (e.g.
    the GTW hub, holding the lock) advances state/turn while QUIT's move is
    queued on the pre-lock snapshot, QUIT's upsert must not clobber that
    advance with its stale copy — only the status should flip to QUIT."""
    store = MemoryStore()
    router = make_router(store, locks=SignalingRoomLocks())

    async def flow():
        room = await store.create_room("AAAAAA")
        sa = await store.create_session("home-terminal", "dialup-300", None, room.code)
        await router.handle(sa.id, "JOSHUA")
        await router.handle(sa.id, "NEW tictactoe")

        # Hold the room lock so QUIT's pre-lock active-game snapshot goes
        # stale while a concurrent tick mutates state underneath it.
        lock = router.locks.lock(room_key(room.code))
        await lock.acquire()
        quit_task = asyncio.create_task(router.handle(sa.id, "QUIT"))
        # let the QUIT reach the lock wait
        await asyncio.wait_for(lock.contended.wait(), 1.0)

        game = await store.get_latest_game("tictactoe", room.code)
        game.state = "ADVANCED STATE"
        game.turn = 99
        await store.upsert_game(game)
        lock.release()

        result = await quit_task
        assert "TERMINATED" in result.text
        # QUIT'd games aren't PLAYING anymore, so read the raw record.
        final = store.games[sa.id]
        assert final.status == "QUIT"
        assert final.state == "ADVANCED STATE"  # tick's write wasn't clobbered
        assert final.turn == 99

    asyncio.run(flow())


@needs_core
def test_attach_query_core_failures_are_graceful():
    """The attach-path QUERY in _new_game must catch core failures like the
    sibling NEW call does — no exception may escape router.handle."""
    catalog = load_catalog(GAMES_DIR)

    class FailQueryRunner(CoreRunner):
        exc: Exception | None = None

        async def run(self, game_id, command, state=None, move=None, timeout_s=None,
                      interp_dir=None):
            if command == "QUERY" and self.exc is not None:
                raise self.exc
            return await super().run(game_id, command, state, move, timeout_s=timeout_s)

    for exc, expected in ((CoreBusy("core queue full"), CORE_BUSY_TEXT),
                          (CoreTimeout("queued too long"), CORE_TIMEOUT_TEXT)):
        store = MemoryStore()
        runner = FailQueryRunner(RunnerConfig(bin_dir=REAL_BIN))
        joshua = ScriptedJoshua({g.id: g.title for g in catalog.values()
                                 if g.status == "implemented"})
        router = Router(runner, store, {"scripted": joshua}, catalog)

        async def flow():
            room = await store.create_room("AAAAAA")
            sa = await store.create_session("home-terminal", "dialup-300", None, room.code)
            sb = await store.create_session("home-terminal", "dialup-300", None, room.code)
            await router.handle(sa.id, "JOSHUA")
            await router.handle(sb.id, "JOSHUA")
            await router.handle(sa.id, "NEW tictactoe")
            runner.exc = exc
            result = await router.handle(sb.id, "NEW tictactoe")
            assert expected in result.text

        asyncio.run(flow())


def test_new_game_core_busy_gets_in_world_line():
    """A busy core on NEW must answer with the same in-character line
    _core_move uses (CORE_BUSY_TEXT), not a bare ERROR: dump (#44)."""
    catalog = load_catalog(GAMES_DIR)

    class BusyRunner(CoreRunner):
        async def run(self, game_id, command, state=None, move=None, timeout_s=None,
                      interp_dir=None):
            raise CoreBusy("core queue full")

    store = MemoryStore()
    joshua = ScriptedJoshua({g.id: g.title for g in catalog.values()
                             if g.status == "implemented"})
    router = Router(BusyRunner(RunnerConfig(bin_dir=REAL_BIN)), store, {"scripted": joshua}, catalog)

    async def flow():
        sid = await new_session(store)
        await logon_as_joshua(router, sid)
        r = await router.handle(sid, "NEW tictactoe")
        assert r.text == CORE_BUSY_TEXT
        assert r.detail.get("error") == "busy"

    asyncio.run(flow())


def test_joshua_session_cap_defers_in_world():
    store = MemoryStore()
    catalog = load_catalog(GAMES_DIR)
    runner = CoreRunner(RunnerConfig(bin_dir=REAL_BIN))
    joshua = ScriptedJoshua({})
    router = Router(runner, store, {"scripted": joshua}, catalog, joshua_session_cap=2)

    async def flow():
        sid = await new_session(store)
        await logon_as_joshua(router, sid)
        await router.handle(sid, "HELLO")
        await router.handle(sid, "HELLO")
        r = await router.handle(sid, "HELLO")
        assert r.detail.get("capped") is True
        assert "RESOURCES EXHAUSTED" in r.text

    asyncio.run(flow())


from app.operators import parse_roster
from app.router import ACCESS_CODE_PROMPT, LOGON_LOCK_LIMIT, UNRECOGNIZED_DIRECTIVE

ROSTER = parse_roster("NORAD-3:TIGERTEAM:3,NORAD-1:CRYSTALPALACE:1")


async def norad_session(store: MemoryStore, room: str | None = None) -> str:
    s = await store.create_session("norad-terminal", "leased-9600", None, room)
    return s.id


async def logon_as_operator(router, store, callsign="NORAD-3", code="TIGERTEAM",
                            room: str | None = None) -> str:
    sid = await norad_session(store, room)
    r = await router.handle(sid, f"LOGON {callsign}")
    assert r.text == ACCESS_CODE_PROMPT
    r = await router.handle(sid, code)
    assert r.text.startswith(f"CLEARANCE ACCEPTED - {callsign} LEVEL")
    return sid


def test_operator_logon_happy_path_stamps_session():
    store = MemoryStore()
    router = make_router(store, operators=ROSTER)

    async def flow():
        sid = await logon_as_operator(router, store)
        s = await store.get_session(sid)
        assert s.user_id == "NORAD-3"
        assert await store.get_clearance_level("NORAD-3") == 3

    asyncio.run(flow())


def test_operator_logon_wrong_code_rejects_and_three_strikes_locks():
    store = MemoryStore()
    router = make_router(store, operators=ROSTER)

    async def flow():
        sid = await norad_session(store)
        for _ in range(3):
            r = await router.handle(sid, "LOGON NORAD-3")
            assert r.text == ACCESS_CODE_PROMPT
            r = await router.handle(sid, "WRONGCODE")
            assert r.text == LOGON_REJECTION
        # locked: even the right callsign is now rejected outright
        r = await router.handle(sid, "LOGON NORAD-3")
        assert r.text == LOGON_REJECTION
        assert (await store.get_session(sid)).user_id is None

    asyncio.run(flow())


def test_operator_logon_unknown_callsign_and_home_terminal_unchanged():
    store = MemoryStore()
    router = make_router(store, operators=ROSTER)

    async def flow():
        sid = await norad_session(store)
        r = await router.handle(sid, "LOGON NOBODY")
        assert r.text == LOGON_REJECTION
        # home terminal: known callsign still rejects (byte-identical today)
        home = await new_session(store)
        r = await router.handle(home, "LOGON NORAD-3")
        assert r.text == LOGON_REJECTION
        r = await router.handle(home, "LOGON")
        assert r.text == LOGON_REJECTION
        # backdoor untouched on both surfaces
        await logon_as_joshua(router, home)
        sid2 = await norad_session(store)
        r = await router.handle(sid2, "LOGON JOSHUA")
        assert r.text == "GREETINGS PROFESSOR FALKEN."

    asyncio.run(flow())


def test_access_code_is_redacted_in_event_log():
    store = MemoryStore()
    router = make_router(store, operators=ROSTER)

    async def flow():
        await logon_as_operator(router, store)
        texts = [e["payload"].get("text", "") for e in store.events
                 if e["kind"] == "input"]
        assert "TIGERTEAM" not in texts
        assert "[REDACTED]" in texts
        # the code appears in NO event payload of any kind
        assert "TIGERTEAM" not in str(store.events)

    asyncio.run(flow())


def test_empty_roster_norad_logon_rejects_like_today():
    store = MemoryStore()
    router = make_router(store)  # no operators

    async def flow():
        sid = await norad_session(store)
        r = await router.handle(sid, "LOGON NORAD-3")
        assert r.text == LOGON_REJECTION

    asyncio.run(flow())


def test_backdoor_during_pending_logon_clears_pending_state():
    store = MemoryStore()
    router = make_router(store, operators=ROSTER)

    async def flow():
        sid = await norad_session(store)
        r = await router.handle(sid, "LOGON NORAD-3")
        assert r.text == ACCESS_CODE_PROMPT
        r = await router.handle(sid, "JOSHUA")
        assert r.text == "GREETINGS PROFESSOR FALKEN."
        # next command must NOT be swallowed as an access-code attempt
        r = await router.handle(sid, "LIST GAMES")
        assert "GLOBAL THERMONUCLEAR WAR" in r.text
        # and it must have been logged as itself, not [REDACTED]
        texts = [e["payload"].get("text", "") for e in store.events if e["kind"] == "input"]
        assert "LIST GAMES" in texts

    asyncio.run(flow())


def test_operator_console_joshua_abandons_pending_logon_without_a_strike():
    """The carve-out proven at the front door by
    test_backdoor_during_pending_logon_clears_pending_state must also hold
    from the console: LOGON is reserved and reaches _pending_logon from every
    mode now, so JOSHUA against a pending access-code prompt must abandon it
    there too, not spend one of the three strikes."""
    store = MemoryStore()
    router = make_router(store, operators=ROSTER)

    async def flow():
        sid = await logon_as_operator(router, store)  # NORAD_OPS, not front door
        r = await router.handle(sid, "LOGON NORAD-1")
        assert r.text == ACCESS_CODE_PROMPT
        r = await router.handle(sid, "JOSHUA")
        assert r.text == "GREETINGS PROFESSOR FALKEN."

        # Two REAL wrong-code strikes. If the abandonment above had also
        # spent one, this would already be the third and the roster would
        # lock here; it must still take a genuine third failure.
        for _ in range(LOGON_LOCK_LIMIT - 1):
            r = await router.handle(sid, "LOGON NORAD-3")
            assert r.text == ACCESS_CODE_PROMPT
            r = await router.handle(sid, "WRONGCODE")
            assert r.text == LOGON_REJECTION
        r = await router.handle(sid, "LOGON NORAD-3")
        assert r.text == ACCESS_CODE_PROMPT  # not yet locked

    asyncio.run(flow())


def test_operator_without_backdoor_can_list_games():
    # Narrowed from "…can_use_game_verbs": E11 took NEW off the operator
    # console, and LIST GAMES is the only game verb this test ever exercised.
    store = MemoryStore()
    router = make_router(store, operators=ROSTER)

    async def flow():
        sid = await logon_as_operator(router, store)
        r = await router.handle(sid, "LIST GAMES")
        assert r.route == "bridge"
        assert "GLOBAL THERMONUCLEAR WAR" in r.text

    asyncio.run(flow())


def test_sitrep_reports_defcon_sim_room_link():
    store = MemoryStore()
    router = make_router(store, operators=ROSTER)

    async def flow():
        sid = await logon_as_operator(router, store)
        r = await router.handle(sid, "SITREP")
        assert r.route == "bridge"
        lines = r.text.splitlines()
        assert lines[0] == "SITREP NORAD-3 LEVEL 3"
        assert lines[1] == "DEFCON 5"
        assert lines[2] == "SIMULATION: IDLE"
        assert lines[3] == "CONFERENCE: NONE"
        assert lines[4] == "LINK: LEASED-9600"

    asyncio.run(flow())


def test_set_defcon_clearance_boundary():
    store = MemoryStore()
    router = make_router(store, operators=ROSTER)

    async def flow():
        sid = await logon_as_operator(router, store)  # NORAD-3, level 3
        r = await router.handle(sid, "SET DEFCON 3")
        assert r.text == "DEFCON 3 SET"
        assert (await store.get_session(sid)).defcon == 3
        r = await router.handle(sid, "SET DEFCON 2")   # below the floor
        assert r.text == "CLEARANCE DENIED"
        assert (await store.get_session(sid)).defcon == 3
        top = await logon_as_operator(router, store, "NORAD-1", "CRYSTALPALACE")
        r = await router.handle(top, "SET DEFCON 1")
        assert r.text == "DEFCON 1 SET"

    asyncio.run(flow())


def test_events_lists_recent_session_log_lines():
    store = MemoryStore()
    router = make_router(store, operators=ROSTER)

    async def flow():
        sid = await logon_as_operator(router, store)
        await router.handle(sid, "SITREP")
        r = await router.handle(sid, "EVENTS")
        assert r.route == "bridge"
        assert len(r.text.splitlines()) <= 10
        assert "INPUT" in r.text
        assert "TIGERTEAM" not in r.text  # redaction holds through EVENTS

    asyncio.run(flow())


def test_operator_tier_gating():
    store = MemoryStore()
    router = make_router(store, operators=ROSTER)

    async def flow():
        # pre-logon on norad: rejected
        sid = await norad_session(store)
        r = await router.handle(sid, "SITREP")
        assert r.text == LOGON_REJECTION
        # backdoor-only home session: SITREP falls through to Joshua, not the tier
        home = await new_session(store)
        await logon_as_joshua(router, home)
        r = await router.handle(home, "SITREP")
        assert r.route == "joshua"
        # operator without backdoor: unknown input is terse, never Joshua
        op = await logon_as_operator(router, store)
        r = await router.handle(op, "WHAT IS THE MEANING OF LIFE")
        assert r.text == UNRECOGNIZED_DIRECTIVE
        assert r.route == "bridge"

    asyncio.run(flow())


@needs_core
def test_falkens_maze_routes_moves_to_core():
    store = MemoryStore()
    router = make_router(store)

    async def flow():
        sid = await new_session(store)
        await logon_as_joshua(router, sid)
        r = await router.handle(sid, "NEW falkens-maze")
        assert "ENTRANCE HALL" in r.text
        # The seed-1983 maze opens EAST from the entrance; a walled direction
        # refuses in-game (never an error frame), then EAST walks.
        r = await router.handle(sid, "NORTH")
        assert r.route == "core"
        assert "A WALL BLOCKS YOUR WAY NORTH." in r.text
        r = await router.handle(sid, "EAST")
        assert r.route == "core"
        assert "YOU WALK EAST." in r.text
        assert (await store.get_active_game(sid)) is not None

    asyncio.run(flow())


def test_tracks_without_war_reports_no_active_tracks():
    store = MemoryStore()
    router = make_router(store, operators=ROSTER)

    async def flow():
        sid = await logon_as_operator(router, store)
        r = await router.handle(sid, "TRACKS")
        assert r.text == "NO ACTIVE TRACKS"

    asyncio.run(flow())


@needs_core
def test_tracks_with_live_gtw_renders_table():
    """The film's arrangement: the war runs on someone else's terminal and the
    NORAD console watches it. The operator console never attaches to a game
    (spec E11), so the war it reads is the room's, not its own."""
    store = MemoryStore()
    router = make_router(store, operators=ROSTER)

    async def flow():
        room = await store.create_room("AAAAAA")
        player = await store.create_session("home-terminal", "dialup-300", None, room.code)
        await logon_as_joshua(router, player.id)
        r = await router.handle(player.id, "NEW GTW")
        assert "GLOBAL THERMONUCLEAR WAR" in r.text.upper()

        sid = await logon_as_operator(router, store, room=room.code)
        r = await router.handle(sid, "TRACKS")
        assert r.text.startswith("TACTICAL TRACKS  ZULU ")
        assert r.detail.get("game") == "gtw"
        # Watching cost the console nothing: it is still in NORAD ops, and its
        # own instruments still answer with the war running.
        assert router.attachment(sid).mode == NORAD_OPS
        assert (await router.handle(sid, "SITREP")).text.splitlines()[2] == \
            "SIMULATION: GTW TURN 0"
        assert (await router.handle(sid, "SET DEFCON 3")).text == "DEFCON 3 SET"

    asyncio.run(flow())
