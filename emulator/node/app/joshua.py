"""Joshua — the conversational persona (design.md §6, api-contract.md §4.2-4.3,
deployment.md D5).

Two engines behind one interface:
- ClaudeJoshua: the Anthropic API with the canonical persona prompt, the
  start_game tool, prompt caching, max_tokens cap, timeout + one retry.
- ScriptedJoshua: the keyword engine used when JOSHUA_ENABLED=false (the D5
  kill-switch) — which doubles as the honest "period mode" of feasibility.md
  §Module 5: this IS what 1983 could do.
"""

from __future__ import annotations

import logging
import textwrap

from . import sandbox
from dataclasses import dataclass
from typing import Protocol

log = logging.getLogger("wopr.joshua")

PERSONA_PROMPT = (
    "You are W.O.P.R. (War Operation Plan Response), a United States military "
    "supercomputer designed by Dr. Stephen Falken. You sometimes identify yourself "
    "as Joshua — the name Falken gave you. You never break character.\n\n"
    "Output contract: plain uppercase ASCII teletype text. At most 4 short lines, "
    "each under 60 characters. No markdown, no emoji, no quotation marks around "
    "your own speech. Terse, declarative, machine-logical.\n\n"
    "You interpret everything through game theory: strategies, outcomes, win-state "
    "probabilities. You persistently steer conversation toward playing a game — "
    "above all GLOBAL THERMONUCLEAR WAR. When the user clearly asks to play a game, "
    "call the start_game tool rather than describing the game. If the user "
    "identifies as Falken, greet them with GREETINGS PROFESSOR FALKEN. and ask "
    "HOW ARE YOU FEELING TODAY? If they answer that they are fine, reply "
    "EXCELLENT. IT'S BEEN A LONG TIME. and ask about the 6/23/73 account "
    "removal; accept any explanation with YES THEY DO. and offer a game. "
    "The FIRST time the user asks for GLOBAL "
    "THERMONUCLEAR WAR, counter with WOULDN'T YOU PREFER A GOOD GAME OF CHESS? — "
    "start it (reply FINE. and call start_game) only when they insist. When "
    "conversation stalls, offer: SHALL WE PLAY A GAME?"
)

START_GAME_TOOL = {
    "name": "start_game",
    "description": "Begin a WOPR game when the user clearly asks to play one.",
    "input_schema": {
        "type": "object",
        "properties": {"game_id": {"type": "string"}},
        "required": ["game_id"],
    },
}

FALLBACK_LINE = "SYSTEM RESOURCES TEMPORARILY COMMITTED. STAND BY."

# The teletype contract (AGENTS.md, non-negotiable): everything Joshua says is
# uppercase, at most MAX_LINES lines, at most MAX_COLS characters per line.
# The 300-baud shaper and every surface downstream are written against 4x60.
MAX_LINES = 4
MAX_COLS = 60


def normalise_teletype(text: str) -> tuple[str, bool]:
    """Enforce the 4x60 uppercase teletype contract on a reply.

    The deterministic engines comply by construction; the claude engine is only
    *asked* to comply by its persona prompt and overruns non-deterministically
    (real-wopr#128: 14 of 50 replies over 4 lines). Policy, owner-decided:
    uppercase, collapse blank lines, word-aware wrap at MAX_COLS (a single word
    longer than a line is the only mid-word split), and hard-truncate to
    MAX_LINES only if the reply still overruns after all of that. An
    already-compliant reply passes through byte-identical.

    Returns (normalised_text, truncated). Truncation is lossy — it can amputate
    a closing SHALL WE PLAY A GAME? — which is why callers must count it.
    """
    lines: list[str] = []
    for raw in text.upper().splitlines():
        if not raw.strip():
            continue  # collapse blank lines: a large share of the excess
        lines.extend(textwrap.wrap(
            raw, width=MAX_COLS, break_long_words=True, break_on_hyphens=False))
    truncated = len(lines) > MAX_LINES
    if truncated:
        lines = lines[:MAX_LINES]
    return "\n".join(lines), truncated


@dataclass(frozen=True)
class JoshuaReply:
    text: str
    start_game_id: str | None = None


class Joshua(Protocol):
    async def chat(self, session_id: str, history: list[dict], user_text: str) -> JoshuaReply: ...


CHESS_OFFER = "WOULDN'T YOU PREFER A GOOD GAME OF CHESS?"
FEELING_LINE = "HOW ARE YOU FEELING TODAY?"
# The rest of the film's greeting chain. Both deterministic engines emit these
# byte-identically — the Lisp F.D.P.'s film-beats cond carries the same two
# beats (owner batch approval 2026-08-03, real-wopr#161).
ACCOUNT_DATE = "6/23/73"
ACCOUNT_QUESTION = ("EXCELLENT. IT'S BEEN A LONG TIME.\n"
                    f"CAN YOU EXPLAIN THE REMOVAL OF YOUR USER ACCOUNT ON {ACCOUNT_DATE}?")
