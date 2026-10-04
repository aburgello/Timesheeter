import { FILM_MAPPINGS, motionTeamShortName, TERRITORIES, REGION_ALIASES, MAGI_MARKET_CODES, MAGI_MARKET_FOLDERS, COUNTRY_SUFFIX_EXCEPTIONS } from "../constants.js";
import { countriesFromFolderNames } from "../utils/countryCodes";
import { familyFromFolderName } from "../utils/categoryFamily";
import { countryFieldIds } from "./countryField";
import { fetchRetrying } from "./fetchPool";
import { studioNameOf, studioKeywordOf } from "./studios";

// Resolve a film code ("ZAL", "ody") to its title via FILM_MAPPINGS, or title-case
// it when unmapped. For folders named after the code rather than the film.
const titleCase = (s) =>
  s.trim().toLowerCase().split(" ").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
const resolveFilmCode = (name) => {
  if (!name) return name;
  const key = name.trim().toUpperCase();
  if (FILM_MAPPINGS?.[key]) return FILM_MAPPINGS[key];
  return titleCase(name.replace(/[_|-]/g, " "));
};

// Every territory token the resolver can recognise, uppercased. It decides which
// custom-field values survive into the cache, so it must cover everything the
// resolver can read (MAGI codes and exception words included), or a value the
// resolver could match is dropped before it gets there.
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

// A folder title that can't be a film: empty, a year, an org-chart word, or a
// studio (from studios.js; studioKeywordOf treats `_` as a separator, so
// "Universal_UK_Archive" counts and "Portfolio Mgmt" isn't MGM).
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
  return resolveFilmName(task, folderDictionary, extractedPath, extraMappings, childToParents).name;
}

// getFilmName plus which rule answered: "folder", "path", "code", "prefix" or
// "none". "prefix" is the task name's first token title-cased ("GMF_…" → "Gmf"),
// not a real film. Callers that WRITE a film (timesheet rows, the Job Book) treat
// it as blank so the Job Book can fill it in; display callers may show it.
export function resolveFilmName(task, folderDictionary, extractedPath = "", extraMappings = {}, childToParents = {}) {
  if (!task.title) return { name: "Unknown Project", source: "none" };

  // 1. Tree climb: find a DIGITAL or PRINT folder and take its parent as the film.
  // Folders hydrated by id carry parentIds; the flat folder list only has childIds,
  // so fall back to the reverse childToParents map.
  if (task.parentIds?.length > 0) {
    let queue = [...task.parentIds];
    let visited = new Set(queue);
    let foundFilmName = null;

    while (queue.length > 0) {
      const currentId = queue.shift();
      const currentFolder = folderDictionary[currentId];
      if (!currentFolder) continue;

      // Stored parentIds first, else every parent from the reverse map.
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
      return { name: resolveFilmCode(foundFilmName), source: "folder" };
    }
  }

  // 2. Path fallback
  if (extractedPath) {
    const parts = extractedPath.split("/");
    const digIdx = parts.findIndex((p) => ["DIGITAL", "PRINT"].includes(p.toUpperCase()));
    if (digIdx > 0) {
      // Same test as the climb: a path segment naming the studio isn't a film either.
      let back = digIdx - 1;
      while (back > 0 && isNotAFilmName(decodeURIComponent(parts[back]))) back--;
      if (back > 0 && parts[back].trim()) {
        return { name: resolveFilmCode(decodeURIComponent(parts[back])), source: "path" };
      }
    }
  }

  // 3. Dictionary / prefix fallback
  const rawPrefix = task.title.split(/[_|-]/)[0].trim();
  const lookupKey = rawPrefix.toUpperCase();
  if (FILM_MAPPINGS?.[lookupKey]) return { name: FILM_MAPPINGS[lookupKey], source: "code" };
  if (extraMappings?.[lookupKey]) return { name: extraMappings[lookupKey], source: "code" };

  return { name: titleCase(rawPrefix), source: "prefix" };
}

// The film a task can vouch for, or "" when all it has is the name-prefix guess.
// Tasks cached before projectNameSource existed are judged by comparing the name
// with the prefix.
export function filmFromTask(task) {
  const name = task?.projectName || "";
  if (!name || name === "Unknown Project") return "";
  if (task.projectNameSource) return ["prefix", "none"].includes(task.projectNameSource) ? "" : name;
  const prefix = String(task.title || "").split(/[_|-]/)[0].trim();
  if (prefix && (name === prefix || name === titleCase(prefix))) return "";
  return name;
}

// ---------------------------------------------------------------------------
// Climb the folder tree to find the studio for a task
// ---------------------------------------------------------------------------
// Studio matching lives in studios.js, shared with the Job Book scan, so the two
// can't resolve the same folder to different studios.

