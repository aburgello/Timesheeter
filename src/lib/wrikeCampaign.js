// Job Book ↔ Wrike: scanning the folder tree and writing to it. All calls go
// through the Worker proxy at /api/wrike/*, which attaches the member's token.
//
// Rule for this module: **plan** functions only read and return a preview of
// exactly what the matching **apply** would change; only apply functions write.
// The UI shows the plan and writes only after an explicit confirm.

import { fetchRetrying } from "./fetchPool";
import { STUDIO_KEYWORDS_FLAT, STUDIO_CLIENT } from "./studios";

const WRIKE = "/api/wrike";

// ── Low-level GET helpers ─────────────────────────────────────────────────────

// fetchRetrying, not fetch: the rate limit is per account, so other people's
// traffic can 429 a scan. Waiting it out beats failing the whole scan.
async function wrikeGet(path) {
  const res = await fetchRetrying(`${WRIKE}${path}`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Wrike GET ${path} failed (${res.status})${body ? `: ${body}` : ""}`);
  }
  const json = await res.json();
  return json.data || [];
}

// GET that follows Wrike's nextPageToken pagination and concatenates all pages.
async function wrikeGetAll(path) {
  let out = [];
  let token = null;
  do {
    const sep = path.includes("?") ? "&" : "?";
    const url = token ? `${WRIKE}${path}${sep}nextPageToken=${token}` : `${WRIKE}${path}`;
    // Retried per page, so one 429 late in a long listing doesn't lose the rest.
    const res = await fetchRetrying(url);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Wrike GET ${path} failed (${res.status})${body ? `: ${body}` : ""}`);
    }
    const json = await res.json();
    out = out.concat(json.data || []);
    token = json.nextPageToken || null;
  } while (token);
  return out;
}

// ── Custom-field discovery ────────────────────────────────────────────────────

// Find the "Job Number" custom field by title rather than a hardcoded id, so it
// survives the field being recreated. Exact "Job Number" wins; looser matches
// ("Job No.", "Job Code") are fallbacks.
export async function discoverJobNumberField() {
  const fields = await wrikeGet("/customfields");
  const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const exact = fields.find((f) => norm(f.title) === "jobnumber");
  const contains = fields.find((f) => norm(f.title).includes("jobnumber"));
  const loose = fields.find(
    (f) => /job/.test(norm(f.title)) && /(number|no|num|code)/.test(norm(f.title))
  );
  const field = exact || contains || loose || null;
  return field ? { id: field.id, title: field.title } : null;
}

// The per-slot price on each JOBNUMBER template folder, found by title like Job
// Number. Only project managers can see it in Wrike, so "not found" means "leave
// the cost empty", never an error.
export async function discoverItemPriceField() {
  const fields = await wrikeGet("/customfields");
  const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const exact = fields.find((f) => norm(f.title) === "itemprice");
  const loose = fields.find((f) => /item/.test(norm(f.title)) && /(price|cost|rate)/.test(norm(f.title)));
  const field = exact || loose || null;
  return field ? { id: field.id, title: field.title } : null;
}

// The Item Price on one template folder, as a number, or null when the folder
// carries no value (or the caller can't see the field). Folders return
// customFields by default on the by-id endpoint, same as `project`/`scope`.
export async function fetchFolderItemPrice(folderId, fieldId) {
  if (!folderId || !fieldId) return null;
  try {
    const rows = await wrikeGet(`/folders/${folderId}`);
    const raw = (rows?.[0]?.customFields || []).find((c) => c.id === fieldId)?.value;
    if (raw == null || raw === "") return null;
    // Currency and Numeric fields come back as strings; Text ones may carry a
    // symbol or thousands separators.
    const n = parseFloat(String(raw).replace(/[^0-9.\-]/g, ""));
    return isNaN(n) ? null : n;
  } catch {
    return null; // never block staging a job on a price lookup
  }
}

// ── Folder / project discovery ────────────────────────────────────────────────

// The whole flat folder list (id, title, childIds), so callers can walk the tree
// locally. Throws rather than return part of it.
//
// Drops the recycle bin: Wrike's folder list includes it, and a deleted copy of a
// film is otherwise indistinguishable from the live one. Recycled nodes have a
// `scope` starting "Rb" (it comes back by default but can't be asked for in
// `fields=`). Rows without a scope are kept.
export async function fetchAllFolders() {
  const FF = encodeURIComponent("[childIds]");
  const rows = await wrikeGetAll(`/folders?fields=${FF}`);
  const byId = {};
  rows.forEach((f) => {
    if (/^Rb/i.test(f.scope || "")) return; // skip Recycle Bin root + contents
    byId[f.id] = {
      id: f.id,
      title: f.title || "",
      childIds: f.childIds || [],
    };
  });
  return byId;
}

