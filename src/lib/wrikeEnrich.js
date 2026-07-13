import { FILM_MAPPINGS, MOTION_TEAM_NAME_MAP, TERRITORIES, REGION_ALIASES } from "../constants.js";

// Every token the territory guesser can recognise (full names + aliases like
// AE/AUS), uppercased — used below to decide which customFields values are
// worth keeping in the cache. Mirrors guessFieldsFromTask's own sources so
// the cache keeps exactly what that guesser could ever match on.
const TERRITORY_TOKENS = new Set(
  [...TERRITORIES, ...Object.keys(REGION_ALIASES)].map((t) => String(t).toUpperCase())
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
      return foundFilmName
        .replace(/[_|-]/g, " ")
        .trim()
        .toLowerCase()
        .split(" ")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");
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
        return decodeURIComponent(parts[back])
          .replace(/[_|-]/g, " ")
          .trim()
          .toLowerCase()
          .split(" ")
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(" ");
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

// ---------------------------------------------------------------------------
// Filter raw tasks down to Motion team relevance
// ---------------------------------------------------------------------------
export function filterToMotionTeam(tasks, folderDictionary, contactDictionary) {
  const tasksById = new Map(tasks.map((t) => [t.id, t]));

  return tasks.filter((task) => {
    if (!task.title) return false;
    const upper = task.title.toUpperCase();

    const matchesKeywords =
      upper.includes("DOOH") || upper.includes("DINTH") || upper.includes("MATRIX");
    const matchesAssignee = task.responsibleIds?.some(
      (id) => contactDictionary[id] && MOTION_TEAM_NAME_MAP[contactDictionary[id]]
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
        sub.responsibleIds?.some((id) => contactDictionary[id] && MOTION_TEAM_NAME_MAP[contactDictionary[id]])
      );
    }) ?? false;
  });
}

// ---------------------------------------------------------------------------
// Enrich raw Wrike tasks with computed fields (film name, paths, status, etc.)
// ---------------------------------------------------------------------------
export function enrichTasks(rawTasks, folderDictionary, contactDictionary, statusDictionary, childToParent = {}, extraMappings = {}) {
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
    const isMatrix = task.title?.toUpperCase().includes("MATRIX");
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
    const customFields = Array.isArray(task.customFields)
      ? task.customFields.filter((cf) => {
          const v = cf?.value || "";
          return /XY\d{5,6}/i.test(v) || v.includes("/Volumes/") || isTerritoryValue(v);
        })
      : task.customFields;

    return {
      ...task,
      customFields,
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
        const res = await fetch(`/api/wrike/folders/${chunk.join(",")}`);
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
