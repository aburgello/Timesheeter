// Department settings (src/lib/departments.js) and the shared cache's team
// filter (filterToTeams). No department is special-cased by name: Motion,
// Print and the rest differ only through the settings table, a department
// added in Administration gets the standard setup, and an untagged person
// gets a neutral one.
import {
  pageIdsFor,
  hasFeature,
  usesTeamBoard,
  boardLabelFor,
  canvasLabelFor,
  countedStatusFor,
  jobQuickFiltersFor,
} from "../src/lib/departments.js";
import { filterToTeams } from "../src/lib/wrikeEnrich.js";

const NOBODY = "NOT_A_MANAGER";

check("pages: Motion", pageIdsFor("Motion", NOBODY), ["todayslist", "canvas", "legacy", "profile"]);
check("pages: PM", pageIdsFor("PM", NOBODY), ["jobbook", "legacy", "profile"]);
check("pages: a department added in Administration gets the standard set", pageIdsFor("Sound", NOBODY), ["todayslist", "canvas", "legacy", "profile"]);
check("pages: untagged gets a neutral set, no Canvas", pageIdsFor(null, NOBODY), ["todayslist", "legacy", "profile"]);

check("labels: every department's board is named the same way", [boardLabelFor("Motion"), boardLabelFor("Print")], ["Motion Board", "Print Board"]);
check("labels: untagged board", boardLabelFor(null), "Team Board");
check("labels: canvas", [canvasLabelFor("Motion"), canvasLabelFor(null)], ["Motion Canvas", "Campaign Canvas"]);

check("features: DOOH Specs is Motion's", [hasFeature("Motion", "doohSpecs"), hasFeature("Print", "doohSpecs")], [true, false]);
check("features: Launch Tracker is Print's", [hasFeature("Print", "launchTracker"), hasFeature("Motion", "launchTracker")], [true, false]);
check("features: none without a department", hasFeature(null, "doohSpecs"), false);
check("header count: Motion counts its status, others overdue", [countedStatusFor("Motion"), countedStatusFor("Print")], ["Motion", null]);
check("quick filters: Print leads with LAUNCH", jobQuickFiltersFor("Print")[0], "LAUNCH");
check("quick filters: default leads with DOOH", jobQuickFiltersFor("AM")[0], "DOOH");

check(
  "team board departments are the ones the cache keeps tasks for",
  ["Motion", "Print", "AM", "Digital", "PM", "Operations", "Sound", null].map(usesTeamBoard),
  [true, true, true, true, false, false, true, false]
);

// The cache filter: assignment by Wrike id, plus the existing title, folder
// and subtask rules.
{
  const folders = { DIG: { id: "DIG", title: "Digital" }, OTHER: { id: "OTHER", title: "Print" } };
  const team = new Set(["U_PRINT", "U_MOTION"]);
  const tasks = [
    { id: "a", title: "Poster", responsibleIds: ["U_PRINT"], parentIds: ["OTHER"] },
    { id: "b", title: "Poster", responsibleIds: ["U_PM"], parentIds: ["OTHER"] },
    { id: "c", title: "UK_DOOH_Cut", responsibleIds: [], parentIds: [] },
    { id: "d", title: "Banner", responsibleIds: [], parentIds: ["DIG"] },
    { id: "e", title: "ODY_Launch_Markets", responsibleIds: [], parentIds: [] },
    { id: "f", title: "Parent", responsibleIds: [], parentIds: [], subTaskIds: ["g"] },
    { id: "g", title: "Child", responsibleIds: ["U_MOTION"], parentIds: [] },
    { id: "h", title: "", responsibleIds: ["U_PRINT"] },
  ];
  check(
    "cache filter: team member, keyword, Digital folder, launch hub, via a subtask",
    filterToTeams(tasks, folders, team).map((t) => t.id),
    ["a", "c", "d", "e", "f", "g"]
  );
}
