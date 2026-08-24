# systems/umb — Union Marine Bank

A COBOL back-office inquiry desk for the film's bank, on the SYSTEM/1 tier.
Answers `(408) 555-0164`.

## What is shown, and what is ours

The film shows one thing: a banner.

    UNION MARINE BANK - SOUTHWEST REGIONAL DATA CENTER

That line is the whole of the attestation (`CREDITS.md`) — where in the film it
appears, and what is said around it, are not attested here and are not claimed.
Everything below the banner is our documented interpretation, not a
reconstruction:

| Element | Provenance |
| --- | --- |
| The two banner lines | **shown** — the film |
| Logon prompt, rejection wording, the three-attempt limit | interpretation |
| The service bulletin, and the `UMBFS1` field-service logon it leaks | interpretation |
| `ACCT` / `HIST` / `HELP` / `BYE`, the subsystem name and release | interpretation |
| Every account, branch, balance and transaction | interpretation |

No account belongs to a film character. Inventing one would assert something
the film does not.

This is not a reconstruction of anyone else's bank. Andy Glenn's zompiexx
interpretation is acknowledged in `CREDITS.md` as attestation for the banner
text; his design is not reused here.

## Running it

    systems/umb/harness/build.sh
    tools/test.sh systems

Read-only: no command mutates the data files, and the manifest declares no
persistent node state.
