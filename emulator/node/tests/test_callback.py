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
import threading

from app.callback import place_seat_call


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

        self._server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
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


def test_no_trunk_url_places_nothing():
    async def flow():
        assert await place_seat_call("", "s3cret", "HANDLE1") == "no hub"

    asyncio.run(flow())
