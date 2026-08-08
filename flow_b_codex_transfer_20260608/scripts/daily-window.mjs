const CLOCK_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;

function assertClock(value, name) {
  const text = String(value || "").trim();
  if (!CLOCK_PATTERN.test(text)) throw new TypeError(`${name} must use HH:MM (00:00-23:59)`);
  return text;
}

function clockMinutes(value) {
  const [hours, minutes] = String(value).split(":").map(Number);
  return hours * 60 + minutes;
}

function localParts(value, timeZone) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((entry) => [entry.type, entry.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

function localDateKey(parts) {
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function nextCalendarDate(parts) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1, 12, 0, 0));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function zonedDateTime(parts, timeZone) {
  const desired = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour || 0),
    Number(parts.minute || 0),
    Number(parts.second || 0),
  );
  let guess = new Date(desired);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const observed = localParts(guess, timeZone);
    if (!observed) break;
    const observedAsUtc = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      observed.second,
    );
    guess = new Date(guess.getTime() + desired - observedAsUtc);
  }
  return guess;
}

export function localDateKeyFor(value = new Date(), timeZone = "Asia/Shanghai") {
  const parts = localParts(value, timeZone);
  return parts ? localDateKey(parts) : null;
}

export function dailyWindowState({
  now = new Date(),
  timeZone = "Asia/Shanghai",
  cutoff = "20:00",
  reportAfter = "20:30",
} = {}) {
  const normalizedCutoff = assertClock(cutoff, "cutoff");
  const normalizedReportAfter = assertClock(reportAfter, "reportAfter");
  const parts = localParts(now, timeZone);
  if (!parts) throw new TypeError("now must be a valid date");
  const date = localDateKey(parts);
  const minuteOfDay = parts.hour * 60 + parts.minute;
  const cutoffMinute = clockMinutes(normalizedCutoff);
  const reportMinute = clockMinutes(normalizedReportAfter);
  const open = minuteOfDay < cutoffMinute;
  const reportEligible = minuteOfDay >= reportMinute;
  const cutoffAt = zonedDateTime({ ...parts, hour: Number(normalizedCutoff.slice(0, 2)), minute: Number(normalizedCutoff.slice(3)), second: 0 }, timeZone);
  const reportAt = zonedDateTime({ ...parts, hour: Number(normalizedReportAfter.slice(0, 2)), minute: Number(normalizedReportAfter.slice(3)), second: 0 }, timeZone);
  const nextDate = nextCalendarDate(parts);
  const nextOpenAt = zonedDateTime({ ...nextDate, hour: 0, minute: 0, second: 0 }, timeZone);
  return {
    date,
    time_zone: timeZone,
    cutoff: normalizedCutoff,
    report_after: normalizedReportAfter,
    minute_of_day: minuteOfDay,
    open,
    report_eligible: reportEligible,
    cutoff_at: cutoffAt.toISOString(),
    report_at: reportAt.toISOString(),
    next_open_at: nextOpenAt.toISOString(),
  };
}

export function isSubmissionWindowOpen(options = {}) {
  return dailyWindowState(options).open;
}

export function nextSubmissionWindowOpenAt(options = {}) {
  return new Date(dailyWindowState(options).next_open_at);
}

export function parseClockMinutes(value, name = "clock") {
  return clockMinutes(assertClock(value, name));
}

