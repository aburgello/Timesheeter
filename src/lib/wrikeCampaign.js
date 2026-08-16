// Bulk Campaign ↔ Wrike write layer.
//
// Every call goes through the Worker proxy at /api/wrike/* (worker/index.js),
// which attaches the member's OAuth token — the browser never sees it. The
// proxy is a generic pass-through for any method, so GET/PUT/POST to any Wrike
// path work here without worker changes.
//
// Design rule for this module: **plan** functions are read-only (safe to run
// any time — they only GET) and return a preview of exactly what an **apply**
// would change; **apply** functions are the only ones that write. The UI always
// runs plan → shows the preview → and writes only on an explicit confirm. This
// is what makes the feature safe to ship without being able to test the live
// Wrike auth locally: nothing mutates Wrike until a human approves the plan.

import { fetchRetrying } from "./fetchPool";
import { STUDIO_KEYWORDS_FLAT, STUDIO_CLIENT } from "./studios";

const WRIKE = "/api/wrike";

// ── Low-level GET helpers ─────────────────────────────────────────────────────

// fetchRetrying, not bare fetch: Wrike's rate limit is per ACCOUNT, so a scan
// can be refused because of traffic it had nothing to do with — the board
// loading attachments for a few hundred tasks, say. Treating that 429 as a
// hard failure aborted the whole scan and reported it as "Scan failed" with a
// Wrike URL, which reads like the request was malformed rather than merely
// early. Waiting the limit out costs a second and usually succeeds.
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
    // Paged reads are the most exposed of all: a scan that has already fetched
    // nine pages should not throw the lot away because the tenth arrived while
    // the account was momentarily over budget.
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

// Find the "Job Number" custom field by title (we don't hardcode its ID — it's
// discovered at runtime so this keeps working across workspaces / if the field
// is recreated). Matching is progressively looser so a field literally called
// "Job Number" wins, but "Job No." / "Job Code" still resolve.
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

// The per-slot price carried on each JOBNUMBER folder in the studio templates.
// Discovered by title like the Job Number field above, for the same reason.
// Note it's permissioned to project managers in Wrike, so a member without
// that visibility gets no field back — callers must treat "not found" as
// "leave the cost empty", never as an error.
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

// Pull the whole flat folder list once (id, title, childIds) so callers can walk
// the tree locally without N round-trips.
//
// Recycle-bin filtering: the FolderTree default mode returns the workspace AND
// the recycle bin (its root + every recycled descendant) in one flat list — so
// a *deleted* copy of a film shows up here indistinguishable from the live one
// unless we filter it out. Wrike tags every tree node with a `scope`: workspace
// nodes are WsRoot/WsFolder, recycled ones are RbRoot/RbFolder/RbTask. `scope`
// comes back on its own (like `project` does on the by-id endpoint) — it just
// can't be named in `fields=` (that 400s "'scope' not allowed"; only childIds is
// requestable there). We drop every Rb* node at this single source so no
// downstream matcher (findFilmLocation, findStudioFolder, template lookup,
// planFilmSync) can ever resolve to something sitting in the recycle bin.
// Scope-less rows are kept, so if Wrike ever stops returning scope we degrade to
// the old behaviour rather than nuking the whole tree.
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

// Which of the given folder ids are Wrike Projects (item type "Project"). The
// by-id folder endpoint returns full Folder objects, which carry `project` by
// DEFAULT — like `scope`, it's not requestable via fields= (that 400s
// "'project' not allowed"), it just comes back on its own. Batched into chunks
// of 100 (Wrike's per-request id cap). Returns [{ id, title }] for projects only.
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

// Locate a studio's root folder (e.g. "Paramount") — a sibling of Universal /
// SONY inside the STUDIO space's root, per the workspace layout. We match a
// folder whose title is exactly the studio name (normalised), preferring one
// that actually contains child projects so we don't pick an empty namesake.
export function findStudioFolder(byId, studioName) {
  const wanted = norm(studioName);
  const matches = Object.values(byId).filter((f) => norm(f.title) === wanted);
  if (!matches.length) return null;
  // Prefer the candidate with the most children (the populated studio folder).
  matches.sort((a, b) => (b.childIds?.length || 0) - (a.childIds?.length || 0));
  return matches[0];
}

