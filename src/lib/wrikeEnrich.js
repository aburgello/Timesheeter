import { FILM_MAPPINGS, motionTeamShortName, TERRITORIES, REGION_ALIASES, MAGI_MARKET_CODES, MAGI_MARKET_FOLDERS, COUNTRY_SUFFIX_EXCEPTIONS } from "../constants.js";
import { countriesFromFolderNames } from "../utils/countryCodes";
import { familyFromFolderName } from "../utils/categoryFamily";
import { countryFieldIds } from "./countryField";
import { fetchRetrying } from "./fetchPool";
import { studioNameOf, studioKeywordOf } from "./studios";

// Resolve a film-code folder/name (e.g. "ZAL", "ody", "DDA") to its full
// title via FILM_MAPPINGS; returns the title-cased input untouched when no
// mapping exists. Used by getFilmName's tree-climb and path fallback so
// "ZAL" doesn't slip through as projectName when the Wrike folder itself
// is named after the code, not the film.
const titleCase = (s) =>
  s.trim().toLowerCase().split(" ").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
const resolveFilmCode = (name) => {
  if (!name) return name;
  const key = name.trim().toUpperCase();
  if (FILM_MAPPINGS?.[key]) return FILM_MAPPINGS[key];
  return titleCase(name.replace(/[_|-]/g, " "));
};

// Every token the territory guesser can recognise (full names + aliases like
// AE/AUS), uppercased — used below to decide which customFields values are
// worth keeping in the cache. Mirrors guessFieldsFromTask's own sources so
// the cache keeps exactly what that guesser could ever match on.
// _Multiple_ and the agreed exception words are included here even though the
// old guesser refused to infer them: this set decides what survives into the
// cache, and a Country field reading "Markets" has to reach the resolver to be
// read as one. Deciding whether a value counts is countryCodes.js's job now.
// MAGI's own codes are in here too. They were missed first time round, and the
// gap is invisible until it bites: a Country field reading "BEL-FL" survives
// only because "BEL" happens to also be a REGION_ALIAS, while a MAGI-only code
// would be dropped from the cache before the resolver — which CAN read it —
// ever saw it. Whatever the resolver can read, the cache has to keep.
const TERRITORY_TOKENS = new Set(
  [
    ...TERRITORIES,
    ...Object.keys(REGION_ALIASES),
    ...Object.keys(MAGI_MARKET_CODES),
    ...Object.keys(MAGI_MARKET_FOLDERS),
    ...Object.keys(COUNTRY_SUFFIX_EXCEPTIONS),
  ].map((t) => String(t).toUpperCase())
);

const isTerritoryValue = (v) =>
  v.length <= 80 &&
  v.split(/[,/;]+/).some((tok) => TERRITORY_TOKENS.has(tok.trim().toUpperCase()));

// ---------------------------------------------------------------------------
// Parse a Wrike task's HTML description into structured fields
// ---------------------------------------------------------------------------
export function parseWrikeData(htmlString) {
  if (!htmlString) return { tableHtml: "", notesText: "", extractedPathData: "" };

  const tableMatch = htmlString.match(/<table[\s\S]*?<\/table>/i);
  const tableHtml = tableMatch ? tableMatch[0] : "";

  let extractedPathData = "";
  const plainText = htmlString.replace(/<[^>]*>?/gm, " ");
  const folderMatches = plainText.match(/\/Volumes\/[^\s]+/gi);
  if (folderMatches) extractedPathData = folderMatches.join(" ");

  const xyMatch = plainText.match(/(XY\d{5,6})/i);
  if (xyMatch && !extractedPathData.includes(xyMatch[1])) {
    extractedPathData += " " + xyMatch[1];
  }

  let rawText = htmlString
    .replace(/<table[\s\S]*?<\/table>/i, "")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li>/gi, "• ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/\n\s*\n\s*\n/g, "\n\n")
    .trim();

  const textArea = document.createElement("textarea");
  textArea.innerHTML = rawText;

  return {
    tableHtml,
    notesText: textArea.value,
    extractedPathData: extractedPathData.toUpperCase(),
  };
}

