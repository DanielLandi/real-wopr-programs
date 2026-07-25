"""What the terminal is connected to.

The executive is a connection monitor, not a per-line classifier: a session is
attached to exactly one program and everything typed goes to it. This module
holds that fact and nothing else.

Phase 2 moves this into the executive's own STATE block (the COMMAREA), at
which point this module goes away. Keeping it small and separate is what makes
that deletion obvious.
"""

from __future__ import annotations

from dataclasses import dataclass

FRONT_DOOR = "front-door"
JOSHUA = "joshua"
GAME = "game"
NORAD_OPS = "norad-ops"


@dataclass
class Attachment:
    """One session's current connection.

    `parent` is where a detach returns to: Joshua for a home terminal, NORAD
    operations for an operator who started a game from the ops console.
    """
    mode: str
    program: str = ""
    parent: str = JOSHUA


def prompt_for(att: Attachment, abbrev: str = "") -> str:
    """The user's prompt, carrying the mode.

    A status bar only exists on rich surfaces; a prompt works on a 300-baud
    teletype too, and costs no screen lines. The film shows no indicator at the
    front door or with Joshua, so those keep the bare '>'.
    """
    if att.mode == GAME:
        return f"[{(abbrev or att.program).upper()}]>"
    if att.mode == NORAD_OPS:
        return "[NORAD]>"
    return ">"
