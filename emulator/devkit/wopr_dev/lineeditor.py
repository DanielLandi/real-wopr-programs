"""A DEC SOS / VAX EDT-style line editor over a real file.

Period-faithful line mode (no full-screen): files are addressed by line number,
edited a line at a time, saved back to the same path. Pure/testable — the REPL
is a thin shell over this. Reference: TOPS-10 SOS Reference Manual.

Commands (case-insensitive first token):
  P [a[,b]]        print line a (or range a..b, or whole file)
  N                print with line numbers (default listing)
  I n              insert BEFORE line n; subsequent lines until a lone '.'
  A n              append AFTER line n; ends on a lone '.'
  R n              replace line n; ends on a lone '.'
  D a[,b]          delete line a (or range)
  S n /old/new/    substitute first old->new on line n
  W                write back to disk
  Q                quit (warns if unsaved)
  QY               quit discarding changes
  E                write and quit
Anything else is reported without mutating.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass
class EditResult:
    output: str
    done: bool = False       # session should end
    saved: bool = False


class LineEditor:
    def __init__(self, path: Path):
        self.path = path
        self.lines = path.read_text().split("\n") if path.exists() else []
        # a trailing newline shows up as one empty final element; drop it for editing
        if self.lines and self.lines[-1] == "":
            self.lines.pop()
        self.dirty = False
        self._pending: list[str] | None = None   # multi-line input buffer
        self._pending_op: tuple[str, int] | None = None

    # -- multi-line input (I/A/R collect until a lone '.') --------------------
    def feed(self, raw: str) -> EditResult:
        """Feed one input line. During I/A/R this collects body lines."""
        if self._pending is not None:
            if raw.rstrip("\r") == ".":
                return self._commit_pending()
            self._pending.append(raw.rstrip("\r"))
            return EditResult("")
        return self._command(raw.strip())

    def _commit_pending(self) -> EditResult:
        op, n = self._pending_op
        body = self._pending or []
        self._pending = None
        self._pending_op = None
        if op == "I":
            self.lines[n - 1:n - 1] = body
        elif op == "A":
            self.lines[n:n] = body
        elif op == "R":
            self.lines[n - 1:n] = body
        self.dirty = True
        return EditResult(f"{len(body)} line(s) entered.")

    # -- single commands ------------------------------------------------------
    def _command(self, cmd: str) -> EditResult:
        if not cmd:
            return EditResult("")
        # QY = quit-discard (SOS spelled it as one token); split it out.
        if cmd.upper() in ("QY", "Q Y"):
            return EditResult("[quit]", done=True)
        head = cmd.split()[0].upper()
        arg = cmd[len(head):].strip()

        if head == "P":
            return EditResult(self._render(arg, numbered=False))
        if head in ("N", "L"):
            return EditResult(self._render(arg, numbered=True))
        if head in ("I", "A", "R"):
            return self._begin_multiline(head, arg)
        if head == "D":
            return self._delete(arg)
        if head == "S":
            return self._substitute(arg)
        if head == "W":
            return self._write()
        if head == "E":
            self._write()
            return EditResult("[saved]", done=True, saved=True)
        if head == "Q":
            if arg.upper() == "Y" or not self.dirty:
                return EditResult("[quit]", done=True)
            return EditResult("Unsaved changes — W to write, or QY to discard.")
        return EditResult(f"? unknown editor command: {head}")

    def _begin_multiline(self, op: str, arg: str) -> EditResult:
        n = self._lineno(arg)
        if n is None:
            return EditResult("? need a line number")
        if op in ("R",) and not (1 <= n <= len(self.lines)):
            return EditResult(f"? no line {n}")
        if op == "A" and not (0 <= n <= len(self.lines)):
            return EditResult(f"? no line {n}")
        if op == "I" and not (1 <= n <= len(self.lines) + 1):
            return EditResult(f"? no line {n}")
        self._pending = []
        self._pending_op = (op, n)
        verb = {"I": "insert before", "A": "append after", "R": "replace"}[op]
        return EditResult(f"[{verb} line {n}; end with a lone '.']")

    def _delete(self, arg: str) -> EditResult:
        span = self._range(arg)
        if span is None:
            return EditResult("? need line or range")
        a, b = span
        del self.lines[a - 1:b]
        self.dirty = True
        return EditResult(f"deleted {b - a + 1} line(s).")

    def _substitute(self, arg: str) -> EditResult:
        parts = arg.split(None, 1)
        if len(parts) != 2 or parts[1].count("/") < 3:
            return EditResult("? usage: S <n> /old/new/")
        n = self._lineno(parts[0])
        if n is None or not (1 <= n <= len(self.lines)):
            return EditResult(f"? no line {n}")
        _, old, new, _ = parts[1].split("/", 3)
        if old not in self.lines[n - 1]:
            return EditResult(f"? {old!r} not on line {n}")
        self.lines[n - 1] = self.lines[n - 1].replace(old, new, 1)
        self.dirty = True
        return EditResult(f"{n}: {self.lines[n - 1]}")

    def _write(self) -> EditResult:
        self.path.write_text("\n".join(self.lines) + "\n")
        self.dirty = False
        return EditResult(f"[wrote {len(self.lines)} lines to {self.path.name}]", saved=True)

    # -- helpers --------------------------------------------------------------
    def _render(self, arg: str, numbered: bool) -> str:
        span = self._range(arg) if arg else (1, len(self.lines))
        if span is None:
            return "? bad range"
        a, b = span
        out = []
        for i in range(a, b + 1):
            if 1 <= i <= len(self.lines):
                out.append(f"{i:5d}  {self.lines[i - 1]}" if numbered else self.lines[i - 1])
        return "\n".join(out) if out else "[empty]"

    def _lineno(self, s: str) -> int | None:
        try:
            return int(s)
        except (ValueError, TypeError):
            return None

    def _range(self, arg: str) -> tuple[int, int] | None:
        if not arg:
            return (1, len(self.lines))
        if "," in arg:
            a, _, b = arg.partition(",")
            na, nb = self._lineno(a.strip()), self._lineno(b.strip())
            return (na, nb) if na and nb else None
        n = self._lineno(arg.strip())
        return (n, n) if n else None
