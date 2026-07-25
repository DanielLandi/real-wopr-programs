"""NORAD operator roster — interim identity source for the norad-terminal
operator tier (deployment.md D4 amendment, 2026-07-20). Parsed once at
startup from WOPR_OPERATORS; the credential check swaps to Supabase Auth
when #35 lands (#42)."""

from __future__ import annotations

import re
from dataclasses import dataclass

# CALLSIGN:ACCESSCODE:LEVEL — uppercase alphanumerics plus '-', level 1-5.
_ENTRY = re.compile(r"^([A-Z0-9-]+):([A-Z0-9-]+):([1-5])$")
RESERVED_CALLSIGNS = {"JOSHUA"}


@dataclass(frozen=True)
class Operator:
    callsign: str
    code: str
    level: int


def parse_roster(raw: str) -> dict[str, Operator]:
    """WOPR_OPERATORS="CALLSIGN:CODE:LEVEL,..." -> {callsign: Operator}.
    Malformed entries raise at startup — fail fast, not at logon time."""
    roster: dict[str, Operator] = {}
    for chunk in raw.split(","):
        entry = chunk.strip()
        if not entry:
            continue
        m = _ENTRY.match(entry)
        if m is None:
            safe = entry.split(":", 1)[0]
            raise ValueError(f"malformed WOPR_OPERATORS entry (starts {safe!r}): expected CALLSIGN:CODE:LEVEL")
        callsign, code, level = m.group(1), m.group(2), int(m.group(3))
        if callsign in RESERVED_CALLSIGNS:
            raise ValueError(f"reserved callsign in WOPR_OPERATORS: {callsign}")
        if callsign in roster:
            raise ValueError(f"duplicate callsign in WOPR_OPERATORS: {callsign}")
        roster[callsign] = Operator(callsign, code, level)
    return roster
