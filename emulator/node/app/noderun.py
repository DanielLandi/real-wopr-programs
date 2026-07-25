"""Run one node.

    WOPR_NODE=school WOPR_RELAY_PSTN=ws://127.0.0.1:54011 \
      WOPR_RELAY_BUS=ws://127.0.0.1:54013 python -m app.noderun --pack .

The supervisor spawns one of these per declared node, but nothing stops you
running one by hand against a relay you started yourself — that is the point of
nodes dialling out rather than listening.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
from pathlib import Path

from .nodehost import NodeHost, NodeHostError

log = logging.getLogger("wopr.noderun")


def relays_from_env(env=os.environ) -> dict[str, str]:
    """WOPR_RELAY_<NETWORK> -> {network: url}, network names lowercased."""
    out: dict[str, str] = {}
    for key, value in env.items():
        if key.startswith("WOPR_RELAY_") and value:
            out[key[len("WOPR_RELAY_"):].lower()] = value
    return out


async def run(node_id: str, pack_root: Path, fresh: bool) -> int:
    try:
        host = NodeHost.for_node(node_id, pack_root, relays_from_env())
    except NodeHostError as exc:
        print(f"wopr: {exc}", file=sys.stderr)
        return 2

    if fresh and host.store is not None:
        host.store.reset()

    # A relay may not be listening yet when the supervisor starts everything at
    # once, and a relay can be restarted under a running node. Retry rather than
    # dying: a node that gave up on its first attempt would need the operator to
    # restart it by hand.
    delay = 0.1
    while True:
        try:
            await host.start()
            break
        except (OSError, asyncio.TimeoutError) as exc:
            log.info("%s: relay not ready (%s) — retrying in %.1fs", node_id, exc, delay)
            await asyncio.sleep(delay)
            delay = min(delay * 2, 5.0)

    print("answering "
          + ", ".join(f"{n} {a.address}" for n, a in host.decl.networks.items()),
          flush=True)
    try:
        await asyncio.gather(*host._tasks)
    except asyncio.CancelledError:
        pass
    finally:
        await host.stop()
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Run one node of the federation.")
    ap.add_argument("--pack", default=".", help="pack root (default: cwd)")
    ap.add_argument("--node", default=os.environ.get("WOPR_NODE", ""),
                    help="node id (default: $WOPR_NODE)")
    ap.add_argument("--fresh", action="store_true",
                    help="discard this node's persisted store state first")
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    if not args.node:
        print("wopr: no node given (--node or $WOPR_NODE)", file=sys.stderr)
        return 2
    try:
        return asyncio.run(run(args.node, Path(args.pack).resolve(), args.fresh))
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