// Which of the given folder ids are Wrike Projects, as [{ id, title }]. The by-id
// folder endpoint returns `project` by default (it can't be named in `fields=`).
// Batched 100 at a time, Wrike's per-request id cap.
export async function fetchFolderProjects(folderIds) {
  const ids = (folderIds || []).filter(Boolean);
  if (!ids.length) return [];
  const out = [];
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const rows = await wrikeGet(`/folders/${batch.join(",")}`);
    rows.forEach((f) => { if (f.project) out.push({ id: f.id, title: f.title || "" }); });
  }
  return out;
}

const norm = (s) => (s || "").toUpperCase().replace(/[_\s]+/g, " ").trim();

// A studio's root folder ("Paramount"): a folder titled exactly the studio name,
// preferring one that has children over an empty namesake.
export function findStudioFolder(byId, studioName) {
  const wanted = norm(studioName);
  const matches = Object.values(byId).filter((f) => norm(f.title) === wanted);
  if (!matches.length) return null;
  // Prefer the candidate with the most children (the populated studio folder).
  matches.sort((a, b) => (b.childIds?.length || 0) - (a.childIds?.length || 0));
  return matches[0];
}

// Every folder id under rootId, inclusive. The template-write guard never writes
// into these.
export function collectSubtreeIds(byId, rootId, seen = new Set()) {
  if (!rootId || seen.has(rootId)) return seen;
  seen.add(rootId);
  const node = byId[rootId];
  (node?.childIds || []).forEach((c) => collectSubtreeIds(byId, c, seen));
  return seen;
}

// Studio keywords and their clients come from studios.js, shared with the
// enricher. The MATCHING rule here is deliberately still this file's own (word
// boundaries on the raw title). studios.js's separator-aware rule would make 63
// more folders (_Universal_MASTER, _Sony_MASTER_TEMPLATES, …) count as studios,
// and describeChain takes the studio's child as the film, so it would change
// the proposed film on most job folders. Only switch after running the scan
// regression (npm run scan:diff) and reading the result.
const STUDIO_KEYWORDS = STUDIO_KEYWORDS_FLAT;

const deUnderscore = (s) => (s || "").replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();

// Region qualifiers that mark a regional studio folder ("UNIVERSAL AUSTRALIA") as
// a variant of a base studio. Used for default territories and to label jobs.
const REGION_QUALIFIER = /\b(AUSTRALIA|UK|US|USA|NEW MEDIA|INTERNATIONAL|INTL|EU|EMEA|APAC|CANADA|GERMANY|FRANCE|SPAIN|ITALY|JAPAN|KOREA|LATAM|NORDIC|BENELUX)\b/i;

// The same slot exists under several studio folders and is a different job in
// each. The timesheet site tells them apart by a region prefix on the
// description ("UK - Sky VIP Assets"), so the scan adds the same prefix.
const REGION_SHORT = {
  AUSTRALIA: "AUS", UK: "UK", US: "US", USA: "US", "NEW MEDIA": "NM",
  INTERNATIONAL: "INT", INTL: "INT", EU: "EU", EMEA: "EMEA", APAC: "APAC",
  CANADA: "CAN", GERMANY: "GER", FRANCE: "FRA", SPAIN: "SPA", ITALY: "ITA",
  JAPAN: "JPN", KOREA: "KOR", LATAM: "LATAM", NORDIC: "NORDIC", BENELUX: "BENELUX",
};

// A studio folder with no qualifier is the international arm ("INT - …" on the
// timesheet site). XYi's internal jobs have no territory.
const regionOf = (studioTitle, studioKw) => {
  const m = REGION_QUALIFIER.exec(studioTitle || "");
  if (!m) {
    return studioKw && studioKw.toLowerCase() !== "xyi"
      ? { short: "INT", name: "International" }
      : null;
  }
  const word = m[0].toUpperCase();
  return {
    short: REGION_SHORT[word] || word,
    // "UK"/"US"/"EU" stay upper-case; longer names read as words.
    name: word.length <= 3 ? word : word.charAt(0) + word.slice(1).toLowerCase(),
  };
};

