"""Interactive entry point: `python -m wopr_dev` (from devkit/).

Wraps DevSession in a TTY loop, and handles the one command that needs a real
terminal — LISP — by exec'ing SBCL with the Falken Dialogue Processor loaded,
so you land at a genuine `*` listener (edit src, (load ...), call functions),
the 1983 Lisp workflow for real.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from .session import BANNER, DevSession, PACK


def launch_lisp() -> None:
    # The Lisp sources live in the pack (joshua/src), the same path DIRECTORY
    # and GOLDEN use. This pointed at the long-removed joshua-lisp/ until the
    # devkit moved into the pack.
    src = PACK / "joshua" / "src"
    files = ["package.lisp", "corpus.lisp", "engine.lisp"]
    loads = []
    for f in files:
        loads += ["--load", str(src / f)]
    banner = (
        '(format t "~%FALKEN DIALOGUE PROCESSOR LOADED.~%'
        'TRY: (joshua:respond (list) \\"HELLO JOSHUA\\")~%'
        'EDIT src/*.lisp, THEN (load ...) TO RELOAD. (quit) TO EXIT.~%~%")'
    )
    try:
        subprocess.run(["sbcl", "--noinform", *loads, "--eval", banner], check=False)
    except FileNotFoundError:
        print("? sbcl not found — install it (brew install sbcl) to use the listener.")


def main() -> int:
    session = DevSession()
    print(BANNER)
    while True:
        try:
            prompt = "*edit> " if session.editor is not None else "WOPR.DEV> "
            raw = input(prompt)
        except (EOFError, KeyboardInterrupt):
            print("\n[LOGOFF]")
            return 0
        if session.editor is None and raw.strip().upper() == "LISP":
            print(session.command(raw)[0])
            launch_lisp()
            continue
        out, done = session.command(raw)
        if out:
            print(out)
        if done:
            return 0


if __name__ == "__main__":
    sys.exit(main())
