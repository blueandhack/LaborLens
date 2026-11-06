import { formatWageRange } from "./wage.js";

export function getStatusClass(status) {
  const value = String(status || "").toLowerCase();
  if (value.includes("denied")) return "denied";
  if (value.includes("expired")) return "expired";
  if (value.includes("withdrawn")) return "withdrawn";
  if (value.includes("certified")) return "certified";
  if (value.includes("determination issued")) return "issued";
  return "other";
}

export function formatStatus(status) {
  if (!status) return "Not reported";
  // Retain every qualifier, including expired certifications and redeterminations.
  return String(status)
    .toLowerCase()
    .replace(/(^|[\s-])\S/g, (letter) => letter.toUpperCase());
}

export function elapsedDays(received, outcome) {
  if (
    ![received, outcome].every(
      (value) =>
        typeof value === "string" && /^\d{4}-\d{2}-\d{2}(T|$)/.test(value),
    )
  )
    return null;
  const start = new Date(received);
  const end = new Date(outcome);
  const calendarDate = (date) =>
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const days = (calendarDate(end) - calendarDate(start)) / 86400000;
  return Number.isFinite(days) && days >= 0 ? days : null;
}

export function presentCase(record, program) {
  const perm = program === "perm";
  return {
    employer:
      (perm ? record.EMP_BUSINESS_NAME : record.EMPLOYER_LEGAL_BUSINESS_NAME) ||
      "Employer not reported",
    title: record.JOB_TITLE || "Job title not reported",
    location:
      [
        perm ? record.EMP_CITY : record.EMPLOYER_CITY,
        perm ? record.EMP_STATE : record.EMPLOYER_STATE,
      ]
        .filter(Boolean)
        .join(", ") || "Location not reported",
    wage: perm
      ? formatWageRange(
          record.JOB_OPP_WAGE_FROM,
          record.JOB_OPP_WAGE_TO,
          record.JOB_OPP_WAGE_PER,
        )
      : formatWageRange(record.PWD_WAGE_RATE, null, record.PWD_UNIT_OF_PAY),
    eventDate: perm ? record.DECISION_DATE : record.DETERMINATION_DATE,
    elapsed: elapsedDays(
      record.RECEIVED_DATE,
      perm ? record.DECISION_DATE : record.DETERMINATION_DATE,
    ),
    status: formatStatus(record.CASE_STATUS),
    statusClass: getStatusClass(record.CASE_STATUS),
  };
}

export function formatCaseDate(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}(T|$)/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    return "Not reported";
  return new Date(value).toLocaleDateString("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