// Scan the whole visible folder tree and return one candidate Job Book row per
// XY code.
//
// Job folders live at <Studio> › <Film> › <Job> ("XY025563_Germany_Launch_Assets").
// For each, the code and description come from the folder title, the client
// from the studio found by climbing, and the film from the folder between studio
// and job. Titles already in "Film : CODE, Desc" form are taken as they are.
// `totalFolders` tells an empty result apart from a failed fetch.
export async function scanStudioJobNumbers({ studioKeywords } = {}) {
  const KEYWORDS = studioKeywords || STUDIO_KEYWORDS;
  const byId = await fetchAllFolders();
  const totalFolders = Object.keys(byId).length;

  // Upward map with ALL parents: Wrike shares one folder into several places
  // (territories depend on it). Keeping one arbitrary parent sent jobs up an
  // _Archive path and hid them from the "Active only" view.
  const parentsOf = {};
  Object.values(byId).forEach((f) =>
    (f.childIds || []).forEach((c) => { (parentsOf[c] || (parentsOf[c] = [])).push(f.id); })
  );

  const studioKwOf = (title) =>
    KEYWORDS.find((k) => new RegExp(`\\b${k}\\b`, "i").test(title || ""));
  // "Archived" = filed under the studio's _Archive, a master-template tree, or _Old
  // (where New Media puts finished campaigns). The scan review's "Active only" tick
  // hides these.
  //
  // Anchored to the whole title "_Old": "Old" without the underscore is a real film
  // folder, and a substring test would also catch "Old Guard" and the like.
  const isOldContainer = (title) => /^_old$/i.test((title || "").trim());
  const isArchiveNode = (title) =>
    /(^|[\s_])_?archive\b/i.test(title || "") ||
    /master.?template/i.test(title || "") ||
    isOldContainer(title);

  // A bare year / number (e.g. "2026") is an organisational folder, not a film.
  const isYearFolder = (title) => /^\d{2,4}$/.test((title || "").trim());

  // A leading underscore marks an organisational folder (_Market, _Masters,
  // _Supplied, _Old, _zArchive …), never a film. Skipping them stops the film being
  // read as "Old" for jobs under Universal - New Media › _Old › <year> › <film>.
  const isOrgFolder = (title) => /^_/.test((title || "").trim());

  // The medium isn't a film either: under "_Universal House Job › Digital › <job>"
  // skipping the container would otherwise land on "Digital".
  const isMediumFolder = (title) =>
    /^(digital|print)$/i.test(deUnderscore(title || ""));

  // A house-job container isn't skipped, it IS the answer: house jobs have no film,
  // and descending further lands on work types ("Cards"). Anchored at the end and
  // never on a job folder, because "Housekeeping For Beginners" is a real film.
  const isHouseJobFolder = (title) => {
    const t = deUnderscore(title || "");
    if (/^XY\d{5,6}/i.test(t)) return false;
    return /\b(house\s*jobs?|house\s*keeping|housekeeping)$/i.test(t);
  };

  // Read one ancestry chain (job → … → root) into the fields a Job Book row needs.
  // The film is the deepest real folder between studio and job, skipping year and
  // organisational folders, not blindly the studio's child.
  const describeChain = (chain) => {
    const si = chain.findIndex((n) => n && studioKwOf(n.title));
    const studioKw = si >= 0 ? studioKwOf(chain[si].title) : "";
    let filmNode = null;
    if (si >= 1) {
      for (let i = si - 1; i >= 0; i--) {
        if (!chain[i]) continue;
        // Checked before the skips: a house-job container is taken, not passed.
        if (isHouseJobFolder(chain[i].title)) { filmNode = chain[i]; break; }
        if (!isYearFolder(chain[i].title) && !isOrgFolder(chain[i].title)
            && !isMediumFolder(chain[i].title)) {
          filmNode = chain[i]; break;
        }
      }
      // Nothing usable between job and studio: fall back to the studio's child, which
      // still names house jobs filed straight under a house-keeping folder.
      if (!filmNode) filmNode = chain[si - 1];
    }
    return {
      studioKw,
      // The studio node's FULL title: "UNIVERSAL UK" and "UNIVERSAL" both match
      // `Universal`, and the qualifier is what separates their jobs.
      studioTitle: si >= 0 ? chain[si].title || "" : "",
      filmTitle: filmNode ? deUnderscore(filmNode.title) : "",
      archived: chain.some((n) => isArchiveNode(n && n.title)),
      hasStudio: si >= 0,
    };
  };

  // Walk EVERY path from a job folder up to a root and describe the best one.
  // A job is only archived if it has no live home: one path through _Archive
  // doesn't archive a job that also sits in a live campaign folder. Preference
  // order is live-and-placed > placed > live > whatever we got.
  const ancestryOf = (startId, folderTitle) => {
    const chains = [];
    // Set when a walk hits its limits before reaching a root. A partial chain gives
    // no film, client or region, which would otherwise look like a job that genuinely
    // has none, so the review can say "could not establish".
    let truncated = false;
    const walk = (id, chain, seen) => {
      // Bounded, because shared folders fan out and this runs per job code.
      if (chain.length >= 40 || chains.length >= 24) { truncated = true; chains.push(chain); return; }
      const parents = (parentsOf[id] || []).filter((pid) => byId[pid] && !seen.has(pid));
      if (!parents.length) { chains.push(chain); return; }
      for (const pid of parents) {
        walk(pid, chain.concat(byId[pid]), new Set(seen).add(pid));
      }
    };
    walk(startId, [], new Set([startId]));

    // Keep the node list so the winning path can be shown as a breadcrumb in the
    // scan review.
    const scored = chains.map((chain) => ({ ...describeChain(chain), chain }));
    const rank = (d) => (d.hasStudio ? 2 : 0) + (d.archived ? 0 : 1);
    const best = scored.reduce((a, b) => (rank(b) > rank(a) ? b : a), scored[0]);
    const si = best.chain.findIndex((n) => n && studioKwOf(n.title));
    // chain runs [job-parent … studio … root]; take up to and including the
    // studio, prepend the job folder itself, reverse to studio-first, and read
    // it as a breadcrumb. No studio (orphan/shared folder) → just the folder.
    const folderPath = [folderTitle, ...best.chain.slice(0, si + 1).map((n) => n.title)]
      .reverse()
      .map((t) => deUnderscore(t))
      .join(" › ");
    return { ...best, folderPath, truncated };
  };

  const CODE = /XY\d{5,6}/i;

  // Group every folder carrying a code, then choose with the same score ancestryOf
  // uses (studio found, not archived). Taking the first one meant whichever Wrike
  // happened to list first, so an _Archive copy could win and hide a live job.
  const foldersByCode = new Map();
  Object.values(byId).forEach((f) => {
    const title = (f.title || "").trim();
    const m = title.match(CODE);
    if (!m) return;
    const code = m[0].toUpperCase();
    if (!foldersByCode.has(code)) foldersByCode.set(code, []);
    foldersByCode.get(code).push({ f, title, m });
  });

  const folderRank = (d) => (d.hasStudio ? 2 : 0) + (d.archived ? 0 : 1);

  // Codes on more than one folder, so the caller can show the ambiguity: two live
  // folders sharing a code is a data problem no heuristic can settle.
  const contestedCodes = [];

  const out = [];
  foldersByCode.forEach((candidates, code) => {
    const described = candidates.map((c) => ({ ...c, ...ancestryOf(c.f.id, c.title) }));

    // Ties break on folder id so a rescan always agrees with itself.
    described.sort((a, b) => folderRank(b) - folderRank(a) || String(a.f.id).localeCompare(String(b.f.id)));
    const chosen = described[0];

    if (described.length > 1) {
      contestedCodes.push({
        code,
        chose: chosen.folderPath,
        over: described.slice(1).map((d) => d.folderPath),
      });
    }

    const { f, title, m } = chosen;
    const { studioKw, studioTitle, filmTitle: ancestorFilm, archived, folderPath,
            truncated: ancestryTruncated } = chosen;
    const region = regionOf(studioTitle, studioKw);
    // Region-specific client ("Universal Pictures UK"), as the Job Book and the
    // timesheet site name it.
    const baseClient = studioKw ? STUDIO_CLIENT[studioKw.toLowerCase()] || studioKw : "";
    const client = baseClient && region ? `${baseClient} ${region.name}` : baseClient;

    let filmTitle, projectDescription, jobNumber;
    if (title.includes(" : ")) {
      // Already canonical ("Film : CODE, Desc") — trust it verbatim.
      jobNumber = title;
      filmTitle = title.split(" : ")[0].trim();
      projectDescription = deUnderscore(
        title.slice(title.indexOf(m[0]) + m[0].length).replace(/^[\s,–—-]+/, "")
      );
    } else {
      // Underscore folder: reassemble, prefixing the region the way the timesheet site
      // does ("UK - Sky VIP"), unless the folder already starts with a region code.
      projectDescription = deUnderscore(
        title.slice(title.indexOf(m[0]) + m[0].length).replace(/^[\s,_–—-]+/, "")
      );
      if (region && projectDescription &&
          !new RegExp(`^${region.short}\\b`, "i").test(projectDescription)) {
        projectDescription = `${region.short} - ${projectDescription}`;
      }
      filmTitle = ancestorFilm;
      jobNumber = filmTitle
        ? `${filmTitle} : ${code}${projectDescription ? `, ${projectDescription}` : ""}`
        : `${code}${projectDescription ? `, ${projectDescription}` : ""}`;
    }

    out.push({ code, jobNumber, filmTitle, projectDescription, client, archived,
               region: region ? region.short : null, folderId: f.id, folderPath,
               ancestryTruncated });
  });

  // Each job folder's createdDate (the by-id endpoint has it, the tree doesn't),
  // 100 at a time. Optional: a failure here must not throw away the whole scan.
  const ids = out.map((o) => o.folderId).filter(Boolean);
  const createdById = {};
  let createdDateBatchesFailed = 0;
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    try {
      const rows = await wrikeGet(`/folders/${batch.join(",")}`);
      rows.forEach((f) => { if (f.createdDate) createdById[f.id] = f.createdDate.slice(0, 10); });
    } catch (e) {
      createdDateBatchesFailed++;
      console.warn(`[wrikeCampaign] createdDate batch failed; those jobs stage without a date`, e);
    }
  }
  out.forEach((o) => { o.createdDate = createdById[o.folderId] || null; });

  out.sort((a, b) => a.code.localeCompare(b.code));
  out.totalFolders = totalFolders; // stashed on the array for the caller's diagnostics
  out.contestedCodes = contestedCodes;
  // Jobs whose ancestry walk hit its limits, so their film/client/region may be
  // incomplete. Shown by the caller like contestedCodes.
  out.truncatedCodes = out.filter((o) => o.ancestryTruncated).map((o) => o.code);
  out.createdDateBatchesFailed = createdDateBatchesFailed;
  return out;
}

