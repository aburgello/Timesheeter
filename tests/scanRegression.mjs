// Run the REAL scanner against the REAL folder tree and diff it against a
// committed baseline. Not a unit test — a regression gate.
//
// Why this exists. Every unit test in tests/scan.test.mjs drives a tree I wrote
// by hand, so it only ever proves the cases I thought of. Twice now a change
// passed every hand-written test and still changed the answer on real folders:
//
//   - skipping "_Old" as an organisational folder landed the film on "Digital"
//     for seven job folders under "_Universal House Job > Digital"
//   - matching studio keywords on word boundaries stopped recognising
//     "Universal_UK_Archive", because `_` is a word character
//
// Both were found by measuring against the account's own tree, and both were
// found AFTER the code was pushed. This closes that gap: it reads the folder
// dictionary TimeHub already caches in Supabase (the same data fetchAllFolders
// pulls from Wrike — no Wrike credentials involved), runs scanStudioJobNumbers
// over it, and reports every job whose film, client, region or archived flag
// differs from the baseline.
//
//   node tests/scanRegression.mjs              # diff against the baseline
//   node tests/scanRegression.mjs --write      # accept current output as the baseline
//
// A diff is not automatically a failure — the _Old fix SHOULD change 58 films.
// It is a list to read before pushing. Accept it deliberately with --write, and
// the commit then carries a reviewable record of exactly what moved.
//
// Requires network access to Supabase, which the sandboxed dev container does
// not have; it exits 0 with a notice there rather than failing the suite.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { scanStudioJobNumbers } from "../src/lib/wrikeCampaign.js";

const SUPABASE_URL = "https://oozopadfrupwujsagagn.supabase.co";
// The app's own publishable anon key, already committed in src/lib/supabaseClient.js.
const ANON = process.env.SUPABASE_ANON_KEY || readAnonFromClient();
// Paths are resolved from the repo root, not import.meta.url: this file is
// bundled by esbuild before it runs (the app uses extensionless imports), and
// after bundling import.meta.url points at a temp directory.
const BASELINE = resolve("tests/scanRegression.baseline.json");

function readAnonFromClient() {
  const src = readFileSync(resolve("src/lib/supabaseClient.js"), "utf8");
  return (src.match(/"(eyJ[A-Za-z0-9._-]+)"/) || [])[1] || "";
}

async function loadTree() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/wrike_sync_meta?wrike_user_id=eq.shared&select=folder_dictionary`,
    { headers: { apikey: ANON, Authorization: `Bearer ${ANON}` } }
  );
  if (!res.ok) throw new Error(`tree fetch failed: ${res.status}`);
  const rows = await res.json();
  const fd = rows?.[0]?.folder_dictionary;
  if (!fd || !Object.keys(fd).length) throw new Error("no cached folder dictionary");
  return fd;
}

// Serve the cached tree to the scanner in the shape the Wrike proxy would.
// scope is absent from the cache, so every folder reads as workspace — which is
// correct here: useWrikeCache now filters recycled folders out before storing,
// so what is in the cache is what survives that filter.
function stubWrike(folderDictionary) {
  const data = Object.values(folderDictionary).map((f) => ({
    id: f.id, title: f.title, childIds: f.childIds || [], scope: "WsFolder",
  }));
  globalThis.fetch = async (url) => {
    if (/\/folders\/[^?]/.test(url)) return { ok: true, json: async () => ({ data: [] }) };
    return { ok: true, json: async () => ({ data, nextPageToken: null }) };
  };
}

const key = (r) => r.code;
const shape = (r) => ({
  film: r.filmTitle || "", client: r.client || "",
  region: r.region || "", archived: !!r.archived,
});

const realFetch = globalThis.fetch;
let tree;
try {
  tree = await loadTree();
} catch (e) {
  console.log(`[scanRegression] skipped — cannot reach Supabase (${e.message}).`);
  console.log("[scanRegression] run this from a machine with network access before pushing a scanner change.");
  process.exit(0);
}
globalThis.fetch = realFetch;

stubWrike(tree);
const rows = await scanStudioJobNumbers();
const current = Object.fromEntries(rows.map((r) => [key(r), shape(r)]));

console.log(`[scanRegression] ${Object.keys(tree).length} folders → ${rows.length} job codes`);

if (process.argv.includes("--write")) {
  writeFileSync(BASELINE, JSON.stringify(current, null, 1) + "\n");
  console.log(`[scanRegression] baseline written: ${rows.length} codes`);
  process.exit(0);
}

if (!existsSync(BASELINE)) {
  console.log("[scanRegression] no baseline yet — run with --write to create one.");
  process.exit(0);
}

const base = JSON.parse(readFileSync(BASELINE, "utf8"));
const codes = [...new Set([...Object.keys(base), ...Object.keys(current)])].sort();
const changed = [];
for (const c of codes) {
  const a = base[c], b = current[c];
  if (JSON.stringify(a) !== JSON.stringify(b)) changed.push({ code: c, was: a, now: b });
}

if (!changed.length) {
  console.log("[scanRegression] no change against baseline.");
  process.exit(0);
}

// Group by the transition, so 58 rows moving off "_Old" read as a handful of
// lines rather than 58 — the point is to be READ, not skimmed past.
const groups = new Map();
for (const ch of changed) {
  const k = `${ch.was?.film ?? "(new)"} → ${ch.now?.film ?? "(gone)"}`;
  groups.set(k, (groups.get(k) || 0) + 1);
}
console.log(`\n[scanRegression] ${changed.length} of ${codes.length} codes differ:\n`);
for (const [k, n] of [...groups].sort((x, y) => y[1] - x[1])) {
  console.log(`  ${String(n).padStart(4)}  ${k}`);
}
console.log("\nRead these before pushing. If they are all intended, accept with --write.");
process.exit(1);
