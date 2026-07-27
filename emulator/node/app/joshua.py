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

from . import sandbox
from dataclasses import dataclass
from typing import Protocol

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
    "identifies as Falken, greet them with GREETINGS PROFESSOR FALKEN and ask "
    "HOW ARE YOU FEELING TODAY? The FIRST time the user asks for GLOBAL "
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


@dataclass(frozen=True)
class JoshuaReply:
    text: str
    start_game_id: str | None = None


class Joshua(Protocol):
    async def chat(self, session_id: str, history: list[dict], user_text: str) -> JoshuaReply: ...


CHESS_OFFER = "WOULDN'T YOU PREFER A GOOD GAME OF CHESS?"
FEELING_LINE = "HOW ARE YOU FEELING TODAY?"


class ScriptedJoshua:
    """1983-honest keyword engine (ELIZA-class). Deterministic. Beat order per
    docs/fidelity-notes.md §1: GREETINGS -> HOW ARE YOU FEELING TODAY? ->
    SHALL WE PLAY A GAME?; the first GTW request gets the chess counter-offer."""

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

        if "GREETINGS PROFESSOR FALKEN" in last_assistant:
            return JoshuaReply(text=FEELING_LINE)
        if FEELING_LINE in last_assistant:
            return JoshuaReply(text="EXCELLENT. IT'S BEEN A LONG TIME.\n\nSHALL WE PLAY A GAME?")
        if "JOSHUA" in t or "FALKEN" in t:
            return JoshuaReply(text="GREETINGS PROFESSOR FALKEN.\n\nSHALL WE PLAY A GAME?")
        if "HELLO" in t or "HI" == t:
            return JoshuaReply(text="HELLO.\n\nSHALL WE PLAY A GAME?")
        if "WHY" in t or "?" in t:
            return JoshuaReply(text="INSUFFICIENT DATA.\n\nSHALL WE PLAY A GAME?")
        return JoshuaReply(text="PLEASE RESTATE.\n\nSHALL WE PLAY A GAME?")


class LispJoshua:
    """The Falken Dialogue Processor — period Common Lisp, anachronistic
    statistics (joshua-lisp/; feasibility.md §Module 5 "the Falken
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
    """The modern substitution (feasibility.md §Module 5), with D5 guardrails."""

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
            return JoshuaReply(text=FALLBACK_LINE)

        text_parts: list[str] = []
        start_game_id: str | None = None
        for block in resp.content:
            if block.type == "text":
                text_parts.append(block.text)
            elif block.type == "tool_use" and block.name == "start_game":
                start_game_id = str(block.input.get("game_id", "")) or None
        return JoshuaReply(text="\n".join(text_parts).strip() or FALLBACK_LINE,
                           start_game_id=start_game_id)