// Do two job descriptions describe the same job? Used by the Job Book
// reconciliation to tell "filed against a different job" (bad data) from "worded
// differently" (every row).
//
// Deliberately loose: punctuation, underscores and case are ignored, and one
// containing the other counts as agreeing (the scan adds a region prefix that a
// description read at pull time doesn't have). It errs toward "agree", because a
// false disagreement would overwrite a description somebody chose.
const descKey = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export function descriptionsAgree(a, b) {
  const x = descKey(a);
  const y = descKey(b);
  // An empty side is "we don't know", never "we disagree".
  if (!x || !y) return true;
  return x === y || x.includes(y) || y.includes(x);
}

// Count JOBNUMBER folders beneath a node, to score master-template candidates.
function countJobNumberFolders(byId, rootId, seen = new Set()) {
  if (seen.has(rootId)) return 0;
  seen.add(rootId);
  const node = byId[rootId];
  if (!node) return 0;
  let n = /JOBNUMBER/i.test(node.title) ? 1 : 0;
  (node.childIds || []).forEach((c) => { n += countJobNumberFolders(byId, c, seen); });
  return n;
}

// A studio's master-template root ("_Paramount_MASTER_TEMPLATES"): title has the
// studio and "MASTER TEMPLATE"; the most JOBNUMBER folders wins, and copies or
// archives are penalised.
export function findMasterTemplateFolder(byId, studioName) {
  const wanted = norm(studioName);
  const candidates = Object.values(byId).filter((f) => {
    const t = norm(f.title);
    return t.includes(wanted) && t.includes("MASTER TEMPLATE");
  });
  if (!candidates.length) return null;
  let best = null;
  for (const c of candidates) {
    const jobCount = countJobNumberFolders(byId, c.id);
    const isDupe = /\b(COPY|ARCHIVE|ARCHIVED|OLD|BACKUP|BAK)\b/i.test(c.title || "");
    const score = jobCount - (isDupe ? 1e6 : 0) - (c.title || "").length * 0.001;
    if (!best || score > best.score) best = { folder: c, jobCount, score };
  }
  return best ? { id: best.folder.id, title: best.folder.title, jobCount: best.jobCount } : null;
}

