import test from "node:test";
import assert from "node:assert/strict";

import {
  dailyWindowState,
  isSubmissionWindowOpen,
  localDateKeyFor,
  nextSubmissionWindowOpenAt,
} from "../scripts/daily-window.mjs";

const at = (value) => new Date(value);

test("Shanghai submission window closes exactly at 20:00 and report starts at 20:30", () => {
  assert.equal(isSubmissionWindowOpen({ now: at("2026-08-08T11:59:59Z") }), true);
  const cutoff = dailyWindowState({ now: at("2026-08-08T12:00:00Z") });
  assert.equal(cutoff.open, false);
  assert.equal(cutoff.report_eligible, false);
  assert.equal(dailyWindowState({ now: at("2026-08-08T12:30:00Z") }).report_eligible, true);
});

test("Shanghai midnight resets the date and reopens submissions", () => {
  const state = dailyWindowState({ now: at("2026-08-08T15:59:59Z") });
  assert.equal(state.date, "2026-08-08");
  assert.equal(state.open, false);
  const next = dailyWindowState({ now: at("2026-08-08T16:00:00Z") });
  assert.equal(next.date, "2026-08-09");
  assert.equal(next.open, true);
  assert.equal(localDateKeyFor("2026-08-08T16:00:00Z"), "2026-08-09");
  assert.equal(nextSubmissionWindowOpenAt({ now: at("2026-08-08T20:00:00Z") }).toISOString(), "2026-08-09T16:00:00.000Z");
});

test("clock configuration is validated", () => {
  assert.throws(
    () => dailyWindowState({ cutoff: "24:00" }),
    /cutoff must use HH:MM/,
  );
  assert.throws(
    () => dailyWindowState({ reportAfter: "8:30" }),
    /reportAfter must use HH:MM/,
  );
});