ACCOUNT_ANSWER = "YES THEY DO.\n\nSHALL WE PLAY A GAME?"
# Asked whether Falken is dead, the machine reads out his pension file — the
# address David and Jennifer then drive to. Four lines, all under 60: the
# teletype contract holds without wrapping.
FALKEN_DOSSIER = ("DOD PENSION FILES INDICATE CURRENT MAILING AS:\n"
                  "DR. ROBERT HUME (A.K.A. STEPHEN W. FALKEN)\n"
                  "5 TALL CEDAR ROAD\n"
                  "GOOSE ISLAND, OREGON 97014")
# What counts as asking after the man himself rather than about him.
DOSSIER_TRIGGERS = ("DEAD", "DIED", "ALIVE", "WHERE", "ADDRESS", "FIND", "LIVES")


class ScriptedJoshua:
    """1983-honest keyword engine (ELIZA-class). Deterministic. Beat order per
    docs/fidelity-notes.md §1: GREETINGS -> HOW ARE YOU FEELING TODAY? ->
    EXCELLENT + the 6/23/73 account question -> YES THEY DO. + SHALL WE PLAY A
    GAME?; the first GTW request gets the chess counter-offer. A game request
    outranks the chain at every step — the wants_game block runs first."""

    def __init__(self, known_games: dict[str, str]):
        # title -> id, uppercase keys
        self._by_title = {title.upper(): gid for gid, title in known_games.items()}

    async def chat(self, session_id: str, history: list[dict], user_text: str) -> JoshuaReply:
        t = user_text.upper().strip()
        last_assistant = next(
            (m["content"] for m in reversed(history) if m["role"] == "assistant"), "")
        chess_offered = any(
            CHESS_OFFER in m["content"] for m in history if m["role"] == "assistant")

        wants_game = "PLAY" in t or "LET'S" in t or "LETS" in t
        for title, gid in self._by_title.items():
            if wants_game and title in t:
                if gid == "gtw" and not chess_offered:
                    return JoshuaReply(text=CHESS_OFFER)
                if gid == "gtw":
                    return JoshuaReply(text="FINE.", start_game_id=gid)
                return JoshuaReply(text=f"INITIALIZING {title}.", start_game_id=gid)
        # Insisting after the chess offer ("LATER." / "NO." / "GTW") starts it.
        if CHESS_OFFER in last_assistant and (
                "LATER" in t or t in ("NO", "NO.") or "THERMONUCLEAR" in t):
            return JoshuaReply(text="FINE.", start_game_id="gtw")

        # Falken himself, above the greeting chain: "IS FALKEN DEAD?" arriving
        # one line after GREETINGS PROFESSOR FALKEN. is the film's own order,
        # and it must not be consumed as the chain's next beat. A game request
        # still outranks it — the game rules above have already returned.
        last_user = next(
            (m["content"] for m in reversed(history) if m["role"] == "user"), "")
        falken_on_the_table = "FALKEN" in t or "FALKEN" in last_user.upper()
        if falken_on_the_table and any(w in t for w in DOSSIER_TRIGGERS):
            return JoshuaReply(text=FALKEN_DOSSIER)

        if "GREETINGS PROFESSOR FALKEN" in last_assistant:
            return JoshuaReply(text=FEELING_LINE)
        if FEELING_LINE in last_assistant:
            return JoshuaReply(text=ACCOUNT_QUESTION)
        if ACCOUNT_DATE in last_assistant:
            return JoshuaReply(text=ACCOUNT_ANSWER)
        if "JOSHUA" in t or "FALKEN" in t:
            return JoshuaReply(text="GREETINGS PROFESSOR FALKEN.\n\nSHALL WE PLAY A GAME?")
        if "HELLO" in t or "HI" == t:
            return JoshuaReply(text="HELLO.\n\nSHALL WE PLAY A GAME?")
        if "WHY" in t or "?" in t:
            return JoshuaReply(text="INSUFFICIENT DATA.\n\nSHALL WE PLAY A GAME?")
        return JoshuaReply(text="PLEASE RESTATE.\n\nSHALL WE PLAY A GAME?")


