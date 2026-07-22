# Toolchains

Each program builds with the compiler or interpreter for its language. You only need the ones
for the programs you touch — `make build` reports (and fails) a program whose toolchain is
absent without stopping the others.

| Language | Programs | Tool | macOS (Homebrew) | Debian / Ubuntu |
|---|---|---|---|---|
| Fortran | all `games/` | `gfortran` | `brew install gcc` | `apt install gfortran` |
| Common Lisp | `joshua/` | `sbcl` | `brew install sbcl` | `apt install sbcl` |
| COBOL | `airline`, `reference` | `cobc` (GnuCOBOL) | `brew install gnucobol` | `apt install gnucobol` |
| C | `pactel` | `cc` / `gcc` | Xcode Command Line Tools | `apt install gcc` |
| 6502 assembly | `protovision` | `cl65` + `sim65` (cc65) | `brew install cc65` | `apt install cc65` |
| BASIC | `school` | `bwbasic` (Bywater BASIC) | build from source | `apt install bwbasic` |

`bwbasic` (Bywater BASIC) is packaged on Debian/Ubuntu (`apt install bwbasic`) but has no
Homebrew formula — on macOS, build Bywater BASIC 2.20pl2 from the Debian source and put it on
your `PATH`. It stands in for the film-era RSTS/E BASIC-PLUS (a documented dialect approximation).

Everything on one Debian box:

```
sudo apt-get update && sudo apt-get install -y gfortran sbcl gnucobol bwbasic cc65 gcc
```
