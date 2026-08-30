"""Importing `app.main` must not build an application (#84).

`main.py` used to end with a module-level `app = create_app()`, so merely
importing the module constructed a whole exchange from the ambient environment
— before any caller had said what settings it wanted. Two things followed:

1. A warning about nothing. Every eval run printed `BRIDGE_INTERNAL_TOKEN is
   unset` from the import-time app, about a token the evals never use; the
   driver builds its own `Settings` with the token pinned, and the import-time
   app never saw it. A warning that fires on a correct run is one people learn
   to ignore, which is the whole value of the one #74 added.
2. A `DATABASE_URL` in the shell built a `PostgresStore` at import, defeating a
   harness that pins `database_url=""` precisely so a test can never point at a
   real exchange. Harmless only while the pool stays lazy — an implementation
   detail, not a guarantee.

So the module exposes the factory alone, and every ASGI entrypoint names it
(`uvicorn app.main:create_app --factory`). The import checks run in a
subprocess: in this process `app.main` is already imported by the suite, so an
in-process check would be looking at a cached module.
"""

from __future__ import annotations

import os
import pathlib
import subprocess
import sys

from fastapi import FastAPI
from uvicorn.importer import import_from_string

NODE = pathlib.Path(__file__).resolve().parents[1]
PACK = NODE.parents[1]

#: Every place that tells an ASGI server what to serve. Each must name the
#: factory; the old `app.main:app` would raise at startup now that the
#: attribute is gone, but a grep-shaped test says *why* before anyone puts it
#: back.
ENTRYPOINTS = (
    NODE / "Dockerfile",
    NODE / "README.md",
    PACK / "tools" / "host.sh",
)
FACTORY = "app.main:create_app"
#: Shell form and Dockerfile exec (JSON) form of "serve the factory".
FACTORY_SPECS = (f"{FACTORY} --factory", f'"{FACTORY}", "--factory"')
INSTANCE_SPEC = "app.main:app"


def _import_main(script: str, **env_overrides: str) -> subprocess.CompletedProcess:
    env = {k: v for k, v in os.environ.items()
           if k not in ("BRIDGE_INTERNAL_TOKEN", "DATABASE_URL")}
    env.update(env_overrides)
    return subprocess.run(
        [sys.executable, "-c", script], cwd=NODE, env=env,
        capture_output=True, text=True, timeout=60, check=False,
    )


def test_importing_main_does_not_build_an_app():
    """No module-level instance: the factory is the only way to get one."""
    r = _import_main("import app.main, sys; sys.exit(3 if hasattr(app.main, 'app') else 0)")
    assert r.returncode == 0, f"app.main builds an app at import\n{r.stderr}"


def test_importing_main_does_not_warn_about_the_ambient_token():
    """The #74 warning belongs to an app someone asked for, not to `import`."""
    r = _import_main("import logging; logging.basicConfig(); import app.main")
    assert r.returncode == 0, r.stderr
    assert "BRIDGE_INTERNAL_TOKEN" not in r.stderr, r.stderr


def test_importing_main_does_not_touch_the_ambient_database():
    """A DATABASE_URL in the shell is not an instruction to connect to it."""
    r = _import_main(
        "import app.store as s\n"
        "def trip(url): raise SystemExit(3)\n"
        "s.make_store = trip\n"
        "import app.main\n",
        DATABASE_URL="postgresql://nobody@127.0.0.1:1/never",
    )
    assert r.returncode == 0, f"import built a store from $DATABASE_URL\n{r.stderr}"


def test_every_entrypoint_names_the_factory():
    for path in ENTRYPOINTS:
        text = path.read_text()
        assert INSTANCE_SPEC not in text, f"{path} still serves the module-level app"
        assert any(spec in text for spec in FACTORY_SPECS), \
            f"{path} does not name the app factory with --factory"


def test_the_factory_is_what_uvicorn_would_call():
    """What `--factory` does, minus the server: import the spec, call it."""
    factory = import_from_string(FACTORY)
    assert factory is not None
    assert isinstance(factory(), FastAPI)
