import test from "node:test";
import assert from "node:assert/strict";
import {
  ACCESS_CODE_PROMPT,
  awaitingAccessCode,
  clearanceFromText,
  lastNonEmptyLine,
  wallUrl,
} from "./logon.ts";

test("awaitingAccessCode: true only when the prompt is the last line", () => {
  assert.equal(awaitingAccessCode("WOPR> LOGON NORAD-3\nACCESS CODE:\n"), true);
  assert.equal(awaitingAccessCode("ACCESS CODE:\nINDENTIFICATION NOT RECOGNIZED BY SYSTEM\n"), false);
  assert.equal(awaitingAccessCode(""), false);
  assert.equal(ACCESS_CODE_PROMPT, "ACCESS CODE:");
});

test("lastNonEmptyLine skips trailing blanks", () => {
  assert.equal(lastNonEmptyLine("A\nB\n\n \n"), "B");
});

test("clearanceFromText parses the banner, last one wins", () => {
  const text = "CLEARANCE ACCEPTED - NORAD-3 LEVEL 3\nDEFCON 5. READY.\n" +
    "CLEARANCE ACCEPTED - NORAD-1 LEVEL 1\nDEFCON 5. READY.\n";
  assert.deepEqual(clearanceFromText(text), { callsign: "NORAD-1", level: 1 });
  assert.equal(clearanceFromText("WOPR> HELLO\n"), null);
});

test("wallUrl appends the room only when present", () => {
  assert.equal(wallUrl("https://x.example/warroom/"), "https://x.example/warroom/");
  assert.equal(wallUrl("https://x.example/warroom/", "ABCDEF"),
    "https://x.example/warroom/?room=ABCDEF");
});
