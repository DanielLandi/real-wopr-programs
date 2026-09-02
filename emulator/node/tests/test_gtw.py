"""GTW-specific bridge tests: feed adapter + routing + convergence through
the real binary (games.md §6)."""

import asyncio
import json
from pathlib import Path

import pytest

from app.games import load_catalog
from app.gtwfeed import FEED_PREFIX, display_to_feed, feed_line, tracks_text
from app.gtwhub import GtwRoomHub
from app.joshua import ScriptedJoshua
from app.rooms import RoomLocks, room_key
from app.router import IMPROPER_REQUEST, Router
from app.runner import CoreBusy, CoreRunner, RunnerConfig
from app.store import GLOBAL_ROOM_KEY, GameState, MemoryStore
from app.wire import CoreResponse

REPO = Path(__file__).resolve().parent.parent.parent.parent
REAL_BIN = REPO / "games"
GAMES_DIR = REPO / "games"

needs_core = pytest.mark.skipif(
    not (REAL_BIN / "gtw" / "harness" / "bin" / "gtw").exists(),
    reason="core not built (run tools/import-programs.sh)",
)

# Manifest-only catalog entry (no built binary needed) so hub tests can run
# without needs_core — the hub only reads catalog[...].timeout_s.
CATALOG = {"gtw": load_catalog(GAMES_DIR)["gtw"]}


class CountingFakeRunner:
    """Fake CoreRunner: always succeeds, counts .run() invocations so tests
    can assert the hub ticks once per interval, not once per subscriber."""

    def __init__(self) -> None:
        self.calls = 0

    async def run(self, game_id, command, state, move, timeout_s=None,
                  interp_dir=None) -> CoreResponse:
        self.calls += 1
        return CoreResponse(game_id=game_id, state=state or "STATE",
                            display="ZULU 00:00  DEFCON 5", status="PLAYING", result=None)


class FlakyFirstCallRunner:
    """Fake CoreRunner: raises CoreBusy on the first call, then succeeds."""

    def __init__(self) -> None:
        self.calls = 0

    async def run(self, game_id, command, state, move, timeout_s=None,
                  interp_dir=None) -> CoreResponse:
        self.calls += 1
        if self.calls == 1:
            raise CoreBusy("core queue full")
        return CoreResponse(game_id=game_id, state=state or "STATE",
                            display="ZULU 00:00  DEFCON 5", status="PLAYING", result=None)

SAMPLE_DISPLAY = """ZULU 00:12  DEFCON 2
UNITED STATES  ARSENAL 20  CITIES LOST 1
SOVIET UNION   ARSENAL 19  CITIES LOST 2
TRK WASHINGTON MOSCOW -77 39 37 56 0.40
TRK MOSCOW WASHINGTON 37 56 -77 39 0.10
HIT LENINGRAD"""


def test_display_to_feed_parses_telemetry():
    feed = display_to_feed(SAMPLE_DISPLAY, "PLAYING")
    assert feed["defcon"] == 2
    assert feed["clock"] == "00:12"
    assert feed["phase"] == "running"
    assert feed["targets"] == 3
    assert feed["status"] == "PLAYING"
    assert feed["missiles"] == [
        {"from": [-77, 39], "to": [37, 56], "progress": 0.40},
        {"from": [37, 56], "to": [-77, 39], "progress": 0.10},
    ]
    assert feed["aircraft"] == [
        {"id": "B-52-01", "side": "US", "from": [-100, 42], "to": [37, 56], "progress": 0.20},
        {"id": "BEAR-01", "side": "SU", "from": [50, 55], "to": [-77, 39], "progress": 0.20},
    ]
    assert feed["ships"] == [
        {"id": "CVN-01", "side": "US", "from": [-160, 25], "to": [-145, 42], "progress": 0.20},
        {"id": "KIEV-01", "side": "SU", "from": [35, 70], "to": [-20, 65], "progress": 0.20},
    ]
    assert feed["targetStates"] == [
        {"name": "LENINGRAD", "side": "SU", "position": [30, 60], "status": "hit"},
    ]
    assert feed["events"] == ["HIT LENINGRAD"]
    assert feed["impact"] == "18 MIN"  # soonest = 1-0.40 => 0.6*30