// Which studio a film lives under: the film project's parent folder, read from
// Wrike (the films table only stores titles). Matched with norm(), since Wrike
// uses underscores and the films table spaces.
//
// Older pushes left a folder named after the film INSIDE the film project, so the
// title can match twice. Prefer the match whose parent isn't the same film.
export function findFilmLocation(byId, filmTitle) {
  if (!(filmTitle || "").trim()) return null;

  // Invert childIds to walk upwards, keeping ALL parents: one film project can be
  // shared into several studio "territories" (UNIVERSAL, UNIVERSAL AUSTRALIA, …).
  const parentsOf = {};
  Object.values(byId).forEach((f) =>
    (f.childIds || []).forEach((c) => { (parentsOf[c] || (parentsOf[c] = [])).push(f.id); })
  );

  const isSameFilm = (t) => norm(t) === norm(filmTitle);
  const matches = Object.values(byId).filter((f) => isSameFilm(f.title));

  // Every (film project × studio parent) pair, skipping same-film wrappers,
  // de-duplicated by studio folder.
  const territories = [];
  const seen = new Set();
  for (const f of matches) {
    for (const pid of parentsOf[f.id] || []) {
      const p = byId[pid];
      if (!p || isSameFilm(p.title) || seen.has(p.id)) continue;
      seen.add(p.id);
      territories.push({
        studio: p.title,
        studioFolder: { id: p.id, title: p.title },
        filmProject: { id: f.id, title: f.title },
      });
    }
  }
  if (!territories.length) return null;

  // Default to the base studio: no region qualifier first, then the one with the
  // most slot folders, then the shorter name.
  const slotCount = (id) => {
    let n = 0;
    const seenN = new Set();
    const walk = (x) => {
      if (seenN.has(x)) return; seenN.add(x);
      const node = byId[x]; if (!node) return;
      if (/^(JOBNUMBER|XY\d+)_/i.test(node.title || "")) n += 1;
      (node.childIds || []).forEach(walk);
    };
    walk(id);
    return n;
  };
  const score = (t) =>
    (REGION_QUALIFIER.test(t.studio) ? 0 : 1e6) + slotCount(t.filmProject.id) * 1000 - t.studio.length;
  territories.sort((a, b) => score(b) - score(a));
  const primary = territories[0];

  return { ...primary, territories };
}

