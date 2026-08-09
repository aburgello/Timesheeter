import { toIsoDate, isoToday, isoToUk, toDbDate } from "../src/utils/dates.js";

// Both stored shapes normalise
check("ISO passes through",           toIsoDate("2026-01-05"), "2026-01-05");
check("UK slash is DAY first",        toIsoDate("09/08/2026"), "2026-08-09");
check("unpadded UK slash",            toIsoDate("9/8/2026"),   "2026-08-09");
check("day > 12 proves day-first",    toIsoDate("30/06/2026"), "2026-06-30");

// The ordering failures this whole change exists to fix
check("30 June sorts before 1 July",
  [toIsoDate("30/06/2026"), toIsoDate("01/07/2026")].sort(),
  ["2026-06-30", "2026-07-01"]);
check("mixed formats sort together",
  [toIsoDate("09/08/2026"), toIsoDate("2026-01-05")].sort(),
  ["2026-01-05", "2026-08-09"]);

// Absent / unusable input is null, never a guess and never today's date
check("null",        toIsoDate(null),          null);
check("empty",       toIsoDate(""),            null);
check("whitespace",  toIsoDate("   "),         null);
check("nonsense",    toIsoDate("not a date"),  null);
check("partial",     toIsoDate("2026-08"),     null);

// isoToday is LOCAL — a UTC formatter returns tomorrow for this input
check("local, not UTC", isoToday(new Date(2026, 7, 9, 23, 30)), "2026-08-09");

// Display helper
check("iso to UK",        isoToUk("2026-08-09"), "09/08/2026");
check("iso to UK, null",  isoToUk(null),         "");

// The value that goes into the work_date column, from whatever a caller set.
check("from UK text",       toDbDate("09/08/2026"), "2026-08-09");
check("from ISO text",      toDbDate("2026-08-09"), "2026-08-09");
check("unparseable → null", toDbDate("garbage"),    null);
check("absent → null",      toDbDate(null),         null);

// ── ukDateForWeekday — the day you picked, not the day you clicked ──────────
import { ukDateForWeekday } from "../src/utils/dates.js";

// Wed 12 Aug 2026. Week runs Mon 10 → Sun 16.
const wed = new Date(2026, 7, 12);
check("backfilling Monday on a Wednesday", ukDateForWeekday("Monday", wed),    "10/08/2026");
check("today itself",                      ukDateForWeekday("Wednesday", wed), "12/08/2026");
check("later in the same week",            ukDateForWeekday("Friday", wed),    "14/08/2026");
check("Sunday closes the week",            ukDateForWeekday("Sunday", wed),    "16/08/2026");

// Sunday 9 Aug 2026 belongs to the week that began Mon 3 Aug — the case that
// made a Monday entry vanish when the week rolled over.
const sun = new Date(2026, 7, 9);
check("Sunday belongs to the week just ending", ukDateForWeekday("Sunday", sun), "09/08/2026");
check("Monday from that Sunday is the 3rd",     ukDateForWeekday("Monday", sun), "03/08/2026");

// Month and year boundaries
check("crosses a month boundary", ukDateForWeekday("Monday", new Date(2026, 8, 2)),  "31/08/2026");
check("crosses a year boundary",  ukDateForWeekday("Monday", new Date(2027, 0, 1)),  "28/12/2026");

// Unknown names fall back to today rather than guessing
check("unknown weekday", ukDateForWeekday("Someday", wed), "12/08/2026");
check("undefined",       ukDateForWeekday(undefined, wed), "12/08/2026");
