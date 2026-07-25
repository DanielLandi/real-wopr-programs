"""Persistent STATE for a node declared `state: persistent`.

A store's host owns its STATE between calls, instead of every caller carrying
the whole record file back and forth. That is the access-method distinction —
IMS DB and VSAM owned their datasets; application programs named records. It is
also what stops a caller's STATE growing without bound.

The program is unchanged either way: it still reads a STATE block on stdin and
writes one on stdout. Only who remembers it differs.
"""

from __future__ import annotations

import logging
from pathlib import Path

log = logging.getLogger("wopr.storestate")


def _safe_name(node_id: str) -> str:
    """A node id comes from a manifest; a manifest is not a licence to write
    anywhere on the disk. Keep the plausible-identifier characters and nothing
    that could climb out of the runtime directory."""
    keep = [c for c in node_id if c.isalnum() or c in "-_"]
    return "".join(keep) or "unnamed"


class StoreState:
    def __init__(self, runtime_dir: Path, node_id: str):
        self.runtime_dir = Path(runtime_dir)
        self.node_id = node_id
        self.path = self.runtime_dir / "state" / f"{_safe_name(node_id)}.state"

    def load(self) -> str | None:
        """The STATE this store last wrote, or None if it has never written one.

        A file we cannot read costs the store its memory rather than taking the
        node down: a corrupt dataset is a bad Tuesday, not a reason to stop
        answering the line.
        """
        try:
            return self.path.read_text(encoding="ascii")
        except FileNotFoundError:
            return None
        except (UnicodeDecodeError, OSError) as exc:
            log.warning("%s: unreadable store state at %s (%s) — starting fresh",
                        self.node_id, self.path, exc)
            return None

    def save(self, state: str) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # Write-then-rename: a crash mid-write leaves the previous dataset
        # intact rather than a half-written one.
        tmp = self.path.with_suffix(".state.tmp")
        tmp.write_text(state, encoding="ascii")
        tmp.replace(self.path)

    def reset(self) -> None:
        """Discard it — what `wopr up --fresh` does, and what every integration
        test does, so a run never depends on a previous run's leftovers."""
        self.path.unlink(missing_ok=True)
