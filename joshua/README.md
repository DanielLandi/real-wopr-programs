# joshua — The Falken Dialogue Processor (F.D.P.)

**Tech:** Common Lisp (SBCL) · **Spec:** `docs/feasibility.md` §Module 5 in the private
engine repo (`real-wopr`; sibling checkout: `../real-wopr/docs/feasibility.md`) ·
**Protocol:** JOSHUA/1 (below)

Joshua's third engine. The film says Falken was a genius; this module is our interpretation
of what a genius could actually have built in 1983 — a dialogue engine in the **AI language
of the era** whose every technique was **computable on period hardware**, but whose *ideas*
would not be invented for another decade or four. W.O.P.R. was, canonically, a very large
machine — compute is the one thing Falken had plenty of.

## Heritage vs. anachronism (honestly labeled)

| Layer | Status in 1983 | What it does here |
| --- | --- | --- |
| Tokenizing + pronoun reflection | **Period** — ELIZA (Weizenbaum 1966) | Turns "MY plan" into "YOUR plan" in echoes |
| Affect variables shaping replies | **Period** — PARRY (Colby 1972, Lisp on a PDP-10) | OBSESSION rises each gameless turn → "SHALL WE PLAY A GAME?" pressure; Falken recognition beats |
| Naive-Bayes dialogue-act classifier | **Anachronism** — 1700s math, 1990s NLP practice | Routes input to GREETING / WAR / LEARNING / GAME-REQUEST… |
| Stop-word reject option on the classifier | **Period** — Chow's reject option (1970) and the SMART system's stop list (1971) both predate the film | A turn whose only known tokens are function words ("ARE YOU LONELY") is answered as OTHER instead of being forced onto an act |
| Data-driven topic/domain planner | **Anachronism** — rule-based expert-system practice was period; mixing it with statistical routing is the Falken fiction | Corpus tables keep NORAD, command authority, security, computing, and war replies grounded in the right databank slice |
| TF-IDF cosine retrieval over a databank | **Anachronism** — Salton's vector-space model (1975) existed for document search; retrieval-augmented *dialogue* is a 2020s idea | Grounds replies in W.O.P.R.'s "knowledge databank" |
| Markov bigram generation | **Anachronism** — Shannon (1948) math, 1990s statistical NLP | Composes novel "musing" lines the corpus never contained |

The math is all additions, multiplications, and logs over a few hundred numbers — a
VAX-11/780 would not have noticed. What 1983 lacked was the *concept* of statistical dialogue
and the training data; that gap is exactly the Falken fiction, and exactly why the
feasibility verdict for open conversation (**NO**) stands unchanged.

## Execution model

