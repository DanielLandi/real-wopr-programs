"""Spend ceiling for the metered dialogue processor (deployment.md D5).

D5 caps Joshua exchanges per *session* at 50. It says nothing about the number
of sessions, and the flagship exchange is publicly dialable — so once `claude`
is selectable by a URL parameter, one shared link is enough for strangers to
decide the operator's bill.

The ceiling counts calls rather than tokens: `max_tokens` is already capped at
300, which makes a call a predictable proxy for spend and needs no accounting.
It lives in memory like every other piece of exchange state, so a restart
resets it; that is documented in deployment.md rather than hidden.
"""

from __future__ import annotations

from datetime import date, datetime, timezone

from .joshua import FALLBACK_LINE, Joshua, JoshuaReply


def _utc_today() -> date:
    return datetime.now(timezone.utc).date()


class DailyBudget:
    """A call allowance that refills at UTC midnight.

    `today` is a parameter rather than a hidden clock read so the rollover is
    testable without patching time.
    """

    def __init__(self, limit: int):
        self.limit = max(0, limit)
        self._day: date | None = None
        self._used = 0

    def _roll(self, today: date) -> None:
        if self._day != today:
            self._day = today
            self._used = 0

    def remaining(self, today: date | None = None) -> int:
        self._roll(today or _utc_today())
        return max(0, self.limit - self._used)

    def available(self, today: date | None = None) -> bool:
        return self.remaining(today) > 0

    def spend(self, today: date | None = None) -> bool:
        """Consume one call. False when the ceiling is already reached."""
        if not self.available(today):
            return False
        self._used += 1
        return True


class MeteredJoshua:
    """Wraps a paid engine so exhaustion is answered in character.

    A session already in flight when the ceiling is reached gets FALLBACK_LINE
    — invented text that already means exactly this — rather than an error the
    fiction has no way to say. New sessions never get this far: the processor
    stops being advertised and selecting it is refused outright.
    """

    def __init__(self, inner: Joshua, budget: DailyBudget):
        self._inner = inner
        self._budget = budget

    async def chat(self, session_id: str, history: list[dict], user_text: str) -> JoshuaReply:
        if not self._budget.spend():
            return JoshuaReply(text=FALLBACK_LINE)
        return await self._inner.chat(session_id, history, user_text)
