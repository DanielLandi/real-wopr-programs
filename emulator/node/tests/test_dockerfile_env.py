"""The node image must pin every pack-location env var config.py reads.

config.py falls back to the *source* tree for any BRIDGE_*_DIR / *_BIN it is
not told about; inside the image that is /app, which holds no built binaries,
so the bridge starts, passes /health, and then drops every line. The executive
shipped that way (#98 → real-wopr#228). This test reads both files as text so
the guard needs no Docker.
"""

import re
from pathlib import Path

NODE = Path(__file__).resolve().parents[1]
DOCKERFILE = NODE / "Dockerfile"
CONFIG = NODE / "app" / "config.py"
PACK_ROOT_IN_IMAGE = "/opt/wopr/pack"


def _location_keys() -> set[str]:
    """Every env var config.py consults for a pack path (dirs and binaries)."""
    text = CONFIG.read_text()
    return {
        k for k in re.findall(r'os\.environ\.get\("(BRIDGE_[A-Z_]+)"', text)
        if k.endswith("_DIR") or k.endswith("_BIN")
    }


def _dockerfile_env() -> dict[str, str]:
    """Key/value pairs from every ENV instruction (line continuations joined)."""
    text = DOCKERFILE.read_text().replace("\\\n", " ")
    env: dict[str, str] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("ENV "):
            continue
        for k, v in re.findall(r"([A-Z_][A-Z0-9_]*)=(\S+)", line[4:]):
            env[k] = v
    return env


def test_config_reads_at_least_the_known_location_keys():
    # Guards the regex against a refactor of config.py silently emptying the set.
    assert {"BRIDGE_GAMES_DIR", "BRIDGE_SYSTEMS_DIR", "BRIDGE_EXECUTIVE_DIR"} <= _location_keys()


def test_every_pack_location_key_is_pinned_into_the_image():
    env = _dockerfile_env()
    missing = sorted(k for k in _location_keys() if k not in env)
    assert not missing, (
        f"Dockerfile ENV lacks {missing}: config.py would fall back to /app, "
        "which holds no binaries, and the bridge would drop every line"
    )


def test_every_pinned_location_is_inside_the_copied_pack():
    env = _dockerfile_env()
    for k in _location_keys():
        assert env[k].startswith(PACK_ROOT_IN_IMAGE), (k, env[k])
