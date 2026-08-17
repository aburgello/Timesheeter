import { countryPullSource, categoryPullSource } from "../src/utils/pullSource.js";
import { categoryFamilyWithSource } from "../src/utils/categoryFamily.js";

// Each of resolveCountriesWithSource's four rules explains itself.
check("the task's own name", countryPullSource("task-name"), "Country read from the country code ending the task's own name.");
check("the parent task's name", countryPullSource("parent-task-name"), "Country read from the country code ending its parent task's name.");
check("the folder", countryPullSource("folder"), "Country read from the folder the task sits in.");
check("the Country field", countryPullSource("country-field"), "Country read from the Country field on the task.");

// The unpinned reader says so out loud — this is the mode the Norway incident
// came from, and a member seeing a strange market deserves to know it ran.
check(
  "the unpinned sweep names itself",
  countryPullSource("custom-field-sweep"),
  "Country read from a custom field matched by its value, not by id."
);

// "No country" is a deliberate answer, so it gets a reason of its own. This is
// the row Daisy reported: a red Country chip with nothing explaining it.
check(
  "an empty country explains itself",
  countryPullSource("none"),
  "No country: nothing in the task name, its parent task, the folders above it, or the Country field named one."
);

// A row read back from Supabase carries no source — provenance describes the
// PULL, not the row, so it is never persisted. No tooltip beats a stale one.
check("a reloaded row says nothing", countryPullSource(undefined), "");
check("nor does an empty source", countryPullSource(""), "");
check("nor an unrecognised one", countryPullSource("something-else"), "");

// Category: where the Print/Digital half came from.
check("the discipline folder", categoryPullSource("folder"), "Print/Digital decided by the Print/Digital folder in Wrike.");
check("the task's text", categoryPullSource("task-text"), "Print/Digital decided by the words in the task's own text.");
check(
  "no evidence, default stands",
  categoryPullSource("default"),
  "Print/Digital decided by your default category — nothing said Print or Digital."
);
check(
  "no evidence and no default",
  categoryPullSource("fallback"),
  "Print/Digital decided by the keyword fallback — nothing said Print or Digital."
);
check(
  "a Wrike status that matched a category outright",
  categoryPullSource("wrike-status"),
  "Category taken from the task's Wrike status, which matched a category exactly."
);
check("a reloaded category says nothing", categoryPullSource(undefined), "");

// The source the pull actually records, from the resolver that decides it.
check(
  "the tree answering is reported as the folder",
  categoryFamilyWithSource("Digital", "PP3 - AUS - DOOH - Batch 1 TMRW"),
  { family: "Digital", source: "folder" }
);
check(
  "the text answering is reported as the text",
  categoryFamilyWithSource("", "Studio/Paramount/Tad/Print/INTL"),
  { family: "Print", source: "task-text" }
);
check(
  "neither answering reports no source",
  categoryFamilyWithSource("", "PP3 - AUS - DOOH - Batch 1 TMRW"),
  { family: "", source: "" }
);