// A display tree of the film's OWN Wrike subtree, not the studio template: old
// campaigns have renamed and drifted from the template, so only the film itself
// says what exists. Slots are tagged from their live names: "XY#####_" is
// allocated, "JOBNUMBER_" is still pending, so a numbered film can't be offered
// for re-numbering.
//
// Returns { filmProject, studio, studioFolder, territories, tree, hasSlots }, or
// null if the film isn't in Wrike. hasSlots:false means never pushed (use the
// studio template). Pass studioFolderId to pick a territory.
export function buildFilmView(byId, filmTitle, studioFolderId) {
  const loc = findFilmLocation(byId, filmTitle);
  if (!loc?.filmProject) return null;
  const chosen = (studioFolderId && loc.territories.find((t) => t.studioFolder.id === studioFolderId)) || loc;

  let slotCount = 0;
  const codeOf = (t) => (String(t).match(/^XY\d+/i) || [null])[0];
  const build = (id, seen = new Set()) => {
    if (seen.has(id)) return null;
    seen.add(id);
    const node = byId[id];
    if (!node) return null;
    const out = { id, label: node.title || "" };
    if (/^(JOBNUMBER|XY\d+)_/i.test(node.title || "")) {
      const code = codeOf(node.title);
      out.jobNumber = true;
      out.allocated = !!code;
      out.code = code;
      out.description = slotSuffix(node.title).replace(/_/g, " ").trim() || "General";
      slotCount += 1;
    }
    const children = (node.childIds || []).map((c) => build(c, seen)).filter(Boolean);
    if (children.length) out.children = children;
    return out;
  };

  return {
    filmProject: chosen.filmProject,
    studio: chosen.studio,
    studioFolder: chosen.studioFolder,
    territories: loc.territories,
    tree: build(chosen.filmProject.id),
    hasSlots: slotCount > 0,
  };
}

// ── Req 6: Film DB sync ───────────────────────────────────────────────────────

// Read-only plan: Wrike film projects missing from the films table. Additive
// only: films that exist only locally are never deleted.
export async function planFilmSync(studioName, existingTitles) {
  const byId = await fetchAllFolders();
  const studioFolder = findStudioFolder(byId, studioName);
  if (!studioFolder) {
    return { error: `No “${studioName}” folder found in Wrike.`, studioFolder: null, toAdd: [] };
  }
  // Wrike project names use underscores; show them as spaced film titles.
  const clean = (t) => (t || "").replace(/_/g, " ").replace(/\s+/g, " ").trim();
  const have = new Set([...existingTitles].map((t) => clean(t).toLowerCase()));
  const projects = await fetchFolderProjects(studioFolder.childIds);
  const toAdd = projects
    .map((p) => clean(p.title))
    .filter((t) => t && !have.has(t.toLowerCase()))
    // de-dupe titles that differ only by case/spacing within Wrike itself
    .filter((t, i, arr) => arr.findIndex((x) => x.toLowerCase() === t.toLowerCase()) === i)
    .sort((a, b) => a.localeCompare(b));
  return {
    error: null,
    studioFolder: { id: studioFolder.id, title: studioFolder.title },
    projectCount: projects.length,
    toAdd,
  };
}

