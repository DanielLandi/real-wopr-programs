import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { DIAL_SYSTEMS, WARDIAL_LABELS } from "./sims.ts";
import { DIALABLE_SYSTEMS } from "./dial-systems.generated.ts";

const dialable = new Set(DIALABLE_SYSTEMS.map((s) => s.systemId));

test("every systemId the phone book offers is actually dialable", () => {
  // The bug this file exists to prevent: sims.ts named `school` after the
  // number moved to `school-mon`, and the film's school dial answered
  // SYSTEM UNREACHABLE while every suite stayed green.
  for (const entry of DIAL_SYSTEMS) {
    assert.ok(dialable.has(entry.systemId), `${entry.systemId} is not a dialable system`);
  }
});

test("every wardial label keys off a dialable system", () => {
  // LABELS failed soft via `?? "CARRIER"`, so a stale key cost a carrier its
  // domain label and surfaced nowhere.
  for (const id of Object.keys(WARDIAL_LABELS)) {
    assert.ok(dialable.has(id), `${id} is not a dialable system`);
  }
});

test("numbers come from the manifests, not from a second hand-typed copy", () => {
  const byId = new Map(DIALABLE_SYSTEMS.map((s) => [s.systemId, s]));
  for (const entry of DIAL_SYSTEMS) {
    assert.equal(entry.number, byId.get(entry.systemId).number, `${entry.systemId} number drifted`);
  }
});

test("the school dials the monitor, which is the film's beat", () => {
  const school = DIAL_SYSTEMS.find((e) => e.name.includes("SCHOOL"));
  assert.equal(school.systemId, "school-mon");
  assert.equal(school.number, "(206) 555-0142");
});

test("reference is dialable but deliberately not in the film's phone book", () => {
  assert.ok(dialable.has("reference"));
  assert.ok(!DIAL_SYSTEMS.some((e) => e.systemId === "reference"));
});

// --- Coverage for the import-time guard itself ------------------------------
//
// The five tests above are a tautology over the join: DIAL_SYSTEMS and
// WARDIAL_LABELS are *derived from* LISTED, so they can never disagree with
// it, and none of them read UNLISTED at all. All of the guard's discriminating
// power lives in the three `throw` loops in sims.ts, which run once at module
// scope during import — by the time a test file gets to make assertions,
// sims.ts has either already thrown (crashing the whole test file) or already
// proven every id, so there is nothing left in-process to poison and no way
// to call the loops again.
//
// So these tests re-run the *real* sims.ts source, mutated to reintroduce a
// bad id, in a fresh module instance via dynamic import of a sibling copy —
// exercising the actual guard code, not a reimplementation of it.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SIMS_SRC = readFileSync(join(__dirname, "sims.ts"), "utf8");

/** Write `mutate(SIMS_SRC)` to a same-directory sibling of sims.ts (so its
 *  own relative import of dial-systems.generated.ts still resolves), import
 *  it fresh, and return whatever the import settles to. Always cleans up the
 *  temp file, even if the import throws. */
async function importMutatedSims(mutate, tmpName) {
  const src = mutate(SIMS_SRC);
  assert.notEqual(src, SIMS_SRC, `mutation for ${tmpName} did not match anything in sims.ts`);
  const tmpPath = join(__dirname, tmpName);
  writeFileSync(tmpPath, src);
  try {
    return await import(pathToFileURL(tmpPath).href);
  } finally {
    unlinkSync(tmpPath);
  }
}

test("the import-time guard rejects a LISTED id that is not dialable (replays the shipped bug)", async () => {
  await assert.rejects(
    () =>
      importMutatedSims(
        (src) => src.replace('systemId: "school-mon"', 'systemId: "school"'),
        "sims.poison-listed.tmp.ts",
      ),
    /sims\.ts lists "school", which is not a dialable system/,
  );
});

test("the import-time guard rejects an UNLISTED id that is not dialable", async () => {
  await assert.rejects(
    () =>
      importMutatedSims(
        (src) => src.replace("reference:", '"not-a-real-system-id":'),
        "sims.poison-unlisted.tmp.ts",
      ),
    /sims\.ts excludes "not-a-real-system-id", which is not a dialable system/,
  );
});

test("the import-time guard rejects a dialable system that is neither listed nor excluded", async () => {
  // The inversion this whole design exists to prevent: add a new dialable
  // system (a manifest with a "number") and forget to mention it in
  // sims.ts. It must fail loudly at import, not silently miss the phone
  // book and the wardial sweep with every suite staying green.
  await assert.rejects(
    () =>
      importMutatedSims(
        (src) => src.replace('  { systemId: "airline", name: "PAN AM / PANAMAC", label: "AIRLINE" },\n', ""),
        "sims.poison-orphan.tmp.ts",
      ),
    /sims\.ts does not mention "airline".*dialable/s,
  );
});

test("the import-time guard also catches an emptied UNLISTED table (no other tell would)", async () => {
  // UNLISTED has no consumer besides these validation loops, so gutting the
  // table entirely (as opposed to poisoning its one key) used to be
  // invisible to every test in this file. Now the third loop above catches
  // it the same way it catches any other orphaned dialable id: "reference"
  // is dialable, not in LISTED, and — once UNLISTED is empty — not in
  // UNLISTED either.
  await assert.rejects(
    () =>
      importMutatedSims(
        (src) =>
          src.replace(
            '  reference: "the SYSTEM/1 reference implementation — not a system in the film",\n',
            "",
          ),
        "sims.poison-emptied-unlisted.tmp.ts",
      ),
    /sims\.ts does not mention "reference".*dialable/s,
  );
});
