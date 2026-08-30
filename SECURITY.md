# Security Policy

## Reporting a vulnerability

**Please do not open a public issue.** Use GitHub's private vulnerability
reporting instead: the **Security** tab → **Report a vulnerability**.

That matters more here than the boilerplate suggests. This repository runs
programs written in early-1980s languages as subprocesses, under a modern
harness that feeds them untrusted input from a public phone line. A sandbox
escape, a path that lets a caller reach the filesystem, or anything that turns
a `STATE` block into code is exactly the kind of finding that should not be
described in a public issue before it is fixed.

Ordinary bugs — a program answering wrongly, a fixture that will not
reproduce — are not security reports. Open those as normal issues.

## Scope

In scope: the period programs (`wopr/`, `norad/`, `games/`, `systems/`, `joshua/`) and the harness
that hosts them (`emulator/`), including the wire protocols between them.

Out of scope: the deployed exchange's infrastructure, and anything about the
film itself. Findings against a *hosted* instance you do not operate should go
to whoever operates it.

## What to expect

This is a hobby project maintained by one person, so there is no response-time
commitment. You will get an acknowledgement, and credit in the fix unless you
would rather not have it.
