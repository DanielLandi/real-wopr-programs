"""The WOPR DEVELOPMENT SYSTEM monitor — the top-level command loop.

Proxies the program pack: EDIT opens the pack's source files in the period
line editor; FORTRAN/RUN/GOLDEN invoke the real toolchain against the pack;
LISP drops into a real SBCL listener with the Falken Dialogue Processor preloaded.
Edits go to this pack checkout, or $WOPR_PACK_DIR when set. Pure command dispatch
(no direct I/O) so it is scriptable and testable; run_repl() wraps it in a TTY.
"""

from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from .lineeditor import LineEditor

# <pack>/emulator/devkit/wopr_dev/session.py -> <pack>
SELF_PACK = Path(__file__).resolve().parent.parent.parent.parent


def _pack_root() -> Path:
    """Where devkit edits/builds/runs the programs. Devkit now ships inside the
    pack, so the default is this checkout and edits are persistent by
    construction. $WOPR_PACK_DIR still overrides it, to drive a different pack
    checkout from this one."""
    env = os.environ.get("WOPR_PACK_DIR")
    if env and (Path(env) / "pack.json").is_file():
        return Path(env).resolve()
    return SELF_PACK


PACK = _pack_root()

BANNER = """\
WOPR DEVELOPMENT SYSTEM  V1.0
(C) FALKEN ASSOCIATES  --  LINE MODE

FORTRAN CORE + FALKEN DIALOGUE PROCESSOR
TYPE HELP FOR COMMANDS.
"""

HELP = """\
DIRECTORY [core|joshua]     list source files (pack paths)
EDIT <path>                 open a source file in the line editor (SOS-style)
FORTRAN                     build the programs (pack: make build)
LISP                        load the Falken Dialogue Processor into a listener
RUN <game-id>               NEW frame -> the compiled game (stdin/stdout)
GOLDEN [core|joshua]        run the golden fixture suite
CHAT <text>                 one exchange with the built Joshua (JOSHUA/1)
HELP / EXIT
"""


@dataclass
class DevSession:
    repo: Path = SELF_PACK
    editor: LineEditor | None = None
    _log: list[str] = field(default_factory=list)

    # -- dispatch -------------------------------------------------------------
    def command(self, raw: str) -> tuple[str, bool]:
        """Returns (output, should_exit). If an editor is open, input is routed
        to it until it finishes."""
        if self.editor is not None:
            res = self.editor.feed(raw)
            if res.done:
                self.editor = None
            return res.output, False

        line = raw.strip()
        if not line:
            return "", False
        head, _, arg = line.partition(" ")
        head = head.upper()
        arg = arg.strip()

        if head == "HELP":
            return HELP, False
        if head in ("EXIT", "QUIT", "BYE", "LOGOFF"):
            return "[LOGOFF]", True
        if head in ("DIRECTORY", "DIR", "LS"):
            return self._directory(arg), False
        if head in ("EDIT", "ED"):
            return self._edit(arg), False
        if head in ("FORTRAN", "COMPILE"):
            return self._fortran(), False
        if head == "LISP":
            return self._lisp_hint(), False
        if head in ("RUN", "EXECUTE"):
            return self._run(arg), False
        if head == "GOLDEN":
            return self._golden(arg), False
        if head == "CHAT":
            return self._chat(arg), False
        return f"? UNKNOWN COMMAND: {head}   (HELP FOR LIST)", False

    # -- commands -------------------------------------------------------------
    def _directory(self, which: str) -> str:
        roots = {
            "core": PACK / "games",
            "joshua": PACK / "joshua" / "src",
        }
        targets = [roots[which]] if which in roots else list(roots.values())
        out = []
        for root in targets:
            for p in sorted(root.rglob("*")):
                if p.suffix in (".f90", ".lisp"):  # pack sources are always .f90/.lisp
                    out.append(str(p.relative_to(PACK)))
        return "\n".join(out) if out else "[no sources]"

    def _resolve(self, arg: str) -> Path | None:
        """Resolve a repo-relative source path, refusing traversal outside it."""
        if not arg:
            return None
        p = (PACK / arg).resolve()
        try:
            p.relative_to(PACK)
        except ValueError:
            return None
        if p.suffix not in (".f90", ".lisp"):
            return None
        return p

    def _edit(self, arg: str) -> str:
        p = self._resolve(arg)
        if p is None:
            return "? EDIT needs a repo .f90/.lisp path (see DIRECTORY)"
        if not p.exists():
            return f"? no such file: {arg}"
        self.editor = LineEditor(p)
        n = len(self.editor.lines)
        return f"[editing {arg} — {n} lines; N to list, HELP-less line mode]\n" \
               f"[I/A/R n add, D del, S subst, W write, E save+exit, Q quit]"

    def _fortran(self) -> str:
        return self._shell(["make", "build"], cwd=PACK,
                           title="FORTRAN: building the imported programs")

    def _lisp_hint(self) -> str:
        # The real listener is launched by run_repl (needs a TTY); in scripted
        # mode we report how to reach it.
        return "[LISP] launching SBCL listener with the F.D.P. loaded...\n" \
               "       (interactive; in a real terminal this drops you at a * prompt)"

    def _run(self, game_id: str) -> str:
        if not game_id:
            return "? RUN needs a game id (e.g. RUN tictactoe)"
        binary = PACK / "games" / game_id / "harness" / "bin" / game_id
        if not binary.exists():
            # Nested slot (games.md §8): a bare RUN is the core interpretation,
            # same as a bare start at the terminal.
            binary = PACK / "games" / game_id / "core" / "harness" / "bin" / game_id
        if not binary.exists():
            return f"? no binary for {game_id!r} — FORTRAN first"
        frame = f"WOPR/1 {game_id} NEW\nSTATE 0\nEND\n"
        return self._shell([str(binary)], stdin=frame, title=f"RUN {game_id} (NEW)")

    def _golden(self, which: str) -> str:
        outs = []
        if which in ("", "core"):
            outs.append(self._shell(["tools/test.sh", "games"],
                                    cwd=PACK, title="GOLDEN core"))
        if which in ("", "joshua"):
            outs.append(self._shell(["tools/test.sh", "joshua"],
                                    cwd=PACK, title="GOLDEN joshua"))
        return "\n".join(outs)

    def _chat(self, text: str) -> str:
        binary = PACK / "joshua" / "harness" / "bin" / "joshua"
        if not binary.exists():
            return "? joshua not built — run FORTRAN (pack: make build) first"
        frame = f"JOSHUA/1 CHAT\nHISTORY 0\nINPUT {' '.join(text.split())}\nEND\n"
        return self._shell([str(binary)], stdin=frame, title="CHAT")

    # -- shell wrapper --------------------------------------------------------
    def _shell(self, cmd, cwd: Path | None = None, stdin: str | None = None,
               title: str = "") -> str:
        try:
            r = subprocess.run(cmd, cwd=cwd, input=stdin, capture_output=True,
                               text=True, timeout=120)
        except FileNotFoundError:
            return f"{title}\n? command not found: {cmd[0]}"
        except subprocess.TimeoutExpired:
            return f"{title}\n? timed out"
        body = (r.stdout + r.stderr).rstrip()
        tag = "" if r.returncode == 0 else f"  [exit {r.returncode}]"
        return f"{title}{tag}\n{body}" if title else body