def test_feed_line_round_trips_as_json():
    line = feed_line(SAMPLE_DISPLAY, "PLAYING")
    assert line.startswith(FEED_PREFIX)
    assert json.loads(line[len(FEED_PREFIX):])["type"] == "gtw_state"


def test_peace_display_has_no_missiles_or_impact():
    feed = display_to_feed("ZULU 00:00  DEFCON 5\nUNITED STATES  ARSENAL 24  CITIES LOST 0", "PLAYING")
    assert feed["missiles"] == [] and feed["impact"] is None and feed["defcon"] == 5


@needs_core
def test_gtw_full_flow_the_films_play():
    """The film's exact play (fidelity-notes.md §2): side 2 = SOVIET UNION,
    targets LAS VEGAS + SEATTLE, exchange converges, montage + chess coda."""
    store = MemoryStore()
    catalog = load_catalog(GAMES_DIR)
    runner = CoreRunner(RunnerConfig(bin_dir=REAL_BIN))
    router = Router(runner, store, {"scripted": ScriptedJoshua({})}, catalog)

    async def flow():
        s = await store.create_session("norad-terminal", "leased-9600", None)
        await router.handle(s.id, "JOSHUA")
        started = await router.handle(s.id, "NEW gtw")
        assert "GLOBAL THERMONUCLEAR WAR" in started.text
        assert "WHICH SIDE DO YOU WANT?" in started.text

        r = await router.handle(s.id, "2")
        assert r.route == "core"
        assert "SOVIET UNION" in r.text
        assert "PLEASE LIST PRIMARY TARGETS" in r.text

        r = await router.handle(s.id, "LASVEGAS SEATTLE")
        assert r.route == "core"
        assert "TRK" in r.text  # telemetry present for observers

        r = await router.handle(s.id, "MAP")
        assert r.route == "core"
        assert "STRATEGIC MAP" in r.text

        # Let the exchange run: the ONLY terminal status is NO-WIN, and the
        # terminal response carries the scenario sweep + the chess coda.
        last = r
        for _ in range(80):
            game = await store.get_active_game(s.id)
            if game is None:
                break
            last = await router.handle(s.id, "OBSERVE")
        final = store.games[s.id]
        assert final.status == "NO-WIN"
        assert "GABON REBELLION" in last.text          # the montage ran
        assert "WINNER: NONE" in last.text
        # The verdict reaches the teletype in the film's three-line break —
        # the wire RESULT is still the single canonical sentence.
        assert ("A STRANGE GAME.\nTHE ONLY WINNING MOVE IS\nNOT TO PLAY."
                in last.text)
        assert "THE ONLY WINNING MOVE IS NOT TO PLAY." not in last.text
        assert "HOW ABOUT A NICE GAME OF CHESS?" in last.text

    asyncio.run(flow())


def test_latest_game_can_be_scoped_by_room():
    store = MemoryStore()

    async def flow():
        a = await store.create_room("AAAAAA")
        b = await store.create_room("BBBBBB")
        sa = await store.create_session("home-terminal", "dialup-300", None, a.code)
        sb = await store.create_session("home-terminal", "dialup-300", None, b.code)
        await store.upsert_game(GameState(sa.id, "gtw", "STATE A", "PLAYING", 1))
        await store.upsert_game(GameState(sb.id, "gtw", "STATE B", "PLAYING", 1))
        assert (await store.get_latest_game("gtw", "AAAAAA")).state == "STATE A"
        assert (await store.get_latest_game("gtw", "BBBBBB")).state == "STATE B"
        assert (await store.get_latest_game("gtw")).state == "STATE B"
        assert (await store.get_latest_game(None, "AAAAAA")).state == "STATE A"

    asyncio.run(flow())


def test_latest_game_follows_updates_not_insertion():
    store = MemoryStore()

    async def flow():
        s1 = await store.create_session("home-terminal", "dialup-300", None)
        s2 = await store.create_session("home-terminal", "dialup-300", None)
        await store.upsert_game(GameState(s1.id, "gtw", "OLD 1", "PLAYING", 1))
        await store.upsert_game(GameState(s2.id, "gtw", "NEW 2", "PLAYING", 1))
        await store.upsert_game(GameState(s1.id, "gtw", "NEWER 1", "PLAYING", 2))
        assert (await store.get_latest_game("gtw")).state == "NEWER 1"

    asyncio.run(flow())


