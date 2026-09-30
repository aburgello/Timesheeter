// Guards /api/panel/comment: a job's latest Wrike comment for the XYi panel,
// where amends are written per deliverable on the PARENT task (2026-09-30).
// One Wrike call, cached; the id is validated before it reaches a Wrike URL;
// plain text only; the author comes from profiles, not a second Wrike call.
import worker from "../worker/index.js";

const env = { SUPABASE_URL: "https://sb.test", SUPABASE_SERVICE_ROLE_KEY: "srk", PANEL_KEY: "pk" };
const ctx = { waitUntil: () => {} };
const later = () => new Date(Date.now() + 3_600_000).toISOString();
const ok = (body) => new Response(JSON.stringify(body), { status: 200 });

const AMENDS = "SF_INTL_Trio_POST_DOOH_1920x1080px_30s_NO_V01.mov<br>SF_INTL_Trio_DOOH_NfkinoPOST_1728x768px_30s_NO_V01.mov<br>🔶 The paramount logo is cut off at the top<br><br>✅ The others are approved &amp; done";
let wrikeCalls = [];
let comments = [];
globalThis.fetch = async (url) => {
  url = String(url);
  if (url.includes("/wrike_oauth_tokens")) return ok([{ api_host: "www.wrike.com", access_token: "t", expires_at: later() }]);
  if (url.includes("/profiles?") && url.includes("wrike_user_id=eq.MS1")) return ok([{ first_name: "Michael", last_name: "Sills" }]);
  if (url.includes("/profiles?")) return ok([]);
  if (url.includes("/api/v4/tasks/") && url.includes("/comments")) { wrikeCalls.push(url); return ok({ data: comments }); }
  if (url.includes("/api/v4/")) { wrikeCalls.push(url); return ok({ data: [] }); }
  throw new Error(`unexpected fetch: ${url}`);
};
const ask = (qs, key = "pk") => worker.fetch(new Request(`https://th.test/api/panel/comment?${qs}`, { headers: { "X-Panel-Key": key } }), env, ctx);

check("comment: wrong key is refused", (await ask("task=IEAAAAAA", "nope")).status, 401);
check("comment: an id that isn't a Wrike id never reaches Wrike", [(await ask("task=../../contacts")).status, wrikeCalls.length], [400, 0]);

comments = [
  { id: "c1", authorId: "AB1", text: "Changed the date", createdDate: "2026-09-30T10:28:00Z" },
  { id: "c2", authorId: "MS1", text: AMENDS, createdDate: "2026-09-30T11:45:00Z" },
  { id: "c3", authorId: "JC1", text: "   ", createdDate: "2026-09-30T11:50:00Z" },
];
const r1 = await (await ask("task=IEAAJOBNO2")).json();
check("comment: the latest comment WITH text is the one returned", r1.comment && r1.comment.date, "2026-09-30T11:45:00Z");
check("comment: named from profiles, not a second Wrike call", [r1.comment.author, wrikeCalls.length], ["Michael Sills", 1]);
check("comment: plain text, one line per line, entities decoded", r1.comment.text.split("\n"),
  ["SF_INTL_Trio_POST_DOOH_1920x1080px_30s_NO_V01.mov", "SF_INTL_Trio_DOOH_NfkinoPOST_1728x768px_30s_NO_V01.mov", "🔶 The paramount logo is cut off at the top", "", "✅ The others are approved & done"]);
await ask("task=IEAAJOBNO2");
check("comment: asking again within the TTL costs Wrike nothing", wrikeCalls.length, 1);
await ask("task=IEAAJOBNO2&fresh=1");
check("comment: fresh=1 (the refresh button) goes to Wrike", wrikeCalls.length, 2);
comments = [];
const r2 = await (await ask("task=IEAANOCOMM")).json();
check("comment: no comments is an answer, not an error", [r2.comment, r2.count], [null, 0]);
