/**
 * Company shift: Monday–Saturday 09:00–17:00 in COMPANY_TIMEZONE.
 * Time outside that window (and all Sunday) counts as overtime.
 */

const TIMEZONE = process.env.COMPANY_TIMEZONE || 'Asia/Colombo';
const SHIFT_START_MINUTES = 9 * 60;
const SHIFT_END_MINUTES = 17 * 60;

function zonedParts(date, timeZone = TIMEZONE) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: weekdayMap[parts.weekday],
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

function isShiftDay(weekday) {
  return weekday >= 1 && weekday <= 6;
}

function minutesOfDay(hour, minute) {
  return hour * 60 + minute;
}

function classifyInstant(date, timeZone = TIMEZONE) {
  const parts = zonedParts(date, timeZone);
  if (!isShiftDay(parts.weekday)) {
    return { kind: 'overtime', parts };
  }
  const mins = minutesOfDay(parts.hour, parts.minute);
  if (mins >= SHIFT_START_MINUTES && mins < SHIFT_END_MINUTES) {
    return { kind: 'regular', parts };
  }
  return { kind: 'overtime', parts };
}

/**
 * Split a work interval into regular vs overtime minutes (1-minute resolution).
 */
function analyzeWorkInterval(startedAt, endedAt, timeZone = TIMEZONE) {
  const start = new Date(startedAt);
  const end = new Date(endedAt);
  if (!(start < end)) {
    return {
      regular_minutes: 0,
      overtime_minutes: 0,
      total_minutes: 0,
      is_overtime: false,
      shift_timezone: timeZone,
      shift_window: 'Mon–Sat 09:00–17:00',
    };
  }

  let regular = 0;
  let overtime = 0;
  const cursor = new Date(start);
  while (cursor < end) {
    const next = new Date(Math.min(cursor.getTime() + 60 * 1000, end.getTime()));
    const sample = new Date(cursor.getTime() + Math.floor((next.getTime() - cursor.getTime()) / 2));
    const minutes = (next.getTime() - cursor.getTime()) / 60000;
    if (classifyInstant(sample, timeZone).kind === 'regular') regular += minutes;
    else overtime += minutes;
    cursor.setTime(next.getTime());
  }

  const regularMinutes = Math.round(regular);
  const overtimeMinutes = Math.round(overtime);
  return {
    regular_minutes: regularMinutes,
    overtime_minutes: overtimeMinutes,
    total_minutes: regularMinutes + overtimeMinutes,
    is_overtime: overtimeMinutes > 0,
    shift_timezone: timeZone,
    shift_window: 'Mon–Sat 09:00–17:00',
  };
}

module.exports = {
  TIMEZONE,
  SHIFT_START_MINUTES,
  SHIFT_END_MINUTES,
  analyzeWorkInterval,
  classifyInstant,
  zonedParts,
};