// Every folder id in the subtree rooted at rootId (inclusive). Used by the
// template-write guard: we never write into any of these ids.
export function collectSubtreeIds(byId, rootId, seen = new Set()) {
  if (!rootId || seen.has(rootId)) return seen;
  seen.add(rootId);
  const node = byId[rootId];
  (node?.childIds || []).forEach((c) => collectSubtreeIds(byId, c, seen));
  return seen;
}

// Studio keywords and the client each maps to now come from studios.js, which
// the enricher reads too. They used to be two hand-maintained lists that had
// drifted apart in both directions -- the enricher knew marvel/pixar/lucasfilm/
// columbia/tristar/mgm/wbros/wb and this one knew none of them; this one knew
// Lionsgate and XYi and the enricher knew neither -- so the scan could propose
// a client the enricher would never derive.
//
// Note this file still matches with its own rule (word boundaries on the raw
// title, below) rather than studios.js's separator-aware one. That difference
// is deliberate and load-bearing, and the reason is bigger than it looks.
//
// Measured against the cached tree: adopting the separator-aware rule here
// would newly treat 63 folders as studio nodes -- _Universal_MASTER,
// _Paramount_MASTER_TEMPLATES, _Sony_MASTER_TEMPLATES, _Universal House Job,
// _XYi IN HOUSE DIGITAL and the like. Those 63 have 7,209 descendants between
// them, of which 2,780 are job-code folders.
//
// That matters because describeChain locates the studio node and then takes its
// CHILD as the film. Moving the studio node down the chain moves the film with
// it, so this would change the proposed film on the majority of job folders in
// the account. Not a refactor -- a re-scan of the whole book. The LIST is
// shared; the matching stays separate until someone runs that scan and reads
// the review.
const STUDIO_KEYWORDS = STUDIO_KEYWORDS_FLAT;

const deUnderscore = (s) => (s || "").replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();

// Region qualifiers that mark a regional studio folder (e.g. "UNIVERSAL AUSTRALIA")
// as a variant of a base studio ("UNIVERSAL"). Used both to pick a sensible
// default territory (findFilmLocation) and to label scanned jobs by region.
const REGION_QUALIFIER = /\b(AUSTRALIA|UK|US|USA|NEW MEDIA|INTERNATIONAL|INTL|EU|EMEA|APAC|CANADA|GERMANY|FRANCE|SPAIN|ITALY|JAPAN|KOREA|LATAM|NORDIC|BENELUX)\b/i;

// The same slot exists under several studio folders — "Sky VIP" under UNIVERSAL
// UK is a different job from the one under UNIVERSAL — and the timesheet site
// distinguishes them by prefixing the description with a short region code
// ("UK - Sky VIP Assets", "NM - Digital - Packshots"). Without this every
// territory's copy of a slot scans in under one indistinguishable label.
const REGION_SHORT = {
  AUSTRALIA: "AUS", UK: "UK", US: "US", USA: "US", "NEW MEDIA": "NM",
  INTERNATIONAL: "INT", INTL: "INT", EU: "EU", EMEA: "EMEA", APAC: "APAC",
  CANADA: "CAN", GERMANY: "GER", FRANCE: "FRA", SPAIN: "SPA", ITALY: "ITA",
  JAPAN: "JPN", KOREA: "KOR", LATAM: "LATAM", NORDIC: "NORDIC", BENELUX: "BENELUX",
};

