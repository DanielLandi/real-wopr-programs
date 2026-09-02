"""Game catalog from manifests (docs/games.md §3-4). Placeholders are listed
but report NOT YET IMPLEMENTED when selected — they never block the build."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

# The canonical recitation order (docs/games.md §4) — the film's scrolling list.
CATALOG_ORDER = [
    "falkens-maze", "blackjack", "gin-rummy", "hearts", "bridge", "checkers",
    "chess", "poker", "fighter-combat", "guerilla", "desert-warfare",
    "air-to-ground", "theater-tactical", "theater-biotoxic", "tictactoe", "gtw",
]

# Playable but never recited: the film's scrolling list does not include
# tic-tac-toe — David types it directly in the finale (#40).
UNLISTED = frozenset({"tictactoe"})

PLACEHOLDER_TITLES = {
    "falkens-maze": "FALKEN'S MAZE",
    "blackjack": "BLACK JACK",
    "gin-rummy": "GIN RUMMY",
    "hearts": "HEARTS",
    "bridge": "BRIDGE",
    "checkers": "CHECKERS",
    "chess": "CHESS",
    "poker": "POKER",
    "fighter-combat": "FIGHTER COMBAT",
    # GUERILLA, one R: the film's screen spelling, kept as the film spells
    # it under the INDENTIFICATION precedent (real-wopr#199, and the
    # 2026-08-03 ceiling-change row that settled the principle — a corrected
    # copy of an on-screen string is a transcription error, not fidelity).
    # The slot id follows the title so a visitor can type what they read.
    "guerilla": "GUERILLA ENGAGEMENT",
    "desert-warfare": "DESERT WARFARE",
    "air-to-ground": "AIR-TO-GROUND ACTIONS",
    "theater-tactical": "THEATERWIDE TACTICAL WARFARE",
    "theater-biotoxic": "THEATERWIDE BIOTOXIC AND CHEMICAL WARFARE",
    "tictactoe": "TIC-TAC-TOE",
    "gtw": "GLOBAL THERMONUCLEAR WAR",
}


@dataclass(frozen=True)
class Interpretation:
    """One reconstruction of a title (docs/games.md §8)."""
    name: str
    author: str


@dataclass(frozen=True)
class Game:
    id: str
    title: str
    status: str  # implemented | placeholder
    players: int
    summary: str
    input_syntax: str
    timeout_s: float | None = None  # optional manifest override, capped (deployment.md D2)
    self_resolving: bool = False  # engine resolves all non-human seats in the
    # human's MOVE; the bridge must never fire the inputless follow-up MOVE.
    abbrev: str = ""  # short label for the prompt ("TTT"); empty => use the id
    interpretations: tuple[Interpretation, ...] = ()  # empty = flat slot (§8)


def _game_from_manifest(m: dict, interpretations: tuple[Interpretation, ...]) -> Game:
    timeout = m.get("timeout_s")
    if timeout is not None:
        timeout = min(float(timeout), 10.0)  # hard cap per D2
    return Game(
        id=m["id"], title=m["title"].upper(), status=m["status"],
        players=m.get("players", 2), summary=m.get("summary", ""),
        input_syntax=m.get("input_syntax", ""), timeout_s=timeout,
        self_resolving=bool(m.get("self_resolving", False)),
        abbrev=m.get("abbrev", ""),
        interpretations=interpretations,
    )


def _nested_game(game_id: str, games_dir: Path, sub_manifests: list[Path]) -> Game:
    """A converted slot: games/<id>/<interpretation>/, each a complete program.

    The slot's catalog entry is built from the core manifest — core is the
    default everywhere (§8) — and every sub-manifest must agree on the slot's
    identity, or the catalog refuses to load at all: a half-converted slot is
    a startup error, never a play-time surprise.
    """
    by_name: dict[str, tuple[dict, Interpretation]] = {}
    for man in sub_manifests:
        dir_name = man.parent.parent.name
        m = json.loads(man.read_text())
        if m.get("id") != game_id or m.get("interpretation") != dir_name or not m.get("author"):
            raise ValueError(
                f"nested slot {game_id!r}: manifest under {dir_name!r} must carry "
                f"id={game_id!r}, interpretation={dir_name!r}, and an author")
        by_name[dir_name] = (m, Interpretation(name=dir_name, author=m["author"]))
    if "core" not in by_name:
        raise ValueError(f"nested slot {game_id!r} has no core/ interpretation")
    ordered = ("core", *sorted(n for n in by_name if n != "core"))
    core_manifest = by_name["core"][0]
    return _game_from_manifest(
        core_manifest, tuple(by_name[n][1] for n in ordered))


def load_catalog(games_dir: Path) -> dict[str, Game]:
    """Manifests define implemented games; everything else in CATALOG_ORDER is
    a placeholder. A slot is nested (§8) when its harness has moved down into
    per-interpretation subdirectories."""
    catalog: dict[str, Game] = {}
    for game_id in CATALOG_ORDER:
        manifest = games_dir / game_id / "harness" / "manifest.json"
        subs = sorted((games_dir / game_id).glob("*/harness/manifest.json"))
        if manifest.exists():
            catalog[game_id] = _game_from_manifest(json.loads(manifest.read_text()), ())
        elif subs:
            catalog[game_id] = _nested_game(game_id, games_dir, subs)
        else:
            catalog[game_id] = Game(
                id=game_id, title=PLACEHOLDER_TITLES[game_id], status="placeholder",
                players=2, summary="", input_syntax="",
            )
    return catalog


def match_slot(catalog: dict[str, Game], arg: str) -> Game | None:
    """A LIST/NEW argument names a slot by id or exact title, either case."""
    a = arg.strip().upper()
    game = catalog.get(a.lower())
    if game is not None:
        return game
    for g in catalog.values():
        if g.title == a:
            return g
    return None


def _effective(game: Game) -> tuple[Interpretation, ...]:
    # A flat slot behaves as a single core interpretation (§8).
    return game.interpretations or (Interpretation(name="core", author="core"),)


def resolve_selector(game: Game, sel: str) -> str | None:
    """`<TITLE> <n>` / name / author -> interpretation name; None = invalid."""
    s = sel.strip().upper()
    interps = _effective(game)
    if s.isdigit():
        n = int(s)
        return interps[n - 1].name if 1 <= n <= len(interps) else None
    for i in interps:
        if s in (i.name.upper(), i.author.upper()):
            return i.name
    return None


def list_interpretations_text(game: Game) -> str:
    """The `LIST <TITLE>` answer — the one door into the alternatives (§8)."""
    lines = [game.title]
    for n, i in enumerate(_effective(game), start=1):
        label = i.name.upper()
        if i.author.upper() != label:
            label += f" - {i.author.upper()}"
        lines.append(f"{n}. {label}")
    return "\n".join(lines)


def interpretation_dir(game: Game, pin: str) -> str | None:
    """The runner's subdirectory for a pinned game row: None = flat layout.

    A pin naming a vanished interpretation is a loud KeyError — never a
    silent fallback to a binary that did not write this STATE (§8).
    """
    if not game.interpretations:
        return None
    if pin not in {i.name for i in game.interpretations}:
        raise KeyError(pin)
    return pin


def list_games_text(catalog: dict[str, Game]) -> str:
    """The in-world LIST GAMES output — the film's recitation, ending on
    GLOBAL THERMONUCLEAR WAR. UNLISTED slots stay startable but unrecited."""
    lines = [catalog[g].title for g in CATALOG_ORDER
             if g != "gtw" and g not in UNLISTED]
    lines += ["", catalog["gtw"].title]
    return "\n".join(lines)