@needs_core
def test_gtw_bad_target_is_clean_error():
    store = MemoryStore()
    catalog = load_catalog(GAMES_DIR)
    runner = CoreRunner(RunnerConfig(bin_dir=REAL_BIN))
    router = Router(runner, store, {"scripted": ScriptedJoshua({})}, catalog)

    async def flow():
        s = await store.create_session("norad-terminal", "leased-9600", None)
        await router.handle(s.id, "JOSHUA")
        await router.handle(s.id, "NEW gtw")
        await router.handle(s.id, "1")
        r = await router.handle(s.id, "LAUNCH USSR:PORTLAND")
        # Clean means headed and unprefixed, not silent. #120 puts the film's
        # banner above the refusal and drops the "ERROR: " prefix, but the
        # game's own reason still prints — otherwise a player who mistypes a
        # city cannot tell why the machine refused.
        assert r.text.startswith(IMPROPER_REQUEST)
        assert "UNKNOWN TARGET" in r.text
        assert "ERROR:" not in r.text
        # game survives the bad input
        assert (await store.get_active_game(s.id)) is not None

    asyncio.run(flow())


def test_two_room_subscribers_get_same_frame_from_one_tick():
    store = MemoryStore()
    runner = CountingFakeRunner()          # counts .run() invocations
    hub = GtwRoomHub(store, runner, CATALOG, RoomLocks(), interval_s=0.01, idle_grace_s=0.05)

    async def flow():
        room = await store.create_room("AAAAAA")
        s = await store.create_session("home-terminal", "dialup-300", None, room.code)
        await store.upsert_game(GameState(s.id, "gtw", "STATE", "PLAYING", 1))

        async def first_frame(code):
            async for line in hub.subscribe(code):
                return line

        a, b = await asyncio.gather(first_frame("AAAAAA"), first_frame("AAAAAA"))
        assert a == b and a.startswith("GTW-FEED ")
        assert runner.calls <= 2  # one tick per interval, not per subscriber

    asyncio.run(flow())


def test_room_isolation():
    """A subscriber in an empty room gets no frames while another room's war runs."""
    store = MemoryStore()
    runner = CountingFakeRunner()
    hub = GtwRoomHub(store, runner, CATALOG, RoomLocks(), interval_s=0.01, idle_grace_s=0.05)

    async def flow():
        room_a = await store.create_room("AAAAAA")
        room_b = await store.create_room("BBBBBB")
        sa = await store.create_session("home-terminal", "dialup-300", None, room_a.code)
        await store.create_session("home-terminal", "dialup-300", None, room_b.code)
        await store.upsert_game(GameState(sa.id, "gtw", "STATE", "PLAYING", 1))

        async def first_frame(code):
            async for line in hub.subscribe(code):
                return line

        async def empty_room_times_out():
            with pytest.raises(TimeoutError):
                await asyncio.wait_for(first_frame("BBBBBB"), 0.05)

        a_line, _ = await asyncio.gather(first_frame("AAAAAA"), empty_room_times_out())
        assert a_line.startswith("GTW-FEED ")

    asyncio.run(flow())


def test_hub_prunes_room_bookkeeping_when_ticker_idles_out():
    """#44: _tasks already self-pruned when a room went idle, but _subs and
    _last_status grew forever under room churn — ticker teardown must clear
    all three so a busy exchange doesn't leak an entry per dead room."""
    store = MemoryStore()
    runner = CountingFakeRunner()
    hub = GtwRoomHub(store, runner, CATALOG, RoomLocks(), interval_s=0.01, idle_grace_s=0.02)

    async def flow():
        room = await store.create_room("AAAAAA")
        s = await store.create_session("home-terminal", "dialup-300", None, room.code)
        await store.upsert_game(GameState(s.id, "gtw", "STATE", "PLAYING", 1))

        async def first_frame(code):
            async for line in hub.subscribe(code):
                return line

        line = await asyncio.wait_for(first_frame("AAAAAA"), 1.0)
        assert line.startswith(FEED_PREFIX)
        # Subscriber is gone; wait out the idle grace so the ticker exits.
        for _ in range(300):
            if not hub._tasks:
                break
            await asyncio.sleep(0.01)
        assert hub._tasks == {}
        assert hub._subs == {}
        assert hub._last_status == {}

    asyncio.run(flow())


