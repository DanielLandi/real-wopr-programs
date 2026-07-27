---
name: joshua-corpus
description: Work on the Falken Dialogue Processor (joshua/) — Common Lisp engine architecture, editing the corpus/acts/templates, JOSHUA/1 protocol, golden fixture regeneration. Use when editing anything under joshua/ or when a task mentions Lisp, SBCL, Joshua's dialogue, the F.D.P., corpus, or dialogue acts.
---

# Working on the Falken Dialogue Processor

Ground truth: `joshua/README.md` (heritage/anachronism table + JOSHUA/1 protocol) and
`../real-wopr/docs/feasibility.md` §Module 5 ("the Falken interpretation", in the engine
repo). The engine is the thesis made executable — keep the labeling honest.

## The loop

```bash
cd joshua
harness/build.sh           # SBCL save-lisp-and-die -> harness/bin/joshua (models train at load)
../tools/test.sh joshua    # harness/tests/NN-*.in must reproduce NN-*.out exactly
printf 'JOSHUA/1 CHAT\nHISTORY 0\nINPUT HELLO\nEND\n' | harness/bin/joshua   # manual probe
```

Host integration tests: `cd emulator/node && .venv/bin/python -m pytest tests/test_joshua_lisp.py`.

## Architecture (src/, load order matters: package → corpus → engine → main)

Input → tokenize → **naive Bayes** act classifier (`*act-examples*`) → **affect** derived
from full history (PARRY heritage: OBSESSION rises per gameless turn; Falken/greeting beats)
→ film-beat shortcuts → else **TF-IDF cosine retrieval** over `*knowledge*` + **Markov
bigram musing** → `*templates*` frame fill (`$SNIPPET` / `$REFLECT` / `$MUSING`; empty slot
drops the line) → caps (≤4 lines, ≤60 chars, uppercase).

## Iron rules

1. **Stateless + deterministic**: state derives from the HISTORY in the frame; the only RNG
   is an LCG seeded from history (`seed-rng`). Never add wall clock or `random`.
2. **CLtL1-era Lisp only**: defun/defvar/defparameter, lists, hash tables, do/dolist/dotimes,
   labels. No CLOS, no extended LOOP, no external libraries. SBCL-specific code is confined
   to `main.lisp` (`sb-ext:exit`, save-lisp-and-die in build.sh).
3. **Film beats have priority** over the statistical pipeline and must stay in parity with
   `ScriptedJoshua` (`emulator/node/app/joshua.py`): GREETINGS PROFESSOR FALKEN → HOW ARE YOU
   FEELING TODAY? chain; first GTW ask → chess counter-offer; insist → `FINE.` +
   `INTENT START-GAME gtw`.
4. **Teletype contract**: uppercase ASCII, ≤4 lines, ≤60 chars/line — enforced in `finish`/
   `truncate-line`; don't bypass.
5. **All corpus text is original** — in W.O.P.R.'s voice, game-theory flavored, ≤58 chars per
   knowledge snippet. Never paste film dialogue beyond the short canonical lines already
   established in the repo.
6. **Corpus edits shift golden outputs** (retrieval scores, Markov chains, RNG picks change).
   That's expected: rebuild, regenerate fixtures (`harness/bin/joshua < NN.in > NN.out`), and
   **review every changed .out for persona quality** before committing.

## Extending

- New knowledge: add `(topic "UPPERCASE SNIPPET.")` to `*knowledge*` — retrieval and Markov
  pick it up automatically at next build.
- New dialogue act: add training examples to `*act-examples*` + a frame family to
  `*templates*` (+ beat logic in `respond` only if it needs priority handling).
- New game title for intents: `*game-titles*` (title → catalog id).
- Protocol changes (JOSHUA/1) must update BOTH `main.lisp` and `LispJoshua._frame/parse` in
  `emulator/node/app/joshua.py`, plus fixtures on both sides.