// ── Tasks beneath a folder + custom-field writes (reqs 1 & 2) ─────────────────

// Every task and subtask anywhere beneath a folder (the endpoint recurses by
// default; subTasks=true adds subtasks). Only customFields is requested: Wrike
// 400s on some other optional fields in list queries.
export async function fetchTasksUnderFolder(folderId) {
  const FF = encodeURIComponent("[customFields]");
  return wrikeGetAll(`/folders/${folderId}/tasks?fields=${FF}&subTasks=true&pageSize=1000`);
}

// Write the Job Number field on one task. Params go in the query string, with
// customFields JSON-encoded.
async function putTaskJobNumber(taskId, fieldId, value) {
  const cf = encodeURIComponent(JSON.stringify([{ id: fieldId, value: String(value) }]));
  const res = await fetch(`${WRIKE}/tasks/${taskId}?customFields=${cf}`, { method: "PUT" });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`set field on ${taskId} (${res.status})${body ? `: ${body}` : ""}`);
  }
}

// Read-only plan: tasks under `folderId` that don't yet carry `jobNumber`.
// Splitting set from unset lets the same call do the first propagation and later
// top-ups; a re-run only touches what's missing.
export async function planPropagate(folderId, fieldId, jobNumber) {
  const tasks = await fetchTasksUnderFolder(folderId);
  const willSet = [];
  let alreadySet = 0;
  for (const t of tasks) {
    const cur = (t.customFields || []).find((c) => c.id === fieldId)?.value || "";
    if (cur === jobNumber) alreadySet += 1;
    else willSet.push({ id: t.id, title: t.title, current: cur });
  }
  return { total: tasks.length, alreadySet, willSet };
}

// Set the field on every task in `willSet`, one at a time (Wrike rate-limits
// bursts), collecting failures instead of stopping at the first.
// onProgress(done, total) drives the progress bar.
export async function applyPropagate(willSet, fieldId, jobNumber, onProgress) {
  const ok = [];
  const failed = [];
  for (let i = 0; i < willSet.length; i++) {
    try {
      await putTaskJobNumber(willSet[i].id, fieldId, jobNumber);
      ok.push(willSet[i].id);
    } catch (e) {
      failed.push({ id: willSet[i].id, title: willSet[i].title, error: e.message });
    }
    onProgress?.(i + 1, willSet.length);
  }
  return { ok, failed };
}

// Set the Job Number field on a folder itself (renaming only changes the title).
export async function setFolderJobNumber(folderId, fieldId, value) {
  const cf = encodeURIComponent(JSON.stringify([{ id: fieldId, value: String(value) }]));
  const res = await fetch(`${WRIKE}/folders/${folderId}?customFields=${cf}`, { method: "PUT" });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`set field on folder ${folderId} (${res.status})${body ? `: ${body}` : ""}`);
  }
}

// Turn on Wrike's field cascading for one field on a folder, so the folder's
// current value is pushed to every subitem, now and in future (the UI's "Apply
// value to all current and future subitems"). Set the folder value first.
//
// Verified live, and different from Wrike's published reference: the param is a
// singular `fieldId` string. `fieldIds` 400s.
export async function triggerFieldCascade(folderId, fieldId) {
  const res = await fetch(`${WRIKE}/folders/${folderId}/cascading_field_settings?fieldId=${encodeURIComponent(fieldId)}`, { method: "POST" });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`cascade field on folder ${folderId} (${res.status})${body ? `: ${body}` : ""}`);
  }
}

// ── Req 5: duplicate the whole studio template into Wrike ─────────────────────

// Copy a folder and its whole subtree to a new parent, keeping descriptions and
// custom-field values but not assignees. Returns the new root folder's id.
export async function copyTemplateFolder({ sourceFolderId, parentId, title }) {
  // Only the params Wrike accepts for copy_folder; anything else 400s
  // (copyAttachments and copyCustomStatuses aren't valid). rescheduleMode/Date must
  // be paired, and we don't shift dates.
  const params = new URLSearchParams({
    parent: parentId,
    title,
    copyDescriptions: "true",
    copyCustomFields: "true",
    copyResponsibles: "false",
    // Wrike caps entryLimit at 250. A bigger tree 403s "affected entry limit
    // exceeded", which copyTemplateDeep handles by splitting.
    entryLimit: "250",
  });
  const res = await fetch(`${WRIKE}/copy_folder/${sourceFolderId}?${params}`, { method: "POST" });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`copy_folder (${res.status})${body ? `: ${body}` : ""}`);
  }
  const json = await res.json();
  return json.data?.[0]?.id || null;
}