def test_room_key_and_global_room_key_agree():
    """rooms.room_key and store.GLOBAL_ROOM_KEY coin the '__global__' literal
    independently (federated modules, no shared constant). If they ever drift,
    the hub's lock key and its store lookup key desynchronize silently."""
    assert room_key(None) == GLOBAL_ROOM_KEY


def test_get_latest_game_global_room_key_matches_roomless_sessions():
    """__global__ is not a real room code: it means 'sessions with room_code
    is None'. A roomed game must never satisfy a __global__ lookup."""
    store = MemoryStore()

    async def flow():
        room = await store.create_room("AAAAAA")
        roomed = await store.create_session("home-terminal", "dialup-300", None, room.code)
        roomless = await store.create_session("home-terminal", "dialup-300", None)
        await store.upsert_game(GameState(roomed.id, "gtw", "ROOMED", "PLAYING", 1))
        await store.upsert_game(GameState(roomless.id, "gtw", "ROOMLESS", "PLAYING", 1))
        game = await store.get_latest_game("gtw", GLOBAL_ROOM_KEY)
        assert game.state == "ROOMLESS"

    asyncio.run(flow())


def test_global_ticker_does_not_advance_roomed_game():
    """The bug this branch fixes: a roomless subscriber's __global__ ticker
    used to call get_latest_game('gtw', None) = latest PLAYING game across
    ALL sessions, including roomed ones. That double-advanced a roomed war
    under two locks concurrently. A roomless subscriber must see nothing and
    the roomed game's turn must not move."""
    store = MemoryStore()
    runner = CountingFakeRunner()
    hub = GtwRoomHub(store, runner, CATALOG, RoomLocks(), interval_s=0.01, idle_grace_s=0.2)

    async def flow():
        room = await store.create_room("AAAAAA")
        s = await store.create_session("home-terminal", "dialup-300", None, room.code)
        await store.upsert_game(GameState(s.id, "gtw", "STATE", "PLAYING", 1))

        async def first_frame(code):
            async for line in hub.subscribe(code):
                return line

        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(first_frame(None), 0.05)

        # Let the __global__ ticker run a few more cycles before checking.
        await asyncio.sleep(0.05)
        assert store.games[s.id].turn == 1

    asyncio.run(flow())


def test_global_ticker_advances_roomless_game():
    """A roomless subscriber must still receive frames for a roomless war."""
    store = MemoryStore()
    runner = CountingFakeRunner()
    hub = GtwRoomHub(store, runner, CATALOG, RoomLocks(), interval_s=0.01, idle_grace_s=0.05)

    async def flow():
        s = await store.create_session("home-terminal", "dialup-300", None)  # no room
        await store.upsert_game(GameState(s.id, "gtw", "STATE", "PLAYING", 1))

        async def first_frame(code):
            async for line in hub.subscribe(code):
                return line

        line = await asyncio.wait_for(first_frame(None), 1.0)
        assert line.startswith("GTW-FEED ")

    asyncio.run(flow())


def test_repeated_hit_lines_dedupe_target_states():
    """Two missiles on one city are two HIT lines; targetStates must still
    carry one entry per city — the Big Board keys markers `<name>-<status>`,
    so duplicates collide as React keys (#53). The events history keeps
    every impact line."""
    display = "ZULU 00:30  DEFCON 1\nHIT SEATTLE\nHIT SEATTLE\nHIT MOSCOW"
    feed = display_to_feed(display, "PLAYING")
    assert [t["name"] for t in feed["targetStates"]] == ["SEATTLE", "MOSCOW"]
    assert feed["events"] == ["HIT SEATTLE", "HIT SEATTLE", "HIT MOSCOW"]


def test_latest_game_orders_by_updated_at_not_insertion():
    """PostgresStore orders get_latest_game by updated_at; MemoryStore must
    agree even where dict insertion order disagrees, or dev and prod pick
    different games (#52)."""
    store = MemoryStore()

    async def flow():
        s1 = await store.create_session("home-terminal", "dialup-300", None)
        s2 = await store.create_session("home-terminal", "dialup-300", None)
        await store.upsert_game(GameState(s1.id, "gtw", "FIRST", "PLAYING", 1))
        await store.upsert_game(GameState(s2.id, "gtw", "SECOND", "PLAYING", 1))
        assert store.games[s1.id].updated_at != ""  # upsert stamps recency
        # Simulate what Postgres's updated_at ordering would see: s1's row
        # carries the newer stamp even though s2 was (re)inserted later.
        store.games[s1.id].updated_at = "9999-01-01T00:00:00+00:00"
        assert (await store.get_latest_game("gtw")).state == "FIRST"

    asyncio.run(flow())


