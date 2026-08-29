-- The `sessions.surface` CHECK is a THIRD copy of the surface allowlist, and it
-- was the one nobody updated. The other two are `DEFAULT_LINKS`
-- (emulator/node/app/main.py) and `surface_links` (emulator/relay/src/config.ts).
--
-- Consequences, both live in production before this migration: `wopr-panel` has
-- been minting 500s against Neon since it was added, and the two machine
-- surfaces — the ends of every machine-to-machine call — could not mint a
-- session at all, so a placed call died at the database. Neither shows up in
-- tests, because the test suite runs the in-memory store.
--
-- `tests/test_session_surfaces.py` now pins this list against DEFAULT_LINKS, so
-- the next surface cannot be added to the code and forgotten here.
alter table sessions drop constraint if exists sessions_surface_check;
alter table sessions add constraint sessions_surface_check
  check (surface in (
    'home-terminal',
    'norad-terminal',
    'norad-bigboard',
    'wopr-panel',
    'trunk-call',
    'trunk-caller'
  ));
