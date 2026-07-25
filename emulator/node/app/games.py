"""Game catalog from manifests (docs/games.md §3-4). Placeholders are listed
but report NOT YET IMPLEMENTED when selected — they never block the build."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

# The canonical recitation order (docs/games.md §4) — the film's scrolling list.
CATALOG_ORDER = [
    "falkens-maze", "blackjack", "gin-rummy", "hearts", "bridge", "checkers",
    "chess", "poker", "fighter-combat", "guerrilla", "desert-warfare",
    "air-to-ground", "theater-tactical", "theater-biotoxic", "tictactoe", "gtw",
]

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
    "guerrilla": "GUERRILLA ENGAGEMENT",
    "desert-warfare": "DESERT WARFARE",
    "air-to-ground": "AIR-TO-GROUND ACTIONS",
    "theater-tactical": "THEATERWIDE TACTICAL WARFARE",
    "theater-biotoxic": "THEATERWIDE BIOTOXIC AND CHEMICAL WARFARE",
    "tictactoe": "TIC-TAC-TOE",
    "gtw": "GLOBAL THERMONUCLEAR WAR",
}


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
    move_pattern: str = ""  # anchored regex (from the manifest) deciding which
    # typed inputs are this game's moves vs. chat; empty => no in-game routing.


def load_catalog(games_dir: Path) -> dict[str, Game]:
    """Manifests define implemented games; everything else in CATALOG_ORDER is
    a placeholder."""
    catalog: dict[str, Game] = {}
    for game_id in CATALOG_ORDER:
        manifest = games_dir / game_id / "harness" / "manifest.json"
        if manifest.exists():
            m = json.loads(manifest.read_text())
            timeout = m.get("timeout_s")
            if timeout is not None:
                timeout = min(float(timeout), 10.0)  # hard cap per D2
            catalog[game_id] = Game(
                id=m["id"], title=m["title"].upper(), status=m["status"],
                players=m.get("players", 2), summary=m.get("summary", ""),
                input_syntax=m.get("input_syntax", ""), timeout_s=timeout,
                self_resolving=bool(m.get("self_resolving", False)),
                move_pattern=m.get("move_pattern", ""),
            )
        else:
            catalog[game_id] = Game(
                id=game_id, title=PLACEHOLDER_TITLES[game_id], status="placeholder",
                players=2, summary="", input_syntax="",
            )
    return catalog


def list_games_text(catalog: dict[str, Game]) -> str:
    """The in-world LIST GAMES output — the film's recitation, ending on
    GLOBAL THERMONUCLEAR WAR."""
    lines = [catalog[g].title for g in CATALOG_ORDER if g != "gtw"]
    lines += ["", catalog["gtw"].title]
    return "\n".join(lines)
