import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatStatus,
  getStatusClass,
  presentCase,
  elapsedDays,
  formatCaseDate,
} from "../src/utils/casePresentation.js";
import { readSearchState, writeSearchState } from "../src/utils/searchState.js";

test("long statuses and certification qualifiers remain complete", () => {
  assert.equal(formatStatus("DETERMINATION ISSUED"), "Determination Issued");
  assert.equal(formatStatus("CERTIFIED-EXPIRED"), "Certified-Expired");
  assert.equal(getStatusClass("CERTIFIED-EXPIRED"), "expired");
  assert.equal(
    formatStatus("REDETERMINATION ISSUED"),
    "Redetermination Issued",
  );
});
test("research summaries distinguish offered from prevailing wages and retain missing source values", () => {
  assert.equal(elapsedDays("2026-06-01T23:30:00Z", "2026-06-02T00:00:00Z"), 1);
  const record = {
    PWD_WAGE_RATE: 25,
    PWD_UNIT_OF_PAY: "Hour",
    JOB_OPP_WAGE_FROM: 52000,
    JOB_OPP_WAGE_TO: 60000,
    JOB_OPP_WAGE_PER: "Year",
  };
  assert.equal(presentCase(record, "pwd").wage, "$25 / Hour");
  assert.equal(presentCase(record, "perm").wage, "$52,000 – $60,000 / Year");
  assert.match(
    presentCase({ PWD_WAGE_RATE: 25 }, "pwd").wage,
    /pay period not reported/,
  );
  assert.equal(elapsedDays(null, "2026-06-30"), null);
  assert.equal(elapsedDays("2026-07-01", "2026-06-30"), null);
  assert.equal(
    elapsedDays("2026-06-01T00:00:00.000Z", "2026-06-30T00:00:00.000Z"),
    29,
  );
  assert.equal(formatCaseDate("2008-01-01T00:00:00.000Z"), "Jan 1, 2008");
});
test("search URLs retain filters, page size, and layout across case navigation", () => {
  const original = new URLSearchParams(
    "company=Amazon&jobTitle=Engineer&determinationYear=2026&page=3&limit=48&view=table",
  );
  const { filters, page, limit } = readSearchState(original, "pwd");
  const roundTrip = writeSearchState(
    filters,
    page,
    limit,
    original.get("view"),
  );
  assert.equal(roundTrip.get("company"), "Amazon");
  assert.equal(roundTrip.get("jobTitle"), "Engineer");
  assert.equal(roundTrip.get("determinationYear"), "2026");
  assert.equal(roundTrip.get("page"), "3");
  assert.equal(roundTrip.get("view"), "table");
  assert.equal(
    readSearchState(new URLSearchParams("page=-1&limit=100000"), "perm").page,
    1,
  );
  assert.equal(
    readSearchState(new URLSearchParams("page=-1&limit=100000"), "perm").limit,
    24,
  );
});
