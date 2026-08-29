"""Placing the callback.

The contract this file pins hardest: place_seat_call NEVER raises. It runs
inside ws_session's `finally`, during teardown, where an exception does not
fail a callback — it fails the disconnect (spec §5).

No aiohttp/respx here: this host's dev dependencies are pytest + httpx, so the
hub is a real local http.server instance on a background thread (same idea as
FakeDialTarget in test_peercall.py, which stands up a real websocket server
for the analogous outbound-call test) rather than a mocked transport.
"""
from __future__ import annotations

import asyncio
import http.server
import json
import socketserver
import threading
import time

from app.callback import place_seat_call


class _FastBindHTTPServer(http.server.HTTPServer):
    """HTTPServer, minus the reverse-DNS lookup nobody here asked for.

    Stock HTTPServer.server_bind() calls socket.getfqdn(host) to set
    self.server_name. On this machine/network that reverse lookup for
    127.0.0.1 measured ~35s (see task-5-report.md's timeout investigation)
    — a one-time, environment-specific stall that has nothing to do with
    anything under test. Skip it; server_name is never used here.
    """

    def server_bind(self):
        socketserver.TCPServer.server_bind(self)
        host, port = self.server_address[:2]
        self.server_name = host
        self.server_port = port


class FakeHub:
    """Plays the relay's HTTP trunk: one canned response per test.

    Records the last request's token and body so tests can assert on what
    place_seat_call actually sent.
    """

    def __init__(self, *, status: int, body: dict):
        self.status = status
        self.body = body
        self.seen: dict = {}

    def __enter__(self) -> "FakeHub":
        outer = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802 — stdlib method name
                length = int(self.headers.get("content-length", 0))
                raw = self.rfile.read(length) if length else b""
                outer.seen["path"] = self.path
                outer.seen["token"] = self.headers.get("x-wopr-internal-token")
                outer.seen["body"] = json.loads(raw) if raw else {}
                payload = json.dumps(outer.body).encode()
                self.send_response(outer.status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *args):  # silence stdlib's per-request stderr line
                pass

        self._server = _FastBindHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *exc):
        self._server.shutdown()
        self._server.server_close()
        self._thread.join()

    @property
    def url(self) -> str:
        port = self._server.server_address[1]
        return f"http://127.0.0.1:{port}"


def test_places_the_call_and_sends_only_the_seat():
    async def flow():
        with FakeHub(status=201, body={"chan": 7}) as hub:
            result = await place_seat_call(hub.url, "s3cret", "HANDLE1")

            assert result == "placed"
            assert hub.seen["token"] == "s3cret"
            # The hub discriminates on `seat` and ignores world/slot beside
            # it. Sending them would read as precision and be dead weight.
            assert hub.seen["body"] == {"seat": "HANDLE1"}

    asyncio.run(flow())


def test_a_refusal_is_returned_not_raised():
    async def flow():
        with FakeHub(status=409, body={"refused": "seat-gone"}) as hub:
            assert await place_seat_call(hub.url, "s3cret", "DEAD") == "seat-gone"

    asyncio.run(flow())


def test_an_unreachable_hub_is_returned_not_raised():
    async def flow():
        # Port 9 discards: a connection that fails rather than one that answers.
        result = await place_seat_call("http://127.0.0.1:9", "s3cret", "HANDLE1")
        assert result != "placed"

    asyncio.run(flow())


def test_a_hub_that_never_answers_is_bounded_by_timeout_s():
    """Pins the contract that actually matters: place_seat_call runs in
    teardown, so a host that never answers must not hold the caller past
    timeout_s. Port 9 above refuses instantly (ECONNREFUSED) and never
    exercises the timeout path at all. 192.0.2.0/24 (RFC 5737 TEST-NET-1) is
    reserved and never routed, so a connection to it blackholes instead of
    refusing — the case timeout_s exists for."""
    timeout_s = 0.5
    async def flow():
        t0 = time.perf_counter()
        result = await place_seat_call(
            "http://192.0.2.1", "s3cret", "HANDLE1", timeout_s=timeout_s)
        elapsed = time.perf_counter() - t0

        assert result != "placed"
        # Two bounds, for two different failures. The ceiling (generous: 4x
        # timeout_s) catches the real regression this test exists for — the
        # timeout not being honoured, holding the teardown path open. The
        # floor (0.8x timeout_s) is not a performance check: it exists to
        # catch this test going vacuous. If some future sandbox's network
        # rejects TEST-NET-1 instead of dropping it, the call would return in
        # milliseconds, "result != 'placed'" would still hold, and the
        # ceiling alone would pass — silently testing nothing. The floor
        # turns that into a loud failure instead. Measured directly against
        # this address (task-5-report.md): elapsed tracks timeout_s almost
        # exactly, so both bounds are comfortable on a normal machine.
        assert timeout_s * 0.8 <= elapsed < timeout_s * 4

    asyncio.run(flow())


def test_no_trunk_url_places_nothing():
    async def flow():
        assert await place_seat_call("", "s3cret", "HANDLE1") == "no hub"

    asyncio.run(flow())