def test_latest_game_any_status_returns_terminal_game():
    """playing_only=False surfaces the room's finished war (#43); the
    default stays PLAYING-only so router attach/move checks are unchanged."""
    store = MemoryStore()

    async def flow():
        s = await store.create_session("norad-terminal", "leased-9600", None)
        await store.upsert_game(GameState(s.id, "gtw", "FINAL", "NO-WIN", 30))
        assert await store.get_latest_game("gtw") is None
        done = await store.get_latest_game("gtw", playing_only=False)
        assert done is not None and done.status == "NO-WIN" and done.state == "FINAL"

    asyncio.run(flow())


class TerminalWarRunner:
    """Fake CoreRunner for a war that is already over: QUERY renders the
    final frame; a MOVE call would mean the hub tried to advance a finished
    game, so record every command for the assertion."""

    def __init__(self) -> None:
        self.commands: list[str] = []

    async def run(self, game_id, command, state, move, timeout_s=None,
                  interp_dir=None) -> CoreResponse:
        self.commands.append(command)
        return CoreResponse(game_id=game_id, state=state or "STATE",
                            display="ZULU 01:06  DEFCON 1", status="NO-WIN", result=None)


def test_observer_gets_terminal_frame_after_war_ends():
    """A player move (router path) flips the game terminal between hub ticks;
    the next tick must serve the terminal frame — QUERY, never MOVE, and no
    upsert — instead of returning None forever and freezing the board (#43)."""
    store = MemoryStore()
    runner = TerminalWarRunner()
    hub = GtwRoomHub(store, runner, CATALOG, RoomLocks(), interval_s=0.01, idle_grace_s=0.05)

    async def flow():
        room = await store.create_room("AAAAAA")
        s = await store.create_session("norad-terminal", "leased-9600", None, room.code)
        await store.upsert_game(GameState(s.id, "gtw", "FINAL", "NO-WIN", 30))

        async def first_frame(code):
            async for line in hub.subscribe(code):
                return line

        line = await asyncio.wait_for(first_frame("AAAAAA"), 1.0)
        feed = json.loads(line[len(FEED_PREFIX):])
        assert feed["status"] == "NO-WIN"
        assert feed["phase"] == "no-win"
        assert set(runner.commands) == {"QUERY"}  # rendered, never advanced
        assert store.games[s.id].turn == 30       # nothing upserted

    asyncio.run(flow())


def test_core_busy_does_not_kill_ticker():
    """Runner raises CoreBusy on call 1, succeeds on call 2; subscriber still
    receives a frame (the ticker logs and continues)."""
    store = MemoryStore()
    runner = FlakyFirstCallRunner()
    hub = GtwRoomHub(store, runner, CATALOG, RoomLocks(), interval_s=0.01, idle_grace_s=0.05)

    async def flow():
        room = await store.create_room("AAAAAA")
        s = await store.create_session("home-terminal", "dialup-300", None, room.code)
        await store.upsert_game(GameState(s.id, "gtw", "STATE", "PLAYING", 1))

        async def first_frame(code):
            async for line in hub.subscribe(code):
                return line

        line = await asyncio.wait_for(first_frame("AAAAAA"), 1.0)
        assert line.startswith("GTW-FEED ")
        assert runner.calls >= 2  # the first CoreBusy tick was skipped, not fatal

    asyncio.run(flow())


def test_tracks_text_formats_air_sea_missiles_targets():
    display = ("ZULU 00:30  DEFCON 2\n"
               "UNITED STATES  ARSENAL 20  CITIES LOST 0\n"
               "SOVIET UNION   ARSENAL 19  CITIES LOST 1\n"
               "TRK WASHINGTON MOSCOW -77 39 37 56 0.40\n"
               "HIT LENINGRAD\n")
    text = tracks_text(display_to_feed(display, "PLAYING"))
    lines = text.splitlines()
    assert lines[0] == "TACTICAL TRACKS  ZULU 00:30  DEFCON 2"
    assert lines[1].split() == ["ID", "TYP", "SIDE", "FROM", "TO", "PROG"]
    assert any(ln.startswith("B-52-01") and " AC " in f" {ln} " for ln in lines)
    assert any(ln.startswith("CVN-01") for ln in lines)
    assert any(ln.startswith("MSL-01") and "0.40" in ln for ln in lines)
    assert any(ln.startswith("TARGETS: LENINGRAD HIT") for ln in lines)
    assert "HIT LENINGRAD" in text  # events tail


