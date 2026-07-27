"""WOPR DEVELOPMENT SYSTEM — a period line-oriented dev session over the real repo.

Not a game surface: a contributor tool. It recreates the 1980s edit/compile/run
loop (DEC SOS line editor + `.R FORTRAN` / `.EXECUTE`, and a Lisp listener) as a
*proxy to the actual source files* in this repo — you edit the same
games/ and joshua/ files a text editor would, then compile and run
them with the real toolchain. Local contributor tooling ONLY; never a service.
"""
