-- An exchange IS its api endpoint (#101): two rows that dial the same base
-- are one machine, whatever each was named. #142 taught the app layer that —
-- `POST /api/exchanges/register` answers 409 for an api the book already
-- holds under another id, and the home terminal lists one line per endpoint —
-- but the path the flagship's duplicate actually took was neither: a hand
-- INSERT beside the hub's seeded row (real-wopr-site#10). Only the database
-- can refuse that path, so the book's identity rule becomes an index: one row
-- per normalized api, where the normalization is exactly `normalize_api`
-- (emulator/node/app/store.py) — case folded, trailing slashes dropped.
-- tests/test_store_contract.py pins the SQL expression and the Python fold
-- against each other on a table of inputs, and proves a hand insert for a
-- machine already in the book is refused by name.
--
-- If the live table still holds two rows for one endpoint, CREATE INDEX
-- refuses to build — which is the point. Resolve the duplicate first (the
-- survivor is real-wopr-site#10's call), then apply. Batch the apply with the
-- still-unapplied 0003 (real-wopr#215).
create unique index if not exists exchanges_api_normalized_key
  on exchanges (lower(rtrim(api, '/')));
