// Every way a row reaches Legacy has to agree on its time.
//
// A row carries its time twice: as text ("0:30"), which is shown, saved and
// summed into the day total, and as seconds (rawSeconds / additionalSeconds),
// which the consolidated group header and Copy Me! add up. If the two drift,
// the header and the timesheet disagree with the grid. Each case below builds
// a row the way that path in LegacyTimesheets.js does, puts it through
// normaliseLegacyRow as addRow/addRows/the grid do, and checks both copies.
import { normaliseLegacyRow } from "../src/utils/legacyRow.js";
import { mergeRows, mergeIntoSheet } from "../src/utils/mergeMultiCountry.js";
import { parseTimeToSeconds, parseTimeToHours, secondsToHM } from "../src/utils/timeHelpers.js";
import { TIME_OPTIONS } from "../src/components/legacy/legacyConstants.js";

const base = {
  jobNumber: "Street Fighter : XY026066, INTL PRINT Outdoor Campaign Bespoke",
  dayOfWeek: "Thursday",
  category: "Print - Project Management",
  territory: "Portugal",
};
let n = 0;
const row = (extra) => ({ id: `r${++n}`, ...base, timeSpent: "none", additionalTime: "none", ...extra });

// Pull Wrike Times: the summed timelog hours, to the minute, no add. time.
const pulled = row({ timeSpent: secondsToHM((7 / 60) * 3600), _rawHours: 7 / 60, wrikeTimelogId: "L1" });
// The same pull with markets merged, into a row already on the sheet.
const sheetRow = normaliseLegacyRow(row({ territory: "Sweden", timeSpent: "0:30", wrikeTimelogId: "L0" }));
const mergedPull = mergeIntoSheet([pulled], [sheetRow]).rows[0];
// The Wrike Timesheets modal's time picker.
const picked = row({ timeSpent: TIME_OPTIONS[2] });
// Rows saved before the picker went H:MM.
const oldDecimal = row({ timeSpent: "0.5", additionalTime: "2" });
// Duplicate: the source's fields, time blanked.
const source = normaliseLegacyRow(row({ timeSpent: "1:30", additionalTime: "0:45" }));
const { id: _i, wrikeTimelogId: _l, taskId: _t, ...rest } = source;
const duplicate = { ...rest, id: "dup", taskId: null, timeSpent: "none", additionalTime: "none" };
// Merge in the selection bar, and its Undo putting the originals back.
const toMerge = [
  normaliseLegacyRow(row({ territory: "Peru", timeSpent: "0:30", additionalTime: "0:15" })),
  normaliseLegacyRow(row({ territory: "Chile", timeSpent: "1:00" })),
];
const merged = { ...mergeRows(toMerge), id: "merged" };
// What did I work on?, with overtime as add. time.
const suggested = row({ timeSpent: secondsToHM(0.75 * 3600), additionalTime: secondsToHM(0.5 * 3600) });

const cases = {
  "Wrike Pull": pulled,
  "Wrike Pull, markets merged": mergedPull,
  "Wrike Timesheets picker": picked,
  "a row saved as 0.5 / 2": oldDecimal,
  "Duplicate": duplicate,
  "Merge": merged,
  "Merge's Undo (first original)": toMerge[0],
  "What did I work on?": suggested,
};
const expected = {
  "Wrike Pull": ["0:07", "none"],
  "Wrike Pull, markets merged": ["0:37", "none"],
  "Wrike Timesheets picker": ["0:30", "none"],
  "a row saved as 0.5 / 2": ["0:30", "2:00"],
  "Duplicate": ["none", "none"],
  "Merge": ["1:30", "0:15"],
  "Merge's Undo (first original)": ["0:30", "0:15"],
  "What did I work on?": ["0:45", "0:30"],
};

const added = {};
for (const [name, r] of Object.entries(cases)) {
  const shown = normaliseLegacyRow(r);
  added[name] = shown;
  check(`timing: ${name} shows the expected time`, [shown.timeSpent, shown.additionalTime], expected[name]);
  check(`timing: ${name} — seconds agree with what's shown`, [shown.rawSeconds, shown.additionalSeconds], [
    parseTimeToSeconds(shown.timeSpent),
    parseTimeToSeconds(shown.additionalTime),
  ]);
}

// The Duplicate case is the one that drifted: its source's 1:30 + 0:45 rode
// along in the copied seconds while the copy showed "none".
check("timing: a duplicate adds nothing to the header or Copy Me!", [added.Duplicate.rawSeconds, added.Duplicate.additionalSeconds], [0, 0]);

// The day total (from the text) and the header / Copy Me! (from the seconds)
// over the whole sheet agree to the second.
const all = Object.values(added);
const dayTotalSeconds = Math.round(
  all.reduce((s, r) => s + parseTimeToHours(r.timeSpent) + parseTimeToHours(r.additionalTime), 0) * 3600
);
const headerSeconds = all.reduce((s, r) => s + r.rawSeconds + r.additionalSeconds, 0);
check("timing: day total and header / Copy Me! agree", dayTotalSeconds, headerSeconds);

// The picker offers H:MM throughout, and every option parses to its own step.
check("timing: picker options are H:MM", TIME_OPTIONS.slice(1).every((o) => /^\d+:\d\d$/.test(o)), true);
check(
  "timing: picker steps are 0:15 apart",
  TIME_OPTIONS.slice(1).every((o, i) => parseTimeToSeconds(o) === (i + 1) * 900),
  true
);
