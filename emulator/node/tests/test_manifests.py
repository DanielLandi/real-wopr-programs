"""Every program manifest carries the fields pack.json's index is built from.

pack.json used to be hand-maintained, so a manifest could omit `language` and
nobody noticed — the value lived only in pack.json. Task 3 generates that index
from the manifests, which makes the field load-bearing.
"""
import json
from pathlib import Path

import pytest

PACK = Path(__file__).resolve().parents[3]


def program_manifests():
    return sorted(PACK.glob("games/*/harness/manifest.json")) \
        + sorted(PACK.glob("games/*/*/harness/manifest.json")) \
        + sorted(PACK.glob("systems/*/harness/manifest.json")) \
        + sorted(PACK.glob("joshua/harness/manifest.json"))


@pytest.mark.parametrize("manifest", program_manifests(), ids=lambda p: str(p.parent.parent))
def test_manifest_declares_its_language(manifest):
    data = json.loads(manifest.read_text())
    assert data.get("language"), f"{manifest} has no `language`"
