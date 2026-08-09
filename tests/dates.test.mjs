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
