import { FILM_MAPPINGS, motionTeamShortName, TERRITORIES, REGION_ALIASES, MAGI_MARKET_CODES, COUNTRY_SUFFIX_EXCEPTIONS } from "../constants.js";
import { countriesFromFolderNames } from "../utils/countryCodes";
import { countryFieldIds } from "./countryField";
import { fetchRetrying } from "./fetchPool";

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

// ---------------------------------------------------------------------------
// Climb the folder tree to find the film name for a task
// ---------------------------------------------------------------------------
export function getFilmName(task, folderDictionary, extractedPath = "", extraMappings = {}, childToParent = {}) {
  if (!task.title) return "Unknown Project";

  // 1. Tree-climb: find "DIGITAL" or "PRINT" folder, then take its parent as film name.
  // Folders fetched individually (hydration) carry parentIds; the flat /folders list only
  // returns childIds. When parentIds is absent we fall back to the reverse childToParent map
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

      // Prefer stored parentIds; fall back to reverse childToParent map
      const parentIds = currentFolder.parentIds?.length
        ? currentFolder.parentIds
        : childToParent[currentId] ? [childToParent[currentId]] : [];

      if (["DIGITAL", "PRINT"].includes(currentFolder.title?.trim().toUpperCase())) {
        for (const pid of parentIds) {
          const pName = folderDictionary[pid]?.title || "";
          const pUpper = pName.toUpperCase();
          if (
            pUpper &&
            !pUpper.includes("UNIVERSAL") &&
            !pUpper.includes("PARAMOUNT") &&
            !pUpper.includes("SONY") &&
            !pUpper.includes("MOTION") &&
            !pUpper.match(/^20\d{2}/) &&
            !pUpper.includes("ARCHIVE")
          ) {
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
      let back = digIdx - 1;
      while (
        back > 0 &&
        (parts[back].toUpperCase().includes("UNIVERSAL") ||
          parts[back].toUpperCase().includes("PARAMOUNT") ||
          parts[back].toUpperCase().includes("MOTION") ||
          parts[back].match(/^20\d{2}/) ||
          parts[back].toUpperCase().includes("ARCHIVE"))
      ) back--;
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
const STUDIO_KEYWORDS = [
  { studio: "Universal",  keywords: ["universal"] },
  { studio: "Paramount",  keywords: ["paramount"] },
  { studio: "Warner",     keywords: ["warner", "wbros", "wb"] },
  { studio: "Disney",     keywords: ["disney", "marvel", "pixar", "lucasfilm"] },
  { studio: "Sony",       keywords: ["sony", "columbia", "tristar"] },
  { studio: "Netflix",    keywords: ["netflix"] },
  { studio: "Apple",      keywords: ["apple"] },
  { studio: "Amazon",     keywords: ["amazon", "mgm"] },
];

// Build a childId→parentId reverse map from a folderDictionary that has childIds.
// Wrike's /v4/folders returns childIds (downward), not parentIds (upward), so we
// invert the relationship to enable upward tree climbing.
export function buildChildToParent(folderDictionary) {
  const map = {};
  for (const folder of Object.values(folderDictionary)) {
    for (const childId of folder.childIds || []) {
      map[childId] = folder.id;
    }
  }
  return map;
}

export function getStudioName(task, folderDictionary, childToParent = {}) {
  if (!task.parentIds?.length || !folderDictionary) return null;
  const queue = [...task.parentIds];
  const visited = new Set(queue);
  while (queue.length > 0) {
    const id = queue.shift();
    const title = folderDictionary[id]?.title || "";
    if (title) {
      const lower = title.toLowerCase();
      for (const { studio, keywords } of STUDIO_KEYWORDS) {
        if (keywords.some((k) => lower.includes(k))) return studio;
      }
    }
    // Climb to parent via reverse childIds map
    const parentId = childToParent[id];
    if (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      queue.push(parentId);
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

export function getFolderCountries(task, folderDictionary, childToParent = {}) {
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
      const parentId = childToParent[id];
      if (parentId && !visited.has(parentId)) {
        visited.add(parentId);
        next.push(parentId);
      }
    }
    level = next;
  }
  return [];
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

export function jobFolderDescription(task, code, folderDictionary, childToParent = {}) {
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
      const parentId = childToParent[id];
      if (parentId && !visited.has(parentId)) {
        visited.add(parentId);
        next.push(parentId);
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
export function enrichTasks(rawTasks, folderDictionary, contactDictionary, statusDictionary, childToParent = {}, extraMappings = {}) {
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
      folderCountries: getFolderCountries(task, folderDictionary, childToParent),
      extractedPathData: parsed.extractedPathData,
      tableHtml: parsed.tableHtml,
      notesText: parsed.notesText,
      projectName: getFilmName(task, folderDictionary, parsed.extractedPathData, extraMappings, childToParent),
      studioName: getStudioName(task, folderDictionary, childToParent),
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
export async function hydrateMissingFolders(tasks, folderDictionary) {
  let missing = new Set();
  tasks.forEach((t) => t.parentIds?.forEach((pid) => {
    if (!folderDictionary[pid]) missing.add(pid);
  }));

  let loopCount = 0;
  while (missing.size > 0 && loopCount < 8) {
    loopCount++;
    const ids = [...missing];
    missing.clear();
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      try {
        // Retrying: this silently swallows a failed chunk (the catch below),
        // so a 429 here doesn't error — it just leaves those folders
        // unhydrated, and the tree comes out quietly incomplete.
        const res = await fetchRetrying(`/api/wrike/folders/${chunk.join(",")}`);
        if (res.ok) {
          (await res.json()).data?.forEach((f) => {
            folderDictionary[f.id] = f;
            f.parentIds?.forEach((pid) => {
              if (!folderDictionary[pid]) missing.add(pid);
            });
          });
        }
      } catch (e) {
        console.error("Folder hydration chunk failed", e);
      }
    }
  }

  return folderDictionary;
}