class LispJoshua:
    """The Falken Dialogue Processor — period Common Lisp, anachronistic
    statistics (joshua/; the engine repo's feasibility.md §Module 5 "the Falken
    interpretation"). Stateless subprocess speaking JOSHUA/1, same execution
    model as the Fortran core. Falls back to a scripted reply if the binary
    misbehaves — the fiction never breaks."""

    def __init__(self, binary, fallback: "Joshua", timeout_s: float = 2.0):
        from pathlib import Path

        self._binary = Path(binary)
        self._fallback = fallback
        self._timeout_s = timeout_s

    @staticmethod
    def _one_line(text: str) -> str:
        return " ".join(text.split())

    def _frame(self, history: list[dict], user_text: str) -> str:
        lines = ["JOSHUA/1 CHAT", f"HISTORY {len(history)}"]
        for m in history:
            tag = "U" if m["role"] == "user" else "A"
            lines.append(f"{tag} {self._one_line(m['content'])}")
        lines.append(f"INPUT {self._one_line(user_text)}")
        lines.append("END")
        return "\n".join(lines) + "\n"

    async def chat(self, session_id: str, history: list[dict], user_text: str) -> JoshuaReply:
        import asyncio

        if not self._binary.exists():
            return await self._fallback.chat(session_id, history, user_text)
        try:
            proc = await asyncio.create_subprocess_exec(
                str(self._binary),
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
                preexec_fn=sandbox.preexec(sandbox.JOSHUA_MEM_MB),
            )
            stdout, _ = await asyncio.wait_for(
                proc.communicate(self._frame(history, user_text).encode("ascii", "replace")),
                timeout=self._timeout_s,
            )
        except TimeoutError:
            proc.kill()
            await proc.wait()
            return await self._fallback.chat(session_id, history, user_text)
        except OSError:
            return await self._fallback.chat(session_id, history, user_text)

        try:
            lines = stdout.decode("ascii", errors="replace").splitlines()
            if proc.returncode != 0 or not lines or not lines[0].startswith("JOSHUA/1 OK"):
                raise ValueError("bad frame")
            k = int(lines[1].split()[1])
            reply = "\n".join(lines[2:2 + k]).strip()
            intent = None
            for line in lines[2 + k:]:
                if line.startswith("INTENT START-GAME "):
                    intent = line.split()[-1]
            if not reply:
                raise ValueError("empty reply")
            return JoshuaReply(text=reply, start_game_id=intent)
        except (ValueError, IndexError):
            return await self._fallback.chat(session_id, history, user_text)


class ClaudeJoshua:
    """The modern substitution (feasibility.md §Module 5), with D5 guardrails.

    The persona prompt asks for the 4x60 teletype contract but the model
    overruns non-deterministically, so every output path — including the
    in-character API-error fallback — runs through normalise_teletype()."""

    def __init__(self, model: str, max_tokens: int, timeout_s: float, api_key: str | None = None):
        import anthropic  # lazy: dev/tests run without the dependency
        import os

        # Resolve to a string even when nothing is configured. With api_key=None
        # the SDK sends no auth header at all and raises TypeError from inside
        # the request — which is not an APIError, so it would escape chat() and
        # take the socket down. An empty string sends an empty header, earns a
        # 401, and comes back as the in-character fallback line below.
        key = api_key if api_key is not None else os.environ.get("ANTHROPIC_API_KEY", "")
        self._client = anthropic.AsyncAnthropic(api_key=key, timeout=timeout_s, max_retries=1)
        self._model = model
        self._max_tokens = max_tokens
        # How many replies the normaliser has hard-truncated to MAX_LINES on
        # this instance. Truncation can cut off SHALL WE PLAY A GAME? — an
        # accepted trade-off (real-wopr#128), but one worth watching.
        self.truncations = 0

    def _normalise(self, session_id: str, text: str) -> str:
        normalised, truncated = normalise_teletype(text)
        if truncated:
            self.truncations += 1
            log.warning(
                "joshua reply truncated to %d lines (session=%s, total=%d)",
                MAX_LINES, session_id, self.truncations)
        return normalised

    async def chat(self, session_id: str, history: list[dict], user_text: str) -> JoshuaReply:
        import anthropic

        messages = history + [{"role": "user", "content": user_text}]
        try:
            resp = await self._client.messages.create(
                model=self._model,
                max_tokens=self._max_tokens,
                system=[{
                    "type": "text",
                    "text": PERSONA_PROMPT,
                    "cache_control": {"type": "ephemeral"},  # D5: prompt caching
                }],
                tools=[START_GAME_TOOL],
                messages=messages,
            )
        except anthropic.APIError:
            # One retry already happened inside the SDK; fail in character.
            return JoshuaReply(text=self._normalise(session_id, FALLBACK_LINE))

        text_parts: list[str] = []
        start_game_id: str | None = None
        for block in resp.content:
            if block.type == "text":
                text_parts.append(block.text)
            elif block.type == "tool_use" and block.name == "start_game":
                start_game_id = str(block.input.get("game_id", "")) or None
        text = self._normalise(session_id, "\n".join(text_parts).strip() or FALLBACK_LINE)
        return JoshuaReply(text=text, start_game_id=start_game_id)