// A studio folder with no qualifier ("UNIVERSAL") is the international arm —
// that's the site's convention ("INT - DOOH Outdoor Campaign") and Management's
// own STUDIO_CLIENT map agrees ("Universal International"). XYi is excluded: its
// internal jobs have no territory at all.
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
// unique XY code found.
//
// Real job folders live at STUDIO space → <Studio> (e.g. SONY) → <Film> (e.g.
// "Focker In-Law") → <Job> ("XY025563_Germany_Launch_Assets"). So for every
// folder whose title carries an XY code we:
//   • take the code (XY025563),
//   • read the description from the folder-title suffix after the code
//     ("_Germany_Launch_Assets" → "Germany Launch Assets"),
//   • climb the ancestry to the studio folder → derive client, and take the
//     child-of-studio on that path as the film ("Focker In-Law"),
//   • assemble the canonical Job Book line "Film : CODE, Description".
// Folders that are ALREADY in canonical "Film : CODE, Desc" shape are taken
// verbatim instead of reassembled. `totalFolders` is returned so the caller can
// tell an empty result (pattern miss) apart from a dead/blocked fetch (0 folders).
export async function scanStudioJobNumbers({ studioKeywords } = {}) {
  const KEYWORDS = studioKeywords || STUDIO_KEYWORDS;
  const byId = await fetchAllFolders();
  const totalFolders = Object.keys(byId).length;

  // Upward parent map (fetchAllFolders only gives childIds, i.e. downward).
  // ALL parents, not one: Wrike shares a single folder into several places — the
  // whole territory feature in findFilmLocation depends on it. A last-writer-wins
  // `parentOf[c] = f.id` map silently picks one arbitrary parent, so a film also
  // filed under _Archive (or a master-template tree) climbs the wrong path and
  // the job comes back archived, film-less and region-less — which hides it from
  // the scan's default "Active only" view entirely.
  const parentsOf = {};
  Object.values(byId).forEach((f) =>
    (f.childIds || []).forEach((c) => { (parentsOf[c] || (parentsOf[c] = [])).push(f.id); })
  );

  const studioKwOf = (title) =>
    KEYWORDS.find((k) => new RegExp(`\\b${k}\\b`, "i").test(title || ""));
  // An "archived" job is one filed under the studio's _Archive folder (or a
  // master-template tree). Cheap, org-native active/inactive signal — no per-job
  // status fetch, which job folders don't carry anyway (only Projects do).
  const isArchiveNode = (title) =>
    /(^|[\s_])_?archive\b/i.test(title || "") || /master.?template/i.test(title || "");

  // A bare year / number (e.g. "2026") is an organisational folder, not a film.
  const isYearFolder = (title) => /^\d{2,4}$/.test((title || "").trim());

  // Organisational, not a film. The studio's own convention marks these with a
  // leading underscore, and it is followed without exception: of 665 such
  // folders in the tree, every one is a container -- _Market, _Masters,
  // _Title_Delivery, _Supplied, _House_Keeping, _Media_Approval, _TERRITORY,
  // _BRIEF_TEMPLATES -- and not one is a film title.
  //
  // Skipping them matters because deUnderscore turns a folder name into a film
  // name, so "_Old" became a film called "Old". Under Universal - New Media,
  // "_Old" holds year folders which hold the real films (Wicked, The Brutalist,
  // Nosferatu, Wolf Man), and the film loop below stopped at "_Old" because it
  // only knew how to skip years. 47 Job Book rows across many different films
  // collapsed onto the single film "Old" -- 81% of them with a generic
  // description ("NM Titles", "Packshots FinalWindow"), spanning 15 months,
  // where a real campaign spans a few. Their descriptions still name the films
  // they belong to: BLB, WYD, DRP, PHS, HDG, JW4.
  //
  // This also picks up _zArchive, which isArchiveNode misses -- its pattern
  // wants "archive" directly after the boundary, and "_zArchive" has a "z" in
  // between.
  const isOrgFolder = (title) => /^_/.test((title || "").trim());

  // The medium is not a film either. Caught by measuring the org-folder skip
  // above against the real tree: for "UNIVERSAL › _Universal House Job ›
  // Digital › <job>", skipping the container landed on "Digital", so seven job
  // folders came back with the film "Digital" or "Print" — worse than the
  // "Universal House Job" they had before. Skipping the medium too means those
  // fall through to the child-of-studio fallback and stay as they were.
  const isMediumFolder = (title) =>
    /^(digital|print)$/i.test(deUnderscore(title || ""));

  // A house-job container is not something to skip past — it IS the answer.
  //
  // The other containers (_Old, _zArchive) hold real films further down, so
  // skipping them finds one. House-job trees do not: they hold work types.
  // Under "_Universal House Job > Print > Cards" the skip landed the film on
  // "Cards", and under "_UK House Jobs > OLS - UK" on "OLS - UK" — three and
  // one job code respectively, both worse than the container name they had.
  // A house job has no film by definition, so the container is the best label
  // available and the descent should stop there.
  //
  // Anchored at the END, and never on a job folder, because "Housekeeping For
  // Beginners" is a real film and "XY018540_Digital_Housekeeping" is a job. A
  // substring test for "housekeeping" would swallow both.
  const isHouseJobFolder = (title) => {
    const t = deUnderscore(title || "");
    if (/^XY\d{5,6}/i.test(t)) return false;
    return /\b(house\s*jobs?|house\s*keeping|housekeeping)$/i.test(t);
  };

  // Climb the full ancestry of a job folder. The film is the folder between the
  // studio and the job — but studios often insert a "2026" year folder in
  // between, so we take the DEEPEST non-year folder on that stretch (closest to
  // the job) rather than blindly the child-of-studio, which would be the year.
  // Read one ancestry chain (job → … → root) into the fields a Job Book row needs.
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
      // Nothing but year/organisational folders between job and studio — fall
      // back to the child-of-studio as before. That keeps the house jobs
      // working: a job filed straight under "_Universal_House_Keeping" has no
      // real film folder to find, and the fallback still names it rather than
      // leaving the row film-less.
      if (!filmNode) filmNode = chain[si - 1];
    }
    return {
      studioKw,
      // The studio node's FULL title, not just the matched keyword: "UNIVERSAL UK"
      // and "UNIVERSAL" both match `Universal`, and the qualifier is the only
      // thing that tells the two territories' jobs apart.
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
    // Set when a walk stops because it ran out of budget rather than because it
    // reached a root. The chain pushed in that case is a PARTIAL one, and a
    // partial chain yields no film, no client and no region — which reads
    // downstream exactly like a job that genuinely has none. Recording it is
    // what lets the scan review say "could not establish" instead of "none".
    let truncated = false;
    const walk = (id, chain, seen) => {
      // Bounded: shared folders can fan out, and this runs per job code across
      // the whole tree. Depth 40 matches the old climb; 24 paths is plenty to
      // find a live one without letting a pathological tree stall the scan.
      if (chain.length >= 40 || chains.length >= 24) { truncated = true; chains.push(chain); return; }
      const parents = (parentsOf[id] || []).filter((pid) => byId[pid] && !seen.has(pid));
      if (!parents.length) { chains.push(chain); return; }
      for (const pid of parents) {
        walk(pid, chain.concat(byId[pid]), new Set(seen).add(pid));
      }
    };
    walk(startId, [], new Set([startId]));

    // Keep the node list beside each summary so the winning path can be
    // recovered for the "Wrike: studio › film › folder" breadcrumb the scan
    // review shows next to a correction.
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

  // Group every folder carrying a code, THEN choose — rather than taking the
  // first one and skipping the rest.
  //
  // "First" used to mean the order Wrike's /folders endpoint happened to return
  // rows in: byId is keyed by folder id, those ids are non-numeric strings, so
  // JS iterates them in insertion order, and insertion order is just the API's
  // page order. Wrike documents no ordering there, so a code sitting on both a
  // live folder and an _Archive copy resolved to whichever Wrike listed first —
  // and could resolve differently on the next scan. When the archive copy won,
  // the job came back archived with the archive folder's ancestry for a film,
  // and dropped out of the scan's default "Active only" view entirely.
  //
  // ancestryOf already knows how to rank: it scores every PATH out of one
  // folder as (hasStudio ? 2 : 0) + (archived ? 0 : 1). The same score decides
  // between FOLDERS here, so a live placed copy beats an archived one no matter
  // what order they arrive in.
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

  // Codes that live on more than one folder, so the caller can surface the
  // ambiguity instead of it being silently resolved. Two live folders under
  // different studios sharing a code is a data problem in Wrike that no
  // heuristic can settle — but it should be visible, not invisible.
  const contestedCodes = [];

  const out = [];
  foldersByCode.forEach((candidates, code) => {
    const described = candidates.map((c) => ({ ...c, ...ancestryOf(c.f.id, c.title) }));

    // Best rank wins; ties break on folder id so a rescan always agrees with
    // itself. Arbitrary, but deterministic — which the old order was not.
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
    // "Universal Pictures UK" / "Universal Pictures International" — the client
    // the Job Book and the timesheet site both name, rather than every region's
    // jobs collapsing onto a bare "Universal Pictures".
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
      // Underscore folder ("XY025563_Germany_Launch_Assets") — reassemble, and
      // carry the region the folder lives under into the description the way
      // the timesheet site writes it ("UK - Sky VIP"). Skipped when the folder
      // already leads with a region code, so a rescan can't stack "UK - UK - ".
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

  // Pull each job folder's Wrike createdDate (the flat tree endpoint doesn't
  // carry it; the by-id endpoint returns it by default). Batched 100 at a time.
  // Never let this discard the scan. By the time we get here the whole tree has
  // been fetched, inverted, walked and ranked — minutes of work and a large
  // slice of the account's shared rate-limit budget — and wrikeGet throws on any
  // non-OK response, so one 429 that outlived its retries used to throw all of
  // it away for a date shown beside the row. createdDate is already optional
  // downstream (`createdById[o.folderId] || null` below), which is the same call
  // fetchFolderItemPrice makes for a permissioned price: never block staging a
  // job on a lookup the job does not depend on.
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
  // Codes found on more than one folder. The pick above is deterministic and
  // prefers a live placed copy, but where two live folders genuinely share a
  // code no heuristic can settle it — so hand the ambiguity to the caller
  // rather than resolving it out of sight.
  out.contestedCodes = contestedCodes;
  // Diagnostics the caller can show beside the scan, in the same spirit as
  // contestedCodes: say what the scan could not establish rather than letting
  // it read as established. `truncatedCodes` are jobs whose ancestry walk hit
  // its own bounds, so their film/client/region reflect a partial climb and are
  // not distinguishable, from the row alone, from a job that genuinely has none.
  out.truncatedCodes = out.filter((o) => o.ancestryTruncated).map((o) => o.code);
  out.createdDateBatchesFailed = createdDateBatchesFailed;
  return out;
}

// Do two job descriptions describe the same job?
//
// Used by the Job Book reconciliation to tell "this row was filed against a
// different job" from "this row is worded differently", which look identical
// to a string compare and could not matter more: the first is bad data, the
// second is every row.
//
// Deliberately loose, in two ways:
//
//   • Punctuation, underscores and case are dropped. The same description
//     arrives as "French_Canada_Assets" from a folder title and "French Canada
//     Assets" once reassembled.
//   • Containment counts as agreement, because the two sides legitimately
//     carry different amounts of the same information. scanStudioJobNumbers
//     prefixes the region the way the timesheet site writes it ("INT - French
//     Canada Assets"); a description read straight off the folder at pull time
//     has no region to prefix. Neither is wrong, and demanding equality would
//     propose a rewrite for essentially every row in the book.
//
// Containment errs toward saying "these agree", so a short description that
// happens to sit inside a longer one is missed rather than falsely rewritten.
// That is the right direction to be wrong in: a missed correction costs a
// scruffy label, a false one overwrites a description somebody chose.
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

// Count JOBNUMBER folders anywhere beneath a node — used to score master-template
// candidates (the real, populated template has the most).
function countJobNumberFolders(byId, rootId, seen = new Set()) {
  if (seen.has(rootId)) return 0;
  seen.add(rootId);
  const node = byId[rootId];
  if (!node) return 0;
  let n = /JOBNUMBER/i.test(node.title) ? 1 : 0;
  (node.childIds || []).forEach((c) => { n += countJobNumberFolders(byId, c, seen); });
  return n;
}

// Locate a studio's master-template root (e.g. "_Paramount_MASTER_TEMPLATES").
// Same fuzzy match the fetch uses: title contains the studio AND "MASTER
// TEMPLATE"; among candidates pick the one with the most JOBNUMBER folders,
// penalising obvious duplicates (copy/archive), so we copy the real template.
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

// Which studio does this film live under? Films sit one level inside a studio
// folder, so the film's parent IS its studio. Resolved from Wrike rather than
// stored: the films table only keeps a title, and deriving it keeps working for
// films added long before any of this existed.
//
// Matched with norm(), not raw equality — Wrike names projects with underscores
// ("Fake_Film_Tryout") while the films table stores spaces ("Fake Film Tryout").
//
// The subtle part: a film pushed before job folders were renamed in place has a
// folder named after the film INSIDE the film project, so the title matches
// twice — the project under Paramount, and the wrapper under that project.
// Picking the wrapper makes its parent (the project) look like the studio, and
// we'd go hunting for a "Fake_Film_Tryout" master template. So prefer the match
// whose parent is NOT itself the same film: the outermost one, sitting in its
// real studio folder.
export function findFilmLocation(byId, filmTitle) {
  if (!(filmTitle || "").trim()) return null;

  // childIds is the only link Wrike gives us, so invert it to walk upwards. A
  // Wrike project can be shared into SEVERAL folders, so keep ALL parents, not
  // just the first — that's what lets one film show up under multiple studio
  // "territories" (UNIVERSAL, UNIVERSAL AUSTRALIA, …).
  const parentsOf = {};
  Object.values(byId).forEach((f) =>
    (f.childIds || []).forEach((c) => { (parentsOf[c] || (parentsOf[c] = [])).push(f.id); })
  );

  const isSameFilm = (t) => norm(t) === norm(filmTitle);
  const matches = Object.values(byId).filter((f) => isSameFilm(f.title));

  // Every (film project × studio parent) pair, skipping same-film wrappers. One
  // shared project yields several territories; separate per-region projects also
  // collapse in here. De-duped by studio folder id.
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

  // Default to the base studio: prefer a parent WITHOUT a region qualifier, then
  // the one whose project carries the most slot folders ("where the real stuff
  // is"), then the shorter name. This is why "The Odyssey" defaults to UNIVERSAL,
  // not UNIVERSAL AUSTRALIA.
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

// Build a display tree of a film's OWN Wrike subtree — NOT the studio template.
// This is the truthful view: an old campaign's folders have already been renamed
// in place (JOBNUMBER_French_Canada_Assets → XY025623_French_Canada_Launch) and
// have drifted from the template's slot set entirely, so the template can't be
// reconciled against them — only the film itself tells you what exists.
//
// Every job-slot folder is tagged from its LIVE name, which is the source of
// truth for allocation: a title starting "XY#####_" already carries a real job
// number (allocated); one still "JOBNUMBER_" is a genuine pending slot. This is
// what stops an already-numbered film from reading as "0 activated" and inviting
// a duplicate re-number.
//
// Returns { filmProject, studio, studioFolder, territories, tree, hasSlots } —
// hasSlots:false means the film has no job-slot folders yet (never pushed), so
// the caller should fall back to the studio template. null means the film project
// wasn't found in Wrike at all. `territories` lists every studio this film lives
// under (for the territory swap); pass a studioFolderId to build a specific one
// (otherwise the base studio picked by findFilmLocation wins).
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

// Read-only plan: which Wrike film projects are missing from the films table.
// `existingTitles` is the set already in Supabase. We never delete films that
// exist locally but not in Wrike — this is additive only, so a hand-added film
// is never clobbered by the sync.
export async function planFilmSync(studioName, existingTitles) {
  const byId = await fetchAllFolders();
  const studioFolder = findStudioFolder(byId, studioName);
  if (!studioFolder) {
    return { error: `No “${studioName}” folder found in Wrike.`, studioFolder: null, toAdd: [] };
  }
  // Wrike project folders are named with underscores (Angry_Birds_3_Movie) —
  // present them as clean, spaced film titles.
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

// Every task AND subtask anywhere beneath a folder. Wrike's folder-tasks
// endpoint recurses into descendant folders by default; subTasks=true pulls the
// subtasks in too. We only request customFields (the field we compare/write) —
// other optional fields (subTaskIds etc.) are deliberately omitted because
// Wrike 400s when some of them are passed explicitly on list queries.
export async function fetchTasksUnderFolder(folderId) {
  const FF = encodeURIComponent("[customFields]");
  return wrikeGetAll(`/folders/${folderId}/tasks?fields=${FF}&subTasks=true&pageSize=1000`);
}

// Write the Job Number custom field on a single task. Wrike takes params in the
// query string (like every other call this app makes), with the customFields
// array JSON-encoded.
async function putTaskJobNumber(taskId, fieldId, value) {
  const cf = encodeURIComponent(JSON.stringify([{ id: fieldId, value: String(value) }]));
  const res = await fetch(`${WRIKE}/tasks/${taskId}?customFields=${cf}`, { method: "PUT" });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`set field on ${taskId} (${res.status})${body ? `: ${body}` : ""}`);
  }
}

// Read-only plan for req 1/2: which tasks under `folderId` don't yet carry
// `jobNumber` in the field. Splitting already-set vs needs-set is what makes the
// same call serve both the first propagation (req 1) and the later top-up of
// newly-added items (req 2) — re-running only ever touches what's missing.
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

// Apply the field to every task in `willSet`. Sequential (Wrike rate-limits
// bursts), collecting per-task failures rather than aborting on the first —
// callers surface the count so a couple of permission failures don't hide the
// dozens that succeeded. onProgress(done, total) drives the progress bar.
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

// Set the Job Number custom field on a single FOLDER. Folders take customFields
// exactly like tasks (PUT with the JSON-encoded array) — renaming only stamps
// the title, so this is what actually fills the folder's own "Job Number" field.
export async function setFolderJobNumber(folderId, fieldId, value) {
  const cf = encodeURIComponent(JSON.stringify([{ id: fieldId, value: String(value) }]));
  const res = await fetch(`${WRIKE}/folders/${folderId}?customFields=${cf}`, { method: "PUT" });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`set field on folder ${folderId} (${res.status})${body ? `: ${body}` : ""}`);
  }
}

