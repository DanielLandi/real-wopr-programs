-- `event_logs.kind` allowed 'handshake'. Nothing has ever logged it: the word
-- appears in the bridge only as prose ("the WS handshake"), never as a kind,
-- in any commit since the store arrived (#63). A constraint wider than the
-- code is not a bug, but it is a lie about what the system does, and it hides
-- the next drift — so the list is narrowed to what the bridge writes.
--
-- This is the same shape as 0002 and the same guard: `EVENT_KINDS`
-- (emulator/node/app/store.py) is the Python copy, and
-- tests/test_check_constraints.py pins the two against each other in both
-- directions (#91). No row can carry 'handshake', so the ALTER validates
-- against existing data trivially.
alter table event_logs drop constraint if exists event_logs_kind_check;
alter table event_logs add constraint event_logs_kind_check
  check (kind in ('input', 'route', 'core', 'joshua', 'error'));
