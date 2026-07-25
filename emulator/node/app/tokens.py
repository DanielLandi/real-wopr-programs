"""Signed session tokens (deployment.md D4 + design-doc impact #4).

The bridge issues its own HMAC token at POST /api/session; the surface passes
it as ?token= on the WebSocket connect; the comms layer forwards it opaquely.
Dependency-free on purpose.
"""

from __future__ import annotations

import base64
import hashlib
import hmac


def sign_session(secret: str, session_id: str) -> str:
    mac = hmac.new(secret.encode(), session_id.encode(), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(mac).decode().rstrip("=")


def verify_session(secret: str, session_id: str, token: str) -> bool:
    return hmac.compare_digest(sign_session(secret, session_id), token)