// childId → [every parentId], inverted from the folders' childIds (the folder
// list gives childIds, not parentIds). EVERY parent: a folder can sit in several
// places, and keeping just one (whichever Wrike paged last) sent climbs up an
// unrelated branch and filed jobs under the wrong film.
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

// A folder that holds finished work. Same test as wrikeCampaign's isArchiveNode,
// so the scan and enrichment agree on what's archived.
const isArchiveTitle = (title) =>
  /(^|[\s_])_?archive\b/i.test(title || "") || /master.?template/i.test(title || "");

// A folder's parents in a stable order, live branches before archived ones, so
// a task resolves the same way every time when two parents tie.
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
    // Breadth-first over every parent, so the nearest studio wins.
    for (const parentId of orderedParents(id, childToParents, folderDictionary)) {
      if (!visited.has(parentId)) {
        visited.add(parentId);
        queue.push(parentId);
      }
    }
  }
  return null;
}

// The market folder a task sits in, resolved to countries (localisation campaigns
// put the market in the tree, not the task name). Nearest folder wins, so "Chile"
// beats the "..._Markets" root above it. Depth is capped so a distant studio or
// archive folder named after a country can't claim the task.
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

// The discipline folder a task sits under: "Print", "Digital", or "" when the tree
// doesn't say or one level names both (some jobs are filed under both).
// Discipline folders sit 1-3 levels above the job folder, hence the cap.
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
// A job's description is its folder title ("XY026047_French_Canada_Assets"); the
// Job Number field only holds the bare code. Read it from the folder whose title
// starts with THIS task's code, not the nearest job-looking folder: a task can sit
// under several, and a neighbour's folder would mislabel the hours. The Job Book
// scan reads the same folders, so the two can't disagree.
const FOLDER_JOB_MAX_DEPTH = 4;

export function jobFolderDescription(task, code, folderDictionary, childToParents = {}) {
  if (!task || !code || !folderDictionary) return "";
  const bare = (String(code).match(/XY\d{5,6}/i) || [])[0];
  if (!bare) return "";
  const wanted = new RegExp(`^${bare}_`, "i");

  // A subtask has no folders of its own, so climb from its parent's
  // (superTaskParentIds, resolved at fetch time).
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
// Print runs each launch wave through a hub task ("*_Launch_Print_Requests",
// "*_Print_Teaser_Launch_Markets") whose subtasks are the per-market requests.
// Only the hub matches by title; its subtasks are kept by membership (see
// useWrikeCache). A broader title pattern sweeps in unrelated print assets.
export const PRINT_HUB_RE = /print_?requests|launch_?markets/i;

// Tasks whose parsed description survives enrichment, and so are worth a
// description backfill: MATRIX tasks (the Canvas table) and Print launch hubs.
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
  // Country codes are often only on the parent task's name. Wrike gives subTaskIds
  // but not the parent, so invert subTaskIds within the batch.
  const parentTitleById = {};
  for (const t of rawTasks) {
    for (const childId of t.subTaskIds || []) parentTitleById[childId] = t.title;
  }

  return rawTasks.map((task) => {
    // Only MATRIX tasks and Print launch hubs keep their parsed description (the
    // Canvas table; the hub's paths and checklist). For everything else it was ~9 MB
    // of cache nobody read: film and studio come from the folder tree, and the
    // job/territory guessing fetches descriptions on demand.
    const isMatrix = keepsDescription(task.title);
    const parsed = isMatrix
      ? parseWrikeData(task.description)
      : { tableHtml: "", notesText: "", extractedPathData: "" };
    delete task.description;

    // Keep only the custom fields guessFieldsFromTask can use: an XY job code, a
    // /Volumes path, or a territory value, plus the pinned Country field whatever it
    // holds. The rest (rates, dates, user ids) was ~9 MB of cache.
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
      ...(({ name, source }) => ({ projectName: name, projectNameSource: source }))(
        resolveFilmName(task, folderDictionary, parsed.extractedPathData, extraMappings, childToParents)
      ),
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
// Mutates folderDictionary in place and returns { folderDictionary, complete,
// unresolved, rounds, exhausted, recycled }. Failed chunks are logged and skipped
// and it stops after 8 rounds, so a rate limit can't take down enrichment. Check
// `complete`: climbs over a partial tree give confident wrong answers.
export async function hydrateMissingFolders(tasks, folderDictionary) {
  let missing = new Set();
  tasks.forEach((t) => t.parentIds?.forEach((pid) => {
    if (!folderDictionary[pid]) missing.add(pid);
  }));

  // Ids asked for and not returned. Cleared as soon as a later round finds them.
  const unresolved = new Set();
  // Recycle-bin folders skipped on purpose. Kept apart from unresolved so a full
  // recycle bin doesn't make every tree look incomplete.
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
            // Recycled folders aren't hydrated (same filter as fetchAllFolders).
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
      // Whatever this chunk asked for and still lacks is unresolved, whatever the cause.
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
