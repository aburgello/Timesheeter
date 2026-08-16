// Run the REAL scanner against the REAL folder tree and diff it against a
// committed baseline. Not a unit test — a regression gate.
//
// Why this exists. Every test in tests/scan.test.mjs drives a folder tree
// written by hand, so it only proves the cases someone thought of. Twice a
// change passed all of them and still changed the answer on real folders:
//
//   - skipping "_Old" as an organisational folder landed the film on "Digital"
//     for seven jobs under "_Universal House Job > Digital"
//   - matching studio keywords on word boundaries stopped recognising
//     "Universal_UK_Archive", because `_` is a word character
//
// Both were caught by measuring against the account's own tree, and both after
// the code was pushed. Worse, the measuring was ad-hoc SQL that re-implemented
// the logic, and the first version of that SQL omitted the child-of-studio
// fallback — which made a safe change look like it dropped 13 films.
//
// The fix for both problems is the same: stop modelling the code and run it.
//
//   npm run scan:diff      diff the real scanner's output against the baseline
//   npm run scan:accept    accept the current output as the new baseline
//
// IMPORTANT: capture the baseline from the code you run TODAY (i.e. from main)
// before checking out a branch that changes the scanner. A baseline taken on
// the branch bakes the change in and the gate proves nothing.
//
// A diff is not a failure. The _Old fix SHOULD move ~58 films. It is a list to
// read before pushing; accepting it writes a baseline the commit carries, so
// what moved is reviewable rather than asserted.
//
// Reads the folder dictionary TimeHub already caches in Supabase — the same
// data fetchAllFolders pulls from Wrike, so no Wrike credentials are involved.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { scanStudioJobNumbers } from "../src/lib/wrikeCampaign.js";
import { supabase, sessionReady } from "../src/lib/supabaseClient.js";

// Resolved from the repo root, not import.meta.url: this file is bundled by
// esbuild before it runs (the app uses extensionless imports), and after
// bundling import.meta.url points at a temp directory.
const BASELINE = resolve("tests/scanRegression.baseline.json");

// Read through the app's OWN client, awaiting its anonymous sign-in.
//
// A raw REST call carrying only the anon key returns ZERO ROWS rather than an
// error — RLS filters it out, and an empty result is indistinguishable from
// "there is no cached tree". supabaseClient.js says so itself: anything that
// does not await sessionReady "will run as `anon` and be rejected by RLS".
// Going through the same client the app uses means this cannot drift from what
// the app itself can see.
async function loadTree() {
  const session = await sessionReady;
  if (!session) throw new Error("anonymous sign-in failed — cannot read through RLS");
  const { data, error } = await supabase
    .from("wrike_sync_meta")
    .select("folder_dictionary")
    .eq("wrike_user_id", "shared")
    .maybeSingle();
  if (error) throw new Error(`${error.message} (${error.code || "no code"})`);
  const fd = data?.folder_dictionary;
  if (!fd || !Object.keys(fd).length) {
    throw new Error("the shared row carries no folder_dictionary — has a sync run?");
  }
  return fd;
}

// Serve the cached tree in the shape the Wrike proxy would. scope is absent
// from the cache, so every folder reads as workspace — correct here, because
// useWrikeCache filters recycled folders out before storing, so what is in the
// cache is exactly what survives that filter.
function stubWrike(folderDictionary) {
  const data = Object.values(folderDictionary).map((f) => ({
    id: f.id, title: f.title, childIds: f.childIds || [], scope: "WsFolder",
  }));
  globalThis.fetch = async (url) => {
    if (/\/folders\/[^?]/.test(url)) return { ok: true, json: async () => ({ data: [] }) };
    return { ok: true, json: async () => ({ data, nextPageToken: null }) };
  };
}

const shape = (r) => ({
  film: r.filmTitle || "", client: r.client || "",
  region: r.region || "", archived: !!r.archived,
});

async function main() {
  let tree;
  try {
    tree = await loadTree();
  } catch (e) {
    // Not a failure: the sandboxed dev container has no route to Supabase, and
    // this must never block the ordinary test suite.
    console.log(`[scanRegression] skipped — could not load the folder tree: ${e.message}`);
    console.log("[scanRegression] needs network access to Supabase and a completed sync.");
    return 0;
  }

  const realFetch = globalThis.fetch;
  stubWrike(tree);
  let rows;
  try {
    rows = await scanStudioJobNumbers();
  } finally {
    globalThis.fetch = realFetch;
  }
  const current = Object.fromEntries(rows.map((r) => [r.code, shape(r)]));
  console.log(`[scanRegression] ${Object.keys(tree).length} folders -> ${rows.length} job codes`);

  if (process.argv.includes("--write")) {
    writeFileSync(BASELINE, JSON.stringify(current, null, 1) + "\n");
    console.log(`[scanRegression] baseline written: ${rows.length} codes`);
    return 0;
  }

  if (!existsSync(BASELINE)) {
    console.log("[scanRegression] no baseline yet — run `npm run scan:accept` on main first.");
    return 0;
  }

  const base = JSON.parse(readFileSync(BASELINE, "utf8"));
  const codes = [...new Set([...Object.keys(base), ...Object.keys(current)])].sort();
  const changed = codes
    .map((c) => ({ code: c, was: base[c], now: current[c] }))
    .filter((d) => JSON.stringify(d.was) !== JSON.stringify(d.now));

  if (!changed.length) {
    console.log("[scanRegression] no change against baseline.");
    return 0;
  }

  // Grouped by transition, so 58 rows moving off "_Old" read as a handful of
  // lines rather than 58 — the point is to be read, not skimmed past.
  const groups = new Map();
  for (const ch of changed) {
    const k = `${ch.was?.film ?? "(new)"} -> ${ch.now?.film ?? "(gone)"}`;
    groups.set(k, (groups.get(k) || 0) + 1);
  }
  console.log(`\n[scanRegression] ${changed.length} of ${codes.length} codes differ:\n`);
  for (const [k, n] of [...groups].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${k}`);
  }

  // The two shapes that are always wrong, called out rather than left to be
  // spotted: a medium is never a film, and a job should not lose one.
  const media = changed.filter((c) => /^(digital|print)$/i.test(c.now?.film || ""));
  const lost  = changed.filter((c) => c.was?.film && !c.now?.film);
  if (media.length) {
    console.log(`\n  !! ${media.length} landed on a MEDIUM folder: ${media.slice(0, 5).map((c) => c.code).join(", ")}`);
  }
  if (lost.length) {
    console.log(`  !! ${lost.length} LOST a film entirely: ${lost.slice(0, 5).map((c) => c.code).join(", ")}`);
  }

  console.log("\nRead these before pushing. If they are all intended: npm run scan:accept");
  return 1;
}

const code = await main();
// process.exit() straight after Supabase traffic aborts sockets that are still
// closing; on Windows that surfaces as "Assertion failed:
// !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c". Stopping the auth
// refresh timer lets the process end on its own instead of being killed.
try { supabase.auth.stopAutoRefresh(); } catch { /* older client */ }
process.exitCode = code;