// Turn on Wrike-native field cascading for one field on a folder: Wrike then
// pushes the folder's CURRENT value down to every subitem — nested folders AND
// tasks, current AND any created later. This is exactly the UI's "Apply value to
// all current and future subitems" button, so we set the folder value first
// (setFolderJobNumber) and then call this.
//
// Contract verified live against the account (the published reference is wrong):
// the param is a SINGULAR `fieldId` plain-string query param, NOT a `fieldIds`
// array — Wrike 400s "Parameter 'fieldIds' is not allowed" otherwise, and 200s
// with { kind: "cascadingFieldSettings", data:[{ fieldId, … }] } on this shape.
export async function triggerFieldCascade(folderId, fieldId) {
  const res = await fetch(`${WRIKE}/folders/${folderId}/cascading_field_settings?fieldId=${encodeURIComponent(fieldId)}`, { method: "POST" });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`cascade field on folder ${folderId} (${res.status})${body ? `: ${body}` : ""}`);
  }
}

// ── Req 5: duplicate the whole studio template into Wrike ─────────────────────

// Copy a folder (and its entire subtree — folders, tasks, subtasks) to a new
// parent. copyDescriptions/copyCustomFields keep the template's content;
// copyResponsibles is off so a duplicated template isn't auto-assigned to
// whoever is on the template. Returns the new root folder's id.
export async function copyTemplateFolder({ sourceFolderId, parentId, title }) {
  // Only the documented, accepted copy_folder params — Wrike 400s on anything
  // else (copyAttachments / copyCustomStatuses are NOT valid params). We keep
  // descriptions and custom-field VALUES, and deliberately don't copy
  // responsibles so a duplicated template isn't auto-assigned to the template's
  // people. No rescheduleMode/Date (must be paired; we're not shifting dates).
  const params = new URLSearchParams({
    parent: parentId,
    title,
    copyDescriptions: "true",
    copyCustomFields: "true",
    copyResponsibles: "false",
    // entryLimit is hard-capped at 250 by Wrike (values >250 are rejected). A
    // tree bigger than this 403s "affected entry limit exceeded" — copyTemplateDeep
    // catches that and splits the copy so the whole template still comes across.
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

// Count tasks sitting DIRECTLY in a folder (not in its subfolders). When we have
// to split a too-big folder we rebuild it empty and copy its child folders in —
// which carries every subfolder's tasks, but not tasks pinned to the container
// folder itself. We surface those so nothing is ever lost silently.
async function fetchDirectTaskCount(folderId) {
  const rows = await wrikeGet(`/folders/${folderId}/tasks?descendants=false`);
  return rows.length;
}

// Copy a folder subtree of ANY size into `parentId`, working around Wrike's
// 250-entry copy cap. Tries a whole-subtree copy first (fast, fully faithful);
// only when that hits the entry limit does it rebuild the folder shell and
// recurse into each child. `report` accumulates the new root id, how many copy
// calls ran, and any container folders whose direct tasks couldn't be carried.
export async function copyTemplateDeep({ byId, sourceId, parentId, title, onProgress, report }) {
  report = report || { rootId: null, copies: 0, droppedTaskFolders: [] };
  onProgress?.(`Copying “${title}”…`);
  try {
    const id = await copyTemplateFolder({ sourceFolderId: sourceId, parentId, title });
    report.copies += 1;
    if (!report.rootId) report.rootId = id;
    return report;
  } catch (e) {
    // Only the size limit is recoverable by splitting — anything else is a real
    // failure and must propagate.
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

// Strip a JOBNUMBER_ or XY#####_ prefix off a folder title, leaving the slot's
// stable suffix (e.g. "French_Canada_Assets") that identifies it across renames.
export function slotSuffix(title) {
  return (title || "").replace(/^(JOBNUMBER|XY\d+)_?/i, "");
}

// Map every job-slot folder under a root by its suffix. Rename-resilient: it
// matches a folder whether it's still "JOBNUMBER_…" or already renamed to
// "XY#####_…", so re-pushing/reconciling finds the same folder every time.
//
// Returns an ARRAY per suffix, because a suffix does not identify a folder.
// The Job Book deliberately allows one template slot to hold several jobs
// (activateSlot stages another job of the same type on purpose), and each of
// those needs its own folder — so "French_Canada_Assets" can legitimately name
// both XY026047_French_Canada_Assets and XY026048_French_Canada_Assets.
//
// This used to be a plain assignment keyed on the suffix, which meant the
// second folder silently overwrote the first and only one survived — whichever
// the walk happened to reach last, i.e. dependent on the order Wrike returns
// childIds. Combined with a rename that trusted the map, one job could be
// handed another job's folder and rename it onto its own code.
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

// Which of a slot's folders belongs to this job.
//
//   1. A folder already carrying this job's own code — the re-push case.
//      Matching it makes a repeat push a no-op instead of a rename.
//   2. Otherwise an unclaimed folder still named "JOBNUMBER_…", i.e. a genuinely
//      free slot.
//
// A folder already carrying a DIFFERENT job's code is never returned. That is
// the whole point: it is somebody else's folder, and renaming it onto this code
// destroys their allocation while leaving two folders answering to one code.
// Returning null instead lets the caller report the job as needing a folder,
// which is recoverable, rather than silently trading one job's work for
// another's.
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

// After a copy, re-read the new tree and map each JOBNUMBER_ folder title to its
// new folder id, so propagation (req 1) can target the right subtree per slot.
export async function mapJobNumberFoldersUnder(rootFolderId) {
  const byId = await fetchAllFolders();
  const out = {};
  const walk = (id) => {
    const node = byId[id];
    if (!node) return;
    if (/JOBNUMBER/i.test(node.title)) out[node.title] = node.id;
    (node.childIds || []).forEach(walk);
  };
  walk(rootFolderId);
  return out;
}