// Create an empty folder under a parent. Used by the split copier to rebuild a
// too-big folder's shell before copying its children in separately.
async function createFolder(parentId, title) {
  const res = await fetch(`${WRIKE}/folders/${parentId}/folders?title=${encodeURIComponent(title)}`, { method: "POST" });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`create folder (${res.status})${body ? `: ${body}` : ""}`);
  }
  const json = await res.json();
  return json.data?.[0]?.id || null;
}

// Tasks directly in a folder (not its subfolders). A split copy rebuilds the
// folder empty and copies its children, which loses tasks pinned to the folder
// itself, so they're counted and reported.
async function fetchDirectTaskCount(folderId) {
  const rows = await wrikeGet(`/folders/${folderId}/tasks?descendants=false`);
  return rows.length;
}

// Copy a folder subtree of any size, working around the 250-entry cap: try one
// whole copy, and only on the entry limit rebuild the folder and recurse into
// its children. `report` collects the new root id, the number of copy calls,
// and folders whose own tasks couldn't be carried.
export async function copyTemplateDeep({ byId, sourceId, parentId, title, onProgress, report }) {
  report = report || { rootId: null, copies: 0, droppedTaskFolders: [] };
  onProgress?.(`Copying “${title}”…`);
  try {
    const id = await copyTemplateFolder({ sourceFolderId: sourceId, parentId, title });
    report.copies += 1;
    if (!report.rootId) report.rootId = id;
    return report;
  } catch (e) {
    // Only the size limit is fixed by splitting; anything else is a real failure.
    if (!/entry limit/i.test(e.message)) throw e;
  }
  // Too big for one copy — rebuild this folder empty, then copy its children.
  const newId = await createFolder(parentId, title);
  if (!newId) throw new Error(`Could not create folder “${title}”.`);
  if (!report.rootId) report.rootId = newId;
  const directCount = await fetchDirectTaskCount(sourceId);
  if (directCount > 0) report.droppedTaskFolders.push({ title, count: directCount });
  const node = byId[sourceId];
  for (const childId of node?.childIds || []) {
    const child = byId[childId];
    if (!child) continue;
    await copyTemplateDeep({ byId, sourceId: childId, parentId: newId, title: child.title, onProgress, report });
  }
  return report;
}

// Strip a JOBNUMBER_ or XY#####_ prefix, leaving the slot's stable suffix
// ("French_Canada_Assets") that identifies it across renames.
export function slotSuffix(title) {
  return (title || "").replace(/^(JOBNUMBER|XY\d+)_?/i, "");
}

// Every job-slot folder under a root, grouped by suffix, whether it's still
// "JOBNUMBER_…" or already renamed to "XY#####_…".
//
// An ARRAY per suffix: one template slot can hold several jobs, each with its
// own folder (XY026047_French_Canada_Assets and XY026048_French_Canada_Assets).
// Keying on the suffix alone let one job be handed another's folder.
export async function mapSlotFoldersUnder(rootId) {
  const byId = await fetchAllFolders();
  const out = {};
  const walk = (id) => {
    const node = byId[id];
    if (!node) return;
    if (/^(JOBNUMBER|XY\d+)_/i.test(node.title)) {
      (out[slotSuffix(node.title)] ||= []).push({ id: node.id, title: node.title });
    }
    (node.childIds || []).forEach(walk);
  };
  walk(rootId);
  return out;
}

// Which of a slot's folders belongs to this job:
//   1. one already carrying this job's code (a re-push is then a no-op), else
//   2. an unclaimed "JOBNUMBER_…" folder.
// A folder carrying a DIFFERENT job's code is never returned: renaming it would
// destroy that job's allocation. null lets the caller report the job as needing
// a folder.
export function pickSlotFolder(folders, code, claimedIds = new Set()) {
  const list = folders || [];
  const mine = list.find((f) => new RegExp(`^${code}_`, "i").test(f.title || ""));
  if (mine) return mine;
  return list.find((f) => !claimedIds.has(f.id) && !/^XY\d+_/i.test(f.title || "")) || null;
}

// Rename a folder (used to stamp the job code onto a JOBNUMBER_ slot folder).
export async function renameFolder(folderId, title) {
  const res = await fetch(`${WRIKE}/folders/${folderId}?title=${encodeURIComponent(title)}`, { method: "PUT" });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`rename folder (${res.status})${body ? `: ${body}` : ""}`);
  }
}

