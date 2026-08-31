# External services

Every external service, API, or paid account this repo depends on.

> **Update rule:** any change that adds, removes, or re-keys an external
> service must update this file in the same commit/PR.

**This repo has no runtime external services.** The programs are period-language
source that builds and runs locally; nothing here opens a network connection, and
there is no key, account, or paid tier to hold. Every hostname in the tree
(`alpha.example`, `comms.invalid`, `relay.invalid`, …) is a reserved test name in
a fixture, never a real endpoint.

| Service | What for | Credentials / env | Console / billing notes |
|---|---|---|---|
| **GitHub** | Hosts the public repo and runs `ci.yml` (checkout, setup-node, setup-python — no third-party actions, no secrets beyond the Actions-provided `GITHUB_TOKEN`) | `gh` CLI auth | Free for public repos; Actions within the account allowance. Account plan tracked in [`dotfiles/SERVICES.md`](../dotfiles/SERVICES.md) |

## Notes

- No secret values in this file — only service identities and where the
  credentials live (Bitwarden item, `.env` name, Actions secret, …).
- **The services behind `realwopr.ai` belong to other repos.** This pack is
  imported into `../real-wopr` (engine/ops, pinned in its `packs.lock`) and
  exported into `../real-wopr-site` (the public pages). Neon, the homelab VPS
  tunnel, the Anthropic key for the Joshua engine and the `realwopr.ai` domain
  are inventoried there, not here — a consumer of this pack takes on none of
  them by importing it.
- If a program ever gains a real endpoint, it stops being a local build and this
  file must gain a row in the same PR.
