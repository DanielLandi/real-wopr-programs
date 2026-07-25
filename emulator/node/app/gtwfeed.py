"""GTW -> Big Board feed adapter (games.md §6 "Big Board hook";
deployment.md impact #3: realtime is bridge-relayed).

Converts the GTW DISPLAY block's telemetry lines into the GTW-FEED json the
Big Board renders (surfaces/norad-bigboard/app/feed.ts):

    ZULU 00:12  DEFCON 2
    UNITED STATES  ARSENAL 20  CITIES LOST 1
    SOVIET UNION   ARSENAL 19  CITIES LOST 2
    TRK WASHINGTON MOSCOW -77 39 37 56 0.40
    HIT LENINGRAD

The Fortran core stays line-oriented. This adapter adds deterministic observer
state for NORAD displays: aircraft, ships, target states, and event lines.
"""

from __future__ import annotations

import json
import math
import re
from typing import Any

FEED_PREFIX = "GTW-FEED "
FLIGHT_MIN = 30

_ZULU = re.compile(r"^ZULU (\d{2}:\d{2})\s+DEFCON (\d)")
_LOST = re.compile(r"CITIES LOST (\d+)")
_TRK = re.compile(
    r"^TRK (\S+) (\S+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) ([0-9.]+)$"
)
_HIT = re.compile(r"^HIT (\S+)$")

_CITY_POS: dict[str, tuple[str, list[int]]] = {
    "WASHINGTON": ("US", [-77, 39]),
    "NEWYORK": ("US", [-74, 41]),
    "SEATTLE": ("US", [-122, 48]),
    "SANDIEGO": ("US", [-117, 33]),
    "LASVEGAS": ("US", [-115, 36]),
    "HOUSTON": ("US", [-95, 30]),
    "CHICAGO": ("US", [-88, 42]),
    "NORFOLK": ("US", [-76, 37]),
    "MOSCOW": ("SU", [37, 56]),
    "LENINGRAD": ("SU", [30, 60]),
    "KIEV": ("SU", [31, 50]),
    "VLADIVOSTOK": ("SU", [132, 43]),
    "NOVOSIBIRSK": ("SU", [83, 55]),
    "MURMANSK": ("SU", [33, 69]),
    "SEVASTOPOL": ("SU", [34, 45]),
    "IRKUTSK": ("SU", [104, 52]),
}


def _clock_progress(clock: str) -> float:
    if clock == "--:--":
        return 0.0
    hours, minutes = clock.split(":")
    total = int(hours) * 60 + int(minutes)
    return round((total % 60) / 60.0, 2)


def _phase(status: str, defcon: int, missiles: list[dict[str, Any]]) -> str:
    if status == "NO-WIN":
        return "no-win"
    if missiles:
        return "running"
    if defcon < 5:
        return "selecting"
    return "idle"


def _aircraft(defcon: int, progress: float) -> list[dict[str, Any]]:
    if defcon > 3:
        return []
    return [
        {"id": "B-52-01", "side": "US", "from": [-100, 42], "to": [37, 56], "progress": progress},
        {"id": "BEAR-01", "side": "SU", "from": [50, 55], "to": [-77, 39], "progress": progress},
    ]


def _ships(defcon: int, progress: float) -> list[dict[str, Any]]:
    if defcon > 4:
        return []
    return [
        {"id": "CVN-01", "side": "US", "from": [-160, 25], "to": [-145, 42], "progress": progress},
        {"id": "KIEV-01", "side": "SU", "from": [35, 70], "to": [-20, 65], "progress": progress},
    ]


def display_to_feed(display: str, status: str) -> dict[str, Any]:
    defcon = 5
    clock = "--:--"
    targets = 0
    missiles: list[dict[str, Any]] = []
    target_states: list[dict[str, Any]] = []
    hit_cities: set[str] = set()
    events: list[str] = []

    for line in display.splitlines():
        m = _ZULU.match(line)
        if m:
            clock = m.group(1)
            defcon = int(m.group(2))
            continue
        m = _LOST.search(line)
        if m:
            targets += int(m.group(1))
            continue
        m = _TRK.match(line)
        if m:
            missiles.append({
                "from": [int(m.group(3)), int(m.group(4))],
                "to": [int(m.group(5)), int(m.group(6))],
                "progress": float(m.group(7)),
            })
            continue
        m = _HIT.match(line)
        if m:
            name = m.group(1)
            events.append(line)
            city = _CITY_POS.get(name)
            # One targetStates entry per city: two missiles on one target are
            # two HIT lines, but the Big Board keys its markers by
            # `<name>-<status>`, so duplicates collide as React keys. The
            # events list keeps every impact line.
            if city and name not in hit_cities:
                hit_cities.add(name)
                target_states.append({
                    "name": name,
                    "side": city[0],
                    "position": city[1],
                    "status": "hit",
                })
            continue
        if line.startswith(("EXCHANGE ", "WINNER:", "ESTIMATED ")):
            events.append(line)

    if missiles:
        soonest = min(1.0 - mi["progress"] for mi in missiles)
        impact = f"{math.ceil(soonest * FLIGHT_MIN):02d} MIN"
    else:
        impact = None
    progress = _clock_progress(clock)

    return {
        "type": "gtw_state",
        "phase": _phase(status, defcon, missiles),
        "defcon": defcon,
        "clock": clock,
        "targets": targets,
        "impact": impact,
        "status": status,
        "scenario": "US/USSR EXCHANGE",
        "missiles": missiles,
        "aircraft": _aircraft(defcon, progress),
        "ships": _ships(defcon, progress),
        "targetStates": target_states,
        "events": events,
    }


def feed_line(display: str, status: str) -> str:
    return FEED_PREFIX + json.dumps(display_to_feed(display, status))


def _track_row(tid: str, typ: str, side: str, frm: list[int], to: list[int],
               progress: float) -> str:
    def pos(p: list[int]) -> str:
        return f"{p[0]} {p[1]}"
    return (f"{tid:<10}{typ:<5}{side:<5}"
            f"{pos(frm):<10}{pos(to):<10}{progress:.2f}")


def tracks_text(feed: dict[str, Any]) -> str:
    """Operator TRACKS readout (router tier, spec 2026-07-20): the same feed
    the Big Board renders, as a fixed-width teleprinter table."""
    lines = [
        f"TACTICAL TRACKS  ZULU {feed['clock']}  DEFCON {feed['defcon']}",
        f"{'ID':<10}{'TYP':<5}{'SIDE':<5}{'FROM':<10}{'TO':<10}PROG",
    ]
    for t in feed.get("aircraft") or []:
        lines.append(_track_row(t["id"], "AC", t["side"], t["from"], t["to"], t["progress"]))
    for t in feed.get("ships") or []:
        lines.append(_track_row(t["id"], "SHIP", t["side"], t["from"], t["to"], t["progress"]))
    for i, m in enumerate(feed.get("missiles") or [], 1):
        lines.append(_track_row(f"MSL-{i:02d}", "MSL", "", m["from"], m["to"], m["progress"]))
    if len(lines) == 2:
        lines.append("NO TRACKS AIRBORNE")
    targets = feed.get("targetStates") or []
    if targets:
        lines.append("TARGETS: " + "  ".join(
            f"{t['name']} {t['status'].upper()}" for t in targets))
    lines.extend((feed.get("events") or [])[-3:])
    return "\n".join(lines)
