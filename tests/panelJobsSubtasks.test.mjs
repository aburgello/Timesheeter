// Guards the XYi panel's subtask names (/api/panel/jobs).
//
// On 2026-09-24 the panel showed SF Motion Outdoor ID with one row where
// TimeHub's own task modal showed five subtasks. Two causes, both here:
//   - the feed read names only from wrike_tasks_cache, which had never seen
//     four of them, while TimeHub's modal reads subtasks live from Wrike;
//   - its live fallback asked Wrike's get-tasks-BY-ID endpoint with fields=,
//     which that endpoint refuses (400 "Fields parameter value 'subTaskIds'
//     not allowed" -- see useWrikeCache.js), so a refresh reported
//     "live returned 0 of 13" and filled nothing.
import worker from "../worker/index.js";

const env = { SUPABASE_URL: "https://sb.test", SUPABASE_SERVICE_ROLE_KEY: "srk", PANEL_KEY: "pk" };
const ctx = { waitUntil: () => {} };
const today = new Date(new Date().setHours(12, 0, 0, 0)).toISOString();
const later = () => new Date(Date.now() + 3_600_000).toISOString();

const parent = {
  id: "P1",
  task_data: {
    title: "SF Motion Outdoor ID", status: "Active", dueDate: today,
    responsibleIds: ["U1"], superTaskIds: [], subTaskIds: ["a", "b", "c", "d", "e"],
  },
};
const NAMES = {
  a: "SF_INTL_Trio_DOOH_MRTLCD_1080x1920px_15s_ID",
  b: "SF_INTL_Trio_DFOH_CGVPillarLEDPOST_1680x840px_10s_ID",
  c: "SF_INTL_Trio_DFOH_CGVPillarLED_1680x840px_10s_ID",
  d: "SF_INTL_Trio_DFOH_CGVPillarLED_2288x4160px_10s_ID",
  e: "SF_INTL_Trio_DFOH_CGVPillarLEDPOST_2288x4160px_10s_ID",
};
const ok = (body) => new Response(JSON.stringify(body), { status: 200 });

// `cached`: the subtask ids wrike_tasks_cache can name.
function scenario(cached) {
  const wrikeCalls = [];
  globalThis.fetch = async (url) => {
    url = String(url);
    if (url.includes("/profiles?")) return ok([{ wrike_user_id: "U1", first_name: "Antonio", last_name: "B", updated_at: today }]);
    if (url.includes("/wrike_oauth_tokens")) return ok([{ api_host: "www.wrike.com", access_token: "t", expires_at: later() }]);
    if (url.includes("/wrike_tasks_cache") && url.includes("id=in.(")) {
      return ok(cached.map((id) => ({ id, task_data: { title: NAMES[id], status: "Active" } })));
    }
    if (url.includes("/wrike_tasks_cache")) return ok([parent]);
    if (url.includes("/api/v4/tasks/")) {
      wrikeCalls.push(url);
      // Wrike's by-id endpoint refuses fields= naming default fields.
      if (url.includes("fields=")) return new Response('{"error":"invalid_parameter"}', { status: 400 });
      const ids = url.split("/api/v4/tasks/")[1].split("?")[0].split(",");
      return ok({ data: ids.map((id) => ({ id, title: NAMES[id], status: "Active" })) });
    }
    // The LIST endpoint (a refresh's live read of the team's tasks) takes
    // fields= legitimately, and returns the parent as Wrike shapes it.
    if (url.includes("/api/v4/tasks?")) {
      wrikeCalls.push(url);
      return ok({ data: [{ ...parent.task_data, id: "P1", dueDate: undefined, dates: { due: today } }] });
    }
    if (url.includes("/api/v4/")) return ok({ data: [] });
    if (url.includes("sb.test")) return ok([]);
    throw new Error(`unexpected fetch: ${url}`);
  };
  return wrikeCalls;
}

const call = (qs = "") => worker.fetch(
  new Request(`https://x.test/api/panel/jobs?member=Antonio${qs}`, { headers: { "X-Panel-Key": "pk" } }),
  env, ctx
);
const namesOf = async (res) => {
  const jobs = await res.json();
  const job = (Array.isArray(jobs) ? jobs : []).find((j) => j.title === "SF Motion Outdoor ID");
  return job ? job.subtasks.map((s) => s.name) : null;
};

// 1. The real case: the cache names one of five.
{
  const wrikeCalls = scenario(["a"]);
  const names = await namesOf(await call());
  check("a subtask the cache never saw is named from Wrike", names, [NAMES.a, NAMES.b, NAMES.c, NAMES.d, NAMES.e]);
  check("only the four missing ids are asked for", wrikeCalls.map((u) => u.split("/api/v4/tasks/")[1].split("?")[0]), ["b,c,d,e"]);
  check("and never with fields= (Wrike's by-id endpoint 400s on it)", wrikeCalls.some((u) => u.includes("fields=")), false);
}

// 2. Everything cached: an ordinary load makes no Wrike call at all.
{
  const wrikeCalls = scenario(["a", "b", "c", "d", "e"]);
  const names = await namesOf(await call());
  check("a fully cached job needs no Wrike call", wrikeCalls.length, 0);
  check("...and is named from the cache", names, [NAMES.a, NAMES.b, NAMES.c, NAMES.d, NAMES.e]);
}

// 3. The debug view reports a healthy live read, not "0 of N".
{
  scenario(["a"]);
  const dbg = await (await call("&debug=1")).json();
  check("debug: no live error", dbg.subLiveError, null);
  check("debug: no names missing", dbg.subtaskNamesMissing, 0);
}

// 4. A refresh: the live by-id read of ALL the subtasks must succeed. It sent
// fields= and every chunk 400'd -- "live returned 0 of 13".
{
  const wrikeCalls = scenario(["a"]);
  const names = await namesOf(await call("&refresh=1"));
  check("refresh: every subtask named live", names, [NAMES.a, NAMES.b, NAMES.c, NAMES.d, NAMES.e]);
  const byId = wrikeCalls.filter((u) => u.includes("/api/v4/tasks/"));
  check("refresh: the by-id read carries no fields=", byId.some((u) => u.includes("fields=")), false);
}
