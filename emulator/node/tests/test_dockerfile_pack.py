"""The node image's 'programs' stage must COPY every category pack.json declares.

Docker cannot run tools/categories.sh to decide what to COPY, so the Dockerfile
is the one place a category list is still written by hand (#104). This holds
that list to the derived one — a fifth category that lands without its COPY
line would build a pack the exchange cannot dial into (that is how `wopr/` went
missing from the engine repo's import, real-wopr#206). Text-only; no Docker.
"""

import re
import subprocess
from pathlib import Path

PACK = Path(__file__).resolve().parents[3]
DOCKERFILE = PACK / "emulator" / "node" / "Dockerfile"


def _declared_categories() -> list[str]:
    out = subprocess.run([str(PACK / "tools" / "categories.sh")], capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    return out.stdout.split()


def _programs_stage_copies() -> list[str]:
    """Top-level directories the 'programs' stage COPYs from the build context."""
    text = DOCKERFILE.read_text()
    stage = text.split("FROM ", 1)[1].split("\nFROM ", 1)[0]
    assert stage.startswith("debian"), "the first stage is expected to be the programs stage"
    return sorted(
        src for src, dst in re.findall(r"^COPY\s+(\S+)\s+\./(\S+)\s*$", stage, re.M)
        if "/" not in src and src == dst and src not in ("tools", "pack.json")
    )


def test_programs_stage_copies_exactly_the_declared_categories():
    declared = _declared_categories()
    assert "norad" in declared  # the fifth category, the one #104 was waiting for
    assert _programs_stage_copies() == declared, (
        "Dockerfile COPY lines and tools/categories.sh disagree: a category that "
        "is not copied into the programs stage is not built, tested, or shipped"
    )
