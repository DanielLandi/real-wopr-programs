"""Bridge configuration — plain env vars per deployment.md D6 (no shared config lib)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _pack_root() -> Path:
    """The pack root — up out of app/, node/ and emulator/.

    Layout: <pack>/emulator/node/app/config.py, with the program trees at
    <pack>/ — one per category pack.json declares (tools/categories.sh lists
    them; this docstring does not, so it cannot go stale). The programs no
    longer arrive via tools/import-programs.sh into build/pack; they are
    siblings of emulator/.
    """
    return Path(__file__).resolve().parent.parent.parent.parent


@dataclass(frozen=True)
class Settings:
    # Core execution (D2). The programs are siblings of emulator/ in this repo:
    # <pack>/<cat>/<id>/harness/{manifest.json,bin/}. Nothing is imported —
    # they are built in place by tools/build.sh.
    games_dir: Path = field(
        default_factory=lambda: Path(
            os.environ.get("BRIDGE_GAMES_DIR", str(_pack_root() / "games"))
        )
    )
    systems_dir: Path = field(
        default_factory=lambda: Path(
            os.environ.get("BRIDGE_SYSTEMS_DIR", str(_pack_root() / "systems"))
        )
    )
    # The W.O.P.R. executive: <pack>/wopr/harness/bin/wopr. This is the
    # directory it sits under, not the binary, so it is resolved exactly the
    # way a system's is.
    executive_dir: Path = field(
        default_factory=lambda: Path(
            os.environ.get("BRIDGE_EXECUTIVE_DIR", str(_pack_root()))
        )
    )
    system_timeout_s: float = field(default_factory=lambda: float(os.environ.get("BRIDGE_SYSTEM_TIMEOUT_S", "2")))
    core_timeout_s: float = field(default_factory=lambda: float(os.environ.get("BRIDGE_CORE_TIMEOUT_S", "2")))
    core_pool_size: int = field(default_factory=lambda: int(os.environ.get("BRIDGE_CORE_POOL_SIZE", "4")))
    core_queue_size: int = field(default_factory=lambda: int(os.environ.get("BRIDGE_CORE_QUEUE_SIZE", "16")))

    # Service-to-service auth (D3)
    internal_token: str = field(default_factory=lambda: os.environ.get("BRIDGE_INTERNAL_TOKEN", ""))
    session_secret: str = field(default_factory=lambda: os.environ.get("BRIDGE_SESSION_SECRET", "dev-secret"))

    # NORAD operator roster (permanent identity source — Neon design 2026-08-09).
    # "CALLSIGN:CODE:LEVEL,..." triplets.
    wopr_operators: str = field(default_factory=lambda: os.environ.get("WOPR_OPERATORS", ""))

    # Per-exchange greeting shown above LOGON: on a terminal line. A trunk host
    # sets this to give their exchange personality; empty (the default, e.g. the
    # main exchange) shows the bare LOGON: unchanged.
    logon_banner: str = field(default_factory=lambda: os.environ.get("BRIDGE_LOGON_BANNER", ""))

    # Postgres (Neon in production) — unset => in-memory store (dev/tests)
    database_url: str = field(default_factory=lambda: os.environ.get("DATABASE_URL", ""))

    # Joshua (D5). Engine: claude | lisp | scripted. JOSHUA_ENABLED=true is
    # kept as a back-compat alias for claude.
    joshua_engine: str = field(
        default_factory=lambda: os.environ.get(
            "JOSHUA_ENGINE",
            "claude" if os.environ.get("JOSHUA_ENABLED", "").lower() == "true" else "scripted",
        )
    )
    joshua_lisp_bin: Path = field(
        default_factory=lambda: Path(
            os.environ.get(
                "BRIDGE_JOSHUA_LISP_BIN",
                str(_pack_root() / "joshua" / "harness" / "bin" / "joshua"),
            )
        )
    )
    joshua_model: str = field(
        default_factory=lambda: os.environ.get("JOSHUA_MODEL", "claude-haiku-4-5-20251001")
    )
    joshua_max_tokens: int = field(default_factory=lambda: int(os.environ.get("JOSHUA_MAX_TOKENS", "300")))
    joshua_timeout_s: float = field(default_factory=lambda: float(os.environ.get("JOSHUA_TIMEOUT_S", "15")))
    joshua_session_cap: int = field(default_factory=lambda: int(os.environ.get("JOSHUA_SESSION_CAP", "50")))
    # D5 spend ceiling for the metered engine: calls per UTC day across the
    # WHOLE exchange, where joshua_session_cap is per session. See app/budget.py.
    joshua_claude_daily_calls: int = field(
        default_factory=lambda: int(os.environ.get("JOSHUA_CLAUDE_DAILY_CALLS", "500"))
    )

    # Self-serve phone-book registrations accepted per UTC day (0 disables).
    exchange_register_daily: int = field(
        default_factory=lambda: int(os.environ.get("EXCHANGE_REGISTER_DAILY", "20")))

    # The relay's HTTP base, for the one thing the bridge asks the relay to
    # do: place a call on behalf of the flagship's own Joshua line
    # (POST /trunk/place). Empty means "no hub" — a monolith, or a dev box —
    # and the callback becomes a logged no-op rather than an error. Every
    # other exchange between these two services runs the other way, relay to
    # bridge; this is the only edge pointing back.
    trunk_url: str = field(default_factory=lambda: os.environ.get("BRIDGE_TRUNK_URL", ""))

    # CORS (D3): single public origin in prod, localhost dev ports.
    cors_origins: tuple[str, ...] = field(
        default_factory=lambda: tuple(
            o.strip()
            for o in os.environ.get(
                "BRIDGE_CORS_ORIGINS",
                "http://localhost:3000,http://localhost:3001,http://localhost:3002,http://localhost:3003,http://localhost:3004",
            ).split(",")
            if o.strip()
        )
    )


def load_settings() -> Settings:
    return Settings()