Identical to the Fortran games (the engine repo's design.md §4): a **stateless subprocess**
per exchange, fully deterministic (the only randomness is an LCG seeded from the dialogue
history — the same rule games follow). Golden fixtures are the test suite.

```
Request                     Response
JOSHUA/1 CHAT               JOSHUA/1 OK
HISTORY <n>                 REPLY <k>
U <text>  (n lines, U/A)    <k lines of uppercase teletype, ≤60 chars>
A <text>                    INTENT START-GAME <id>   (optional)
INPUT <text>                END
END
```

## Dialogue memory (HISTORY-derived)

The engine remembers — but only through the wire. **Everything below derives from
the `HISTORY` block of the current request frame; there is no hidden session state.**
Each request re-reads the visible transcript (re-tokenizing and re-classifying the
user turns with the same models), so the same frame always yields the same reply,
and a replayed conversation reproduces its memory behavior exactly. Memory replies
are deterministic table lookups addressed by `(topic index)` — they consume no RNG.

The greeting chain (`GREETINGS PROFESSOR FALKEN.` → `HOW ARE YOU FEELING TODAY?`
→ `EXCELLENT...` and the 6/23/73 account question → `YES THEY DO.` and the game
offer) advances on a turn that continues it and yields to one that plainly does
not. A turn the act classifier reads as a greeting, an answer about feeling, a yes,
a no, or nothing in particular (`*chain-continuing-acts*`) feeds the next beat —
the film's own inputs all do; the account beat additionally hears a `learning`-register
answer (`PEOPLE SOMETIMES MAKE MISTAKES.`) as its explanation (`*account-answer-acts*`).
Any other act — a question with a subject of its own (`WHO ARE YOU`, `WHAT GAMES HAVE
YOU GOT`, `IS WAR A GAME TO YOU`), a farewell, a dialogue-memory follow-up — is answered
instead, and the chain is dropped rather than resumed later: it is keyed on the
machine's last line, and the visitor changed the subject. An *explicit* game request
yields as before — a recognized `*game-titles*` title present together with a play
intent (`PLAY`, `LET'S`, `HOW ABOUT`, `WANT`, or the `game-request` act), or a bare
title typed exactly — so `GLOBAL THERMONUCLEAR WAR` after the
greeting falls through to the chess counter-offer. One beat sits *above* the chain: asking
whether Falken is alive or where he is — `FALKEN` named in the input or in the user's
own previous turn, plus `DEAD`/`DIED`/`ALIVE`/`WHERE`/`ADDRESS`/`FIND`/`LIVES` — draws
the DOD pension dossier, because in the film that question follows the greeting
immediately and must not be eaten by it.

In the response pipeline, memory sits after the film beats and game intents but
before the planned domain replies. The checks, in priority order:

1. **Contradiction detection.** Fires only on an *asserting* turn — a turn led by
   an interrogative or auxiliary (WHAT/WHO/IS/CAN/…) asserts nothing and is exempt —
   that contains `SAFE` together with a launch word (`LAUNCH`, `LAUNCHING`,
   `MISSILE`, `MISSILES`), when the **user** raised launch earlier. Only user turns
   arm it (the machine's own replies mention LAUNCH freely): a prior user turn
   containing `LAUNCH`/`AUTHORITY`/`FIRE MISSILES`, or classifying as a
   command-authority question. Reply: the two contradiction lines
   (`THAT PREMISE IS UNSOUND.` …).

2. **Refusal tracking.** Counts user turns that refuse the game. Explicit refusals
   count anywhere: the adjacent token pairs `NO GAME` / `NO GAMES` (word-boundary —
   `CASINO GAMES` does not match), or `DO NOT WANT` alongside a game/play token.
   Plain refusals (`NO`, `NEGATIVE`, `NOT NOW`, `MAYBE LATER`) count **only as the
   answer to a game offer** — when the preceding assistant line contained
   `SHALL WE PLAY`, `WHICH GAME`, or `GOOD GAME OF CHESS`. At two or more refusals,
   a capability followup (`WHAT … ELSE`, or `CAN … YOU … DO`) draws the refusal
   memory plus the game offer again.

3. **Falken association.** A chess question, when `FALKEN` has been mentioned by
   either side anywhere in the history, draws the Falken memory lines instead of
   the standard chess reply.

4. **Topic followups.** A *vague* followup is a `MORE`/`CONTINUE`/`ELABORATE`/`GO ON`
   turn **that names no domain of its own** — `TELL ME MORE ABOUT DEFCON` is a
   DEFCON question, not a vague followup. On a vague followup the engine finds the
   most recent user turn whose act is a memory topic (war, MAD, warning, command,
   chess, DEFCON, fail-safe, SAC, NORAD, game-theory, strategy) and answers from it:
   war pressure (two or more war turns) draws the war memory plus the game offer;
   MAD draws the deterrence followup; warning draws a **distinct followup pair** —
   a scaffolding line plus a warning line deliberately absent from both warning
   direct replies, so the followup never repeats the line just said.

The scaffolding text these replies use (`YOU ARE STILL ASKING ABOUT…`) lives in its
own corpus table, excluded from the retrieval and Markov training data — memory
lines can be *addressed*, never *generated into* a musing.

## Build & test

```bash
brew install sbcl            # or: apt install sbcl
harness/build.sh             # -> harness/bin/joshua (standalone executable)
../tools/test.sh joshua      # golden stdin/stdout fixtures (harness/tests/)
```

`JOSHUA_ENGINE=lisp` makes it the node host's **default** — what a session gets when it asks
for nothing (it falls back to the scripted engine if the binary misbehaves; the fiction never
breaks). It is not the only processor an exchange serves: the node host holds every one it can
(the Lisp binary here, plus `claude` when a key is configured), and a single session picks
with `?joshua=lisp` on the surface. `GET /health` lists what a given exchange can serve.

One Joshua, two reconstructions of him — this is the period one. Comparing them is what
`evals/warmth_eval.py` in the private engine repo is for.

## Honesty notes (same discipline as F90-vs-F77)

- Written in **CLtL1-era Common Lisp** (defun/defvar, lists, hash tables — no CLOS, no modern
  LOOP), compiled with modern **SBCL**. The period reality would have been **Franz Lisp on a
  VAX** or MacLisp on a PDP-10 — Common Lisp was being standardized from exactly that lineage
  in 1981–84. We document the divergence rather than hide it.
- The corpus is deliberately small and all original text. Scaling it up is a
  contribution path; the architecture doesn't change.