def test_tracks_text_quiet_board():
    text = tracks_text(display_to_feed("ZULU --:--  DEFCON 5\n", "PLAYING"))
    assert "NO TRACKS AIRBORNE" in text


@needs_core
def test_a_war_the_room_ended_still_reaches_the_player_with_its_verdict():
    """real-wopr#209: the room hub drives a simulation on its own ticks, so
    the war a terminal is attached to can reach NO-WIN between one typed line
    and the next. `_active_game` only reports a PLAYING row, so the finished
    one simply left the facts and the executive could not tell that from a
    game that never existed — the player's next line answered NO GAME IN
    PROGRESS. and the film's whole point went to the panel feed alone.

    ENDEDROW is what is left of the row, and the verdict is what the machine
    owes the player who was in that war. Asserted here on a real gtw core
    driven to its real terminal status, not on a hand-set row: NO-WIN has to
    be something the game actually reached."""
    store = MemoryStore()
    catalog = load_catalog(GAMES_DIR)
    runner = CoreRunner(RunnerConfig(bin_dir=REAL_BIN))
    router = Router(runner, store, {"scripted": ScriptedJoshua({})}, catalog)

    async def flow():
        room = await store.create_room("EVAL09")
        player = await store.create_session("home-terminal", "dialup-300", None, room.code)
        driver = await store.create_session("norad-terminal", "leased-9600", None, room.code)
        for s in (player, driver):
            await router.handle(s.id, "JOSHUA")
        await router.handle(player.id, "NEW gtw")
        await router.handle(player.id, "2")
        await router.handle(player.id, "LASVEGAS SEATTLE")
        # Somebody else in the room runs the war out. The player types nothing
        # while it happens, which is exactly the case E13 observes.
        await router.handle(driver.id, "NEW gtw")   # attach to the room's row
        for _ in range(80):
            if await store.get_latest_game(None, room.code) is None:
                break
            await router.handle(driver.id, "OBSERVE")
        ended = await store.get_latest_game(None, room.code, playing_only=False)
        assert ended is not None and ended.status == "NO-WIN"

        result = await router.handle(player.id, "OBSERVE")
        assert result.route == "bridge"
        assert ("A STRANGE GAME.\nTHE ONLY WINNING MOVE IS\nNOT TO PLAY."
                in result.text), result.text
        assert "HOW ABOUT A NICE GAME OF CHESS?" in result.text
        assert "NO GAME IN PROGRESS." not in result.text
        # ...and the terminal is let go, so the next line is Joshua's again.
        assert result.prompt != ""
        again = await router.handle(player.id, "OBSERVE")
        assert "A STRANGE GAME." not in again.text

    asyncio.run(flow())


@needs_core
def test_a_finished_game_with_no_verdict_still_says_there_is_none():
    """The other half of real-wopr#209: only NO-WIN has a verdict to speak.
    A room game that ended any other way leaves the player at NO GAME IN
    PROGRESS., which is the honest answer — a finished hand of hearts has no
    sentence the film ever put on a screen."""
    store = MemoryStore()
    catalog = load_catalog(GAMES_DIR)
    runner = CoreRunner(RunnerConfig(bin_dir=REAL_BIN))
    router = Router(runner, store, {"scripted": ScriptedJoshua({})}, catalog)

    async def flow():
        room = await store.create_room("EVAL10")
        player = await store.create_session("home-terminal", "dialup-300", None, room.code)
        await router.handle(player.id, "JOSHUA")
        await router.handle(player.id, "NEW gtw")
        row = await store.get_latest_game(None, room.code)
        row.status = "QUIT"
        await store.upsert_game(row)

        result = await router.handle(player.id, "OBSERVE")
        assert result.text == "NO GAME IN PROGRESS.", result.text

    asyncio.run(flow())
