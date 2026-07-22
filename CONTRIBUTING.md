# Contributing

These are the period-language programs behind [real-wopr.ai](https://real-wopr.ai). The
guiding rule is fidelity to the era: a program stays within constructs its language plausibly
had in the early 1980s, and it says so when it approximates.

## The contract: golden fixtures

Each program's `harness/tests/` holds golden fixtures — `NN-name.in` paired with `NN-name.out`.
The program is correct when every `.in` reproduces its `.out` byte-for-byte through the built
binary. Fixtures whose name contains `error` must exit non-zero (a well-formed protocol error).

```
make test                                      # every program
games/hearts/harness/build.sh                  # build one program
games/hearts/harness/bin/hearts < games/hearts/harness/tests/01-new.in
```

## Change an existing program

1. Edit the source at the top of the program's folder (e.g. `games/hearts/main.f90`).
2. Rebuild it: `games/hearts/harness/build.sh`.
3. If the behavior changed on purpose, regenerate the affected fixtures and **review the diff
   line by line** — the goldens are the spec:
   ```
   cd games/hearts/harness
   for f in tests/*.in; do bin/hearts < "$f" > "${f%.in}.out"; done
   ```
4. Make sure `make test` stays green.

## Add a program

1. Create `<category>/<id>/` with your source at the top and a `harness/` beside it.
2. Write `harness/manifest.json` (`id`, `title`, `binary`, `language`), `harness/build.sh`
   (reads the source from `..`, writes `bin/<binary>`), and `harness/tests/` golden pairs.
3. Speak one of the wire protocols in [PACK.md](./PACK.md): one request frame in, one response
   frame out, deterministic, and stateless between calls.
4. Add your program to `pack.json` (or regenerate the index).
5. `make build && make test`.

## Determinism and period discipline

- Same request bytes ⇒ same response bytes. No wall clock; seed any randomness from the request.
- Stay within period-plausible language constructs, and document approximations rather than
  hiding them.
- No film assets, audio, or transcript text. The short canonical lines already present are the
  ceiling.

## Sharing your own pack

You do not need to contribute here to be hosted. Any collection of programs following this
layout and the [PACK.md](./PACK.md) format is a valid pack — bundle it with `make pack` and an
operator can import your `.woprpack` alongside this one.
