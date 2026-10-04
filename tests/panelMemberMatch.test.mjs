// Which person the XYi panel's member name resolves to (/api/panel/jobs). The
// panel is the Motion team's After Effects tool: when a name matches people in
// several departments, the Motion member wins, whoever edited their profile
// last. A better match (full name over first name) still wins outright.
import worker from "../worker/index.js";

const env = { SUPABASE_URL: "https://sb.test", SUPABASE_SERVICE_ROLE_KEY: "srk", PANEL_KEY: "pk" };
const ctx = { waitUntil: () => {} };
const ok = (body) => new Response(JSON.stringify(body), { status: 200 });

// Newest first, as the worker's query orders them: Luke Steer (Print) was
// updated after Luke Trott (Motion).
const PROFILES = [
  { wrike_user_id: "STEER", first_name: "Luke", last_name: "Steer", department: "Print", updated_at: "2026-10-04T10:00:00Z" },
  { wrike_user_id: "TROTT", first_name: "Luke", last_name: "Trott", department: "Motion", updated_at: "2026-07-10T10:00:00Z" },
  { wrike_user_id: "ADAM_P", first_name: "Adam", last_name: "Parton", department: "Print", updated_at: "2026-10-01T10:00:00Z" },
  { wrike_user_id: "ADAM_T", first_name: "Adam", last_name: "Tansley-Scales", department: "Digital", updated_at: "2026-09-01T10:00:00Z" },
];

async function resolve(member) {
  let asked = null;
  globalThis.fetch = async (url) => {
    url = String(url);
    if (url.includes("/profiles?")) return ok(PROFILES);
    if (url.includes("/wrike_tasks_cache")) {
      asked = decodeURIComponent(url).match(/responsibleIds=cs\.\["([^"]+)"\]/)?.[1] || null;
      return ok([]);
    }
    if (url.includes("sb.test")) return ok([]);
    return ok({ data: [] });
  };
  const res = await worker.fetch(
    new Request(`https://x.test/api/panel/jobs?member=${encodeURIComponent(member)}`, { headers: { "X-Panel-Key": "pk" } }),
    env, ctx
  );
  await res.text();
  return asked;
}

check("panel: 'Luke' is the Motion member even when the other Luke edited later", await resolve("Luke"), "TROTT");
check("panel: a full name still picks that exact person", await resolve("Luke Steer"), "STEER");
check("panel: 'Trott' (surname) resolves", await resolve("Trott"), "TROTT");
check("panel: no Motion member among the matches: newest edit wins, as before", await resolve("Adam"), "ADAM_P");