// A folder title that cannot be a film: the studio itself, a year, or one of
// the org-chart words.
//
// The studio half used to be a hardcoded list of three — UNIVERSAL, PARAMOUNT,
// SONY — while the studio keyword list in this same file named eight. So a task
// under "Warner Bros / DIGITAL" returned the film name "Warner Bros", and the
// same for Disney, Netflix, Apple, Amazon and Lionsgate. Deriving it from the
// shared list means adding a studio can never leave this behind again.
//
// studioKeywordOf, not a substring test: it treats underscores as separators,
// so "Universal_UK_Archive" is recognised as Universal (a plain word-boundary
// test would miss it, because `_` is a word character) while "Portfolio Mgmt"
// is not mistaken for MGM.
const isNotAFilmName = (title) => {
  const t = String(title || "").trim();
  if (!t) return true;
  if (/^20\d{2}/.test(t)) return true;                 // a year folder
  if (/motion|archive/i.test(t)) return true;          // org-chart words
  return Boolean(studioKeywordOf(t));
};

// ---------------------------------------------------------------------------
// Climb the folder tree to find the film name for a task
// ---------------------------------------------------------------------------
export function getFilmName(task, folderDictionary, extractedPath = "", extraMappings = {}, childToParents = {}) {
  if (!task.title) return "Unknown Project";

  // 1. Tree-climb: find "DIGITAL" or "PRINT" folder, then take its parent as film name.
  // Folders fetched individually (hydration) carry parentIds; the flat /folders list only
  // returns childIds. When parentIds is absent we fall back to the reverse childToParents map
  // built from childIds, so deep hierarchies (task → Job folder → INTL → PRINT → Film) work
  // even when the folder dictionary came from the lightweight flat-list endpoint.
  if (task.parentIds?.length > 0) {
    let queue = [...task.parentIds];
    let visited = new Set(queue);
    let foundFilmName = null;

    while (queue.length > 0) {
      const currentId = queue.shift();
      const currentFolder = folderDictionary[currentId];
      if (!currentFolder) continue;

      // Prefer stored parentIds; fall back to the reverse map, which now yields
      // every parent rather than one arbitrary branch.
      const parentIds = currentFolder.parentIds?.length
        ? currentFolder.parentIds
        : orderedParents(currentId, childToParents, folderDictionary);

      if (["DIGITAL", "PRINT"].includes(currentFolder.title?.trim().toUpperCase())) {
        for (const pid of parentIds) {
          const pName = folderDictionary[pid]?.title || "";
          if (pName && !isNotAFilmName(pName)) {
            foundFilmName = pName;
            break;
          }
        }
        if (foundFilmName) break;
      }

      for (const pid of parentIds) {
        if (!visited.has(pid)) {
          visited.add(pid);
          queue.push(pid);
        }
      }
    }

    if (foundFilmName) {
      return resolveFilmCode(foundFilmName);
    }
  }

  // 2. Path fallback
  if (extractedPath) {
    const parts = extractedPath.split("/");
    const digIdx = parts.findIndex((p) => ["DIGITAL", "PRINT"].includes(p.toUpperCase()));
    if (digIdx > 0) {
      // Same test as the tree climb above — a path segment that names the
      // studio is no more a film than a folder that does.
      let back = digIdx - 1;
      while (back > 0 && isNotAFilmName(decodeURIComponent(parts[back]))) back--;
      if (back > 0 && parts[back].trim()) {
        return resolveFilmCode(decodeURIComponent(parts[back]));
      }
    }
  }

  // 3. Dictionary / prefix fallback
  const rawPrefix = task.title.split(/[_|-]/)[0].trim();
  const lookupKey = rawPrefix.toUpperCase();
  if (FILM_MAPPINGS?.[lookupKey]) return FILM_MAPPINGS[lookupKey];
  if (extraMappings?.[lookupKey]) return extraMappings[lookupKey];

  return rawPrefix
    .toLowerCase()
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// ---------------------------------------------------------------------------
// Climb the folder tree to find the studio for a task
// ---------------------------------------------------------------------------
// Was a second, divergent copy of the studio list — see studios.js for what the
// two disagreeing lists cost. Matching moved there too, so the scanner and the
// enricher can no longer resolve the same folder to different studios.

// Build a childId→parentId[] reverse map from a folderDictionary that has
// childIds. Wrike's /v4/folders returns childIds (downward), not parentIds
// (upward), so we invert the relationship to enable upward tree climbing.
//
// EVERY parent, not one. This used to assign `map[childId] = folder.id`, so the
// last folder iterated won and a folder shared into several places kept a single
// arbitrary parent — arbitrary because the iteration order is just the order
// Wrike's /folders endpoint happened to page the rows in, which it documents no
// guarantee about. Every climb below then followed that one branch.
//
// It was not theoretical. In the Job Book, thirteen rows carrying codes in the
// XY0249xx–XY0251xx range — the range Hamnet and Anemone occupy — are filed
// under the film "Old", whose own campaign ran three years earlier. Every one of
// them has a generic description ("NM Titles", "Packshots FinalWindow"): jobs
// whose own folder name says nothing about the film, so the climb has to go
// upward, and upward it went into a neighbouring campaign's branch.
//
// scanStudioJobNumbers reached the same conclusion for the scan side and its
// `parentsOf` has been an array since; this is that fix carried back to the
// enrich side, which is the one whose output reaches a timesheet.
export function buildChildToParents(folderDictionary) {
  const map = {};
  for (const folder of Object.values(folderDictionary)) {
    for (const childId of folder.childIds || []) {
      if (!map[childId]) map[childId] = [];
      if (!map[childId].includes(folder.id)) map[childId].push(folder.id);
    }
  }
  return map;
}

// A folder that exists to hold finished work rather than to describe it. Same
// test the scanner uses (wrikeCampaign.js isArchiveNode) so a branch treated as
// archived by one is treated as archived by the other.
const isArchiveTitle = (title) =>
  /(^|[\s_])_?archive\b/i.test(title || "") || /master.?template/i.test(title || "");

// The parents of one folder, ordered so a climb is deterministic and prefers a
// live branch over an archived one.
//
// Order matters now that there can be more than one. Two folders at the same
// distance are genuinely ambiguous, and resolving that by object-iteration order
// would mean the same task could enrich differently on two runs against an
// unchanged tree. Sorting by id makes the choice stable; putting non-archive
// branches first makes it the better of the two rather than merely a repeatable
// one. Both rules are cheap, and neither can turn a correct answer into a wrong
// one — they only decide between candidates that were already tied.
function orderedParents(id, childToParents, folderDictionary) {
  const raw = childToParents[id];
  const ids = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return ids.slice().sort((a, b) => {
    const aArch = isArchiveTitle(folderDictionary[a]?.title);
    const bArch = isArchiveTitle(folderDictionary[b]?.title);
    if (aArch !== bArch) return aArch ? 1 : -1;
    return String(a).localeCompare(String(b));
  });
}

export function getStudioName(task, folderDictionary, childToParents = {}) {
  if (!task.parentIds?.length || !folderDictionary) return null;
  const queue = [...task.parentIds];
  const visited = new Set(queue);
  while (queue.length > 0) {
    const id = queue.shift();
    const title = folderDictionary[id]?.title || "";
    if (title) {
      const studio = studioNameOf(title);
      if (studio) return studio;
    }
    // Climb to EVERY parent via the reverse childIds map. Breadth-first, so the
    // nearest studio still wins; what changes is that a nearer studio sitting on
    // a branch this climb used to not know about can now win at all.
    for (const parentId of orderedParents(id, childToParents, folderDictionary)) {
      if (!visited.has(parentId)) {
        visited.add(parentId);
        queue.push(parentId);
      }
    }
  }
  return null;
}

// The market folder a task sits in, resolved to countries. Localisation
// campaigns carry the market in the tree rather than the task name — see
// countriesFromFolderNames — so the climb walks outward from the task's own
// folders and stops at the first one that names a country. Nearest wins, so a
// "Chile" folder beats the "..._Markets" campaign root above it.
//
// Depth is capped: the market folder and its campaign root sit one or two
// levels up, and climbing to the top of the account only risks a distant
// ancestor (a studio or archive folder named after a country) claiming a task
// that nobody labelled.
const FOLDER_COUNTRY_MAX_DEPTH = 4;

export function getFolderCountries(task, folderDictionary, childToParents = {}) {
  if (!task.parentIds?.length || !folderDictionary) return [];
  let level = [...task.parentIds];
  const visited = new Set(level);

  for (let depth = 0; depth < FOLDER_COUNTRY_MAX_DEPTH && level.length; depth++) {
    // Whole level before climbing, so "nearest folder first" holds even when a
    // task sits in several folders at once.
    const names = level.map((id) => folderDictionary[id]?.title || "");
    const found = countriesFromFolderNames(names);
    if (found.length) return found;

    const next = [];
    for (const id of level) {
      for (const parentId of orderedParents(id, childToParents, folderDictionary)) {
        if (!visited.has(parentId)) {
          visited.add(parentId);
          next.push(parentId);
        }
      }
    }
    level = next;
  }
  return [];
}

// The discipline folder a task sits under — "Print" or "Digital", or "" when
// the tree doesn't say.
//
// categoryFamily.js was written around exactly this signal ("print and digital
// work sit in their own Wrike folders") but read it off a /Volumes path scraped
// out of the task DESCRIPTION, which most tasks don't carry. The folders it was
// describing were there the whole time and nothing ever looked at them.
//
// Same climb as getFolderCountries and capped the same way, which the tree
// supports exactly: measured from the job folder, every discipline folder in
// the account sits 1-3 levels up (2,010 at one, 1,055 at two, 15 at three) and
// a cap of 4 saturates at 3,080 of 3,741 job folders. Nothing is gained by
// climbing further and a distant ancestor is all that's up there.
//
// A level naming BOTH disciplines returns "" rather than picking one — the same
// call categoryFamilyFromText makes when a brief says both words, and a real
// case: XY025018_Odeon_Selfie_Station is filed under Print and Digital at once.
const FOLDER_FAMILY_MAX_DEPTH = 4;

export function getFolderFamily(task, folderDictionary, childToParents = {}) {
  if (!task?.parentIds?.length || !folderDictionary) return "";
  let level = [...task.parentIds];
  const visited = new Set(level);

  for (let depth = 0; depth < FOLDER_FAMILY_MAX_DEPTH && level.length; depth++) {
    // The whole level before climbing, so the nearest declaration wins even
    // when a task sits in several folders at once.
    const found = [
      ...new Set(
        level
          .map((id) => familyFromFolderName(folderDictionary[id]?.title))
          .filter(Boolean)
      ),
    ];
    if (found.length === 1) return found[0];
    if (found.length > 1) return "";

    const next = [];
    for (const id of level) {
      for (const parentId of orderedParents(id, childToParents, folderDictionary)) {
        if (!visited.has(parentId)) {
          visited.add(parentId);
          next.push(parentId);
        }
      }
    }
    level = next;
  }
  return "";
}

// ---------------------------------------------------------------------------
// The description a job carries in its own Wrike folder name
// ---------------------------------------------------------------------------
// A job's description lives in the folder title the push writes —
// "XY026047_French_Canada_Assets" — but the Job Number custom field only ever
// receives the BARE code (see PushToWrikeModal). So a task tagged "XY026047"
// says which job it belongs to and nothing whatever about what that job is.
//
// Readers used to fill that gap by inventing a description from the task's own
// name. A task name describes a piece of work, not a job, so the Job Book
// ended up holding rows like "The Odyssey : XY026047, ODY_Print_Teaser1SHT_
// Birds_CMYK_KR" for a job actually called "French Canada Assets" — and
// because that string is well-formed, the Studio Scan's reconciliation can't
// see anything wrong with it, so it was never repaired.
//
// Reading the folder instead means a description derived here and one derived
// later by scanStudioJobNumbers come from the same place, so they cannot
// disagree.
//
// Matched on the code already resolved for this task, NOT on "the nearest
// folder that looks like a job": a task can sit under several parents at once,
// and a neighbouring job's folder would silently describe these hours as
// belonging to different work.
const FOLDER_JOB_MAX_DEPTH = 4;

export function jobFolderDescription(task, code, folderDictionary, childToParents = {}) {
  if (!task || !code || !folderDictionary) return "";
  const bare = (String(code).match(/XY\d{5,6}/i) || [])[0];
  if (!bare) return "";
  const wanted = new RegExp(`^${bare}_`, "i");

  // A subtask has no folder membership of its own — parentIds is the parent's
  // business — so it climbs from the parent's folders, resolved at fetch time
  // into superTaskParentIds. Same fallback the country resolver uses.
  let level = task.parentIds?.length
    ? [...task.parentIds]
    : [...(task.superTaskParentIds || [])];
  const visited = new Set(level);

  for (let depth = 0; depth < FOLDER_JOB_MAX_DEPTH && level.length; depth++) {
    // Whole level before climbing, so the nearest match wins when a task sits
    // in several folders at once.
    for (const id of level) {
      const title = folderDictionary[id]?.title || "";
      if (wanted.test(title)) {
        return title
          .slice(bare.length)
          .replace(/^[_\s,–—-]+/, "")
          .replace(/_+/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      }
    }
    const next = [];
    for (const id of level) {
      for (const parentId of orderedParents(id, childToParents, folderDictionary)) {
        if (!visited.has(parentId)) {
          visited.add(parentId);
          next.push(parentId);
        }
      }
    }
    level = next;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Print launch-tracking relevance (Print Canvas / Launch Tracker)
// ---------------------------------------------------------------------------
// Print coordinates each launch wave through a hub task ("*_Launch_Print_Requests"
// / "*_Print_Teaser_Launch_Markets") whose subtasks are the per-market requests
// ("AB3_INTL_Print_Teaser1SHT_Birds_CMYK_KR"). Only the HUB matches by title;
// its per-market subtasks are kept by MEMBERSHIP (the sync/webhook look up
// hub.subTaskIds — see useWrikeCache). Matching subtasks by title instead would
// need a broad "_INTL_PRINT_" pattern that also swept in every unrelated print
// asset in the workspace (e.g. ODY_INTL_PRINT_SilverSoldiers_Banner), bloating
// the cache and polluting the Canvas gallery/notes with non-launch tasks.
export const PRINT_HUB_RE = /print_?requests|launch_?markets/i;

// Which tasks keep their parsed description through enrichment (and are
// therefore worth a description backfill when pagination drops it): MATRIX
// tasks (the Canvas table) and Print launch hubs (paths, GD sheet, packaging
// checklist). Everything else's description is deleted at enrich time.
export const keepsDescription = (title) => {
  const t = title || "";
  return t.toUpperCase().includes("MATRIX") || PRINT_HUB_RE.test(t);
};

// ---------------------------------------------------------------------------
// Filter raw tasks down to Motion team relevance
// ---------------------------------------------------------------------------
export function filterToMotionTeam(tasks, folderDictionary, contactDictionary) {
  const tasksById = new Map(tasks.map((t) => [t.id, t]));

  return tasks.filter((task) => {
    if (!task.title) return false;
    const upper = task.title.toUpperCase();

    const matchesKeywords =
      upper.includes("DOOH") || upper.includes("DINTH") || upper.includes("MATRIX") ||
      PRINT_HUB_RE.test(task.title);
    const matchesAssignee = task.responsibleIds?.some(
      (id) => motionTeamShortName(contactDictionary[id])
    );
    const matchesDigital = task.parentIds?.some((pid) =>
      folderDictionary[pid]?.title?.toUpperCase().includes("DIGITAL")
    );

    if (matchesKeywords || matchesDigital || matchesAssignee) return true;

    return task.subTaskIds?.some((subId) => {
      const sub = tasksById.get(subId);
      if (!sub?.title) return false;
      const subUpper = sub.title.toUpperCase();
      return (
        subUpper.includes("DOOH") ||
        subUpper.includes("DINTH") ||
        subUpper.includes("MATRIX") ||
        sub.parentIds?.some((pid) => folderDictionary[pid]?.title?.toUpperCase().includes("DIGITAL")) ||
        sub.responsibleIds?.some((id) => motionTeamShortName(contactDictionary[id]))
      );
    }) ?? false;
  });
}

// ---------------------------------------------------------------------------
// Enrich raw Wrike tasks with computed fields (film name, paths, status, etc.)
// ---------------------------------------------------------------------------
export function enrichTasks(rawTasks, folderDictionary, contactDictionary, statusDictionary, childToParents = {}, extraMappings = {}) {
  // Country codes live at the end of a task name, and production writes them
  // on the parent task — the one people record time against — not always on
  // every subtask. Wrike gives us subTaskIds but not superTaskIds, so invert
  // the former once per batch to get each subtask its parent's title. Only the
  // title is carried (countryCodes.js reads nothing else), so this costs a
  // string per subtask rather than a second pass over the API.
  const parentTitleById = {};
  for (const t of rawTasks) {
    for (const childId of t.subTaskIds || []) parentTitleById[childId] = t.title;
  }

  return rawTasks.map((task) => {
    // Only MATRIX tasks need the parsed description — that's where the tableHtml
    // the Canvas renders lives. For every other task the derived notes/path text
    // (notesText + extractedPathData) was ~9 MB of retained cache we barely use:
    // project/studio names come from the folder tree below (getFilmName tree-
    // climbs first; getStudioName never touches the description), and the
    // job/territory guessing that DOES read the description fetches it per-task
    // on the fly (useTaskActions / LegacyTimesheets), not from this cache. So we
    // skip parsing and don't retain those bytes for non-MATRIX tasks. Tradeoff:
    // global search no longer matches on notes/path text for non-MATRIX tasks,
    // and film detection loses its description fallback (folder-tree only).
    // Print launch hubs also keep their parsed description — it carries the
    // job-folder paths, OV master links, GD sheet URL and the per-market
    // packaging checklist the Launch Tracker renders.
    const isMatrix = keepsDescription(task.title);
    const parsed = isMatrix
      ? parseWrikeData(task.description)
      : { tableHtml: "", notesText: "", extractedPathData: "" };
    delete task.description;

    // Wrike returns every populated custom field (~6.5/task, 35 distinct in
    // this account, ~9 MB of cache). Cached tasks' customFields ARE read —
    // TaskDetailModal's fullTask and the Tracker's taskMap both come from
    // this cache — but their reader (guessFieldsFromTask) only ever pattern-
    // matches three things in the values: the XY job code, /Volumes server
    // paths, and territory names/aliases. Keep exactly those three shapes
    // (verified against the live data: the one territory-bearing field held
    // codes like AE/AUS; everything else dropped is rates, dates, Wrike user
    // ids, statuses and comment HTML the app never reads).
    // The pinned Country field is kept whatever it holds — value-shape tests
    // decide what's worth caching from the fields we can't identify, and that
    // reasoning doesn't apply to the one field we can. Dropping a value the
    // resolver is entitled to read would turn a correct answer into a blank.
    const countryIds = new Set(countryFieldIds());
    const customFields = Array.isArray(task.customFields)
      ? task.customFields.filter((cf) => {
          if (countryIds.has(cf?.id)) return true;
          const v = cf?.value || "";
          return /XY\d{5,6}/i.test(v) || v.includes("/Volumes/") || isTerritoryValue(v);
        })
      : task.customFields;

    return {
      ...task,
      customFields,
      parentTaskTitle: parentTitleById[task.id] || "",
      folderCountries: getFolderCountries(task, folderDictionary, childToParents),
      extractedPathData: parsed.extractedPathData,
      tableHtml: parsed.tableHtml,
      notesText: parsed.notesText,
      projectName: getFilmName(task, folderDictionary, parsed.extractedPathData, extraMappings, childToParents),
      studioName: getStudioName(task, folderDictionary, childToParents),
      assignees: (task.responsibleIds || [])
        .map((id) => contactDictionary[id] || "User")
        .join(", "),
      customStatusName: task.customStatusId
        ? statusDictionary[task.customStatusId] || task.status
        : task.status,
      dueDate: task.dates?.due ?? "No Due Date",
    };
  });
}

// ---------------------------------------------------------------------------
// Build a code→filmName map from already-enriched tasks.
// Only records entries where the name was actually resolved (tree/path/dict),
// not ones that fell through to the raw title prefix fallback.
// ---------------------------------------------------------------------------
export function buildFilmCodeMappings(enrichedTasks) {
  const mappings = {};
  for (const task of enrichedTasks) {
    if (!task.title || !task.projectName || task.projectName === "Unknown Project") continue;
    const rawPrefix = task.title.split(/[_|-]/)[0].trim();
    // Only all-uppercase codes like NVC, ODY, WK2, COBAB (2–8 chars, starts with letter)
    if (!/^[A-Z][A-Z0-9]{1,7}$/.test(rawPrefix)) continue;
    // Skip if projectName is just the title-cased prefix — that's the raw fallback, not useful
    const fallbackName = rawPrefix.charAt(0) + rawPrefix.slice(1).toLowerCase();
    if (task.projectName === fallbackName) continue;
    if (!mappings[rawPrefix]) mappings[rawPrefix] = task.projectName;
  }
  return mappings;
}

// ---------------------------------------------------------------------------
// Fetch missing parent folder IDs from Wrike API (archives, etc.)
// ---------------------------------------------------------------------------
// Returns { folderDictionary, complete, unresolved, rounds, exhausted }.
//
// The dictionary is still mutated in place, so a caller that only wants the
// folders can keep ignoring the return value. What is new is that a caller can
// now ASK whether the tree it is about to climb is whole.
//
// It often is not. A chunk that fails is caught, logged and skipped, and the
// loop gives up after 8 rounds regardless — both are deliberate, because a
// rate-limited hydration should not take down an enrichment. The cost was that
// the incompleteness became invisible: every climber reads a half-built tree
// exactly as it reads a whole one, and returns a confident wrong answer instead
// of an error. Reporting it does not make the tree any more complete; it makes
// the difference *knowable*, which is the part that was missing.
export async function hydrateMissingFolders(tasks, folderDictionary) {
  let missing = new Set();
  tasks.forEach((t) => t.parentIds?.forEach((pid) => {
    if (!folderDictionary[pid]) missing.add(pid);
  }));

  // Ids we asked for and did not get back — a failed chunk, or a chunk that
  // returned without them. Cleared per id as soon as one does arrive, since a
  // later round can still resolve what an earlier one missed.
  const unresolved = new Set();
  // Folders we deliberately did NOT hydrate because they sit in the recycle
  // bin. Excluded is not the same as missing, and conflating them would make
  // every sync of a workspace with a populated recycle bin report an incomplete
  // tree forever.
  const recycled = new Set();

  let loopCount = 0;
  while (missing.size > 0 && loopCount < 8) {
    loopCount++;
    const ids = [...missing];
    missing.clear();
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      try {
        const res = await fetchRetrying(`/api/wrike/folders/${chunk.join(",")}`);
        if (res.ok) {
          (await res.json()).data?.forEach((f) => {
            // Recycled folders are deliberately not hydrated — same filter
            // fetchAllFolders applies. Recorded as excluded rather than
            // unresolved below, so "the tree is incomplete" keeps meaning
            // "something is missing that should be here".
            if (/^Rb/i.test(f.scope || "")) { recycled.add(f.id); return; }
            folderDictionary[f.id] = f;
            f.parentIds?.forEach((pid) => {
              if (!folderDictionary[pid]) missing.add(pid);
            });
          });
        }
      } catch (e) {
        console.error("Folder hydration chunk failed", e);
      }
      // Whatever this chunk asked for and still isn't in the dictionary is
      // unresolved, whether the request threw, returned non-OK, or simply came
      // back without it.
      chunk.forEach((id) => {
        if (!folderDictionary[id] && !recycled.has(id)) unresolved.add(id);
      });
    }
  }

  // Anything still queued when the round cap hit was never even requested.
  missing.forEach((id) => unresolved.add(id));

  const exhausted = loopCount >= 8 && missing.size > 0;
  const stats = {
    folderDictionary,
    complete: unresolved.size === 0 && !exhausted,
    unresolved: [...unresolved],
    rounds: loopCount,
    exhausted,
    recycled: [...recycled],
  };
  if (!stats.complete) {
    console.warn(
      `[wrikeEnrich] folder tree incomplete: ${stats.unresolved.length} folder(s) unresolved ` +
      `after ${loopCount} round(s)${exhausted ? " (round cap reached)" : ""}. ` +
      `Climbs through the missing branches may resolve to the wrong film/studio/market.`
    );
  }
  return stats;
}
