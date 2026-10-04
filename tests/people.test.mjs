// Wrike group → department matching for "Sync from Wrike", and who counts as
// having left. The match used to be a substring test either way round, so any
// group with "team" in its name became AM (te-AM) and "Development" became PM.
import { departmentForGroup, hasLeft } from "../src/lib/people.js";

const DEPTS = ["AM", "Digital", "Motion", "Operations", "PM", "Print"];
const cases = [
  ["Motion", "Motion"],
  ["Motion Team", "Motion"],
  ["motion team", "Motion"],
  ["PM", "PM"],
  ["PM Team", "PM"],
  ["Print Department", "Print"],
  ["Digital 🎨", "Digital"],
  ["AM", "AM"],
  ["Camera Team", null],
  ["Development", null],
  ["All Teams", null],
  ["Amends", null],
  ["Print & Digital", null],
  ["", null],
];
check(
  "group match: exact department names only",
  cases.map(([title]) => departmentForGroup(title, DEPTS)),
  cases.map(([, want]) => want)
);

check("left: only with a left_at date", [hasLeft({ left_at: "2026-10-01T00:00:00Z" }), hasLeft({ left_at: null }), hasLeft({}), hasLeft(null)], [true, false, false, false]);
