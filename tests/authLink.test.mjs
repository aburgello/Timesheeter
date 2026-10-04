// /api/auth/link records the Wrike id from the caller's Wrike login on their
// Supabase account. The id must come from the token row, never the request.
import worker from "../worker/index.js";

const env = { SUPABASE_URL: "https://sb.test", SUPABASE_SERVICE_ROLE_KEY: "srk" };
const ctx = { waitUntil: () => {} };

function scenario({ row = { wrike_user_id: "W1" }, user = { id: "u1", app_metadata: {} }, userStatus = 200, updateStatus = 200 } = {}) {
  const calls = { updates: [] };
  globalThis.fetch = async (url, opts = {}) => {
    if (url.includes("/wrike_oauth_tokens")) {
      return new Response(JSON.stringify(row ? [{ session_token: "s", ...row }] : []), { status: 200 });
    }
    if (url.endsWith("/auth/v1/user")) {
      calls.userAuth = opts.headers.Authorization;
      return new Response(JSON.stringify(user), { status: userStatus });
    }
    if (url.includes("/auth/v1/admin/users/")) {
      calls.updates.push({ url, auth: opts.headers.Authorization, body: JSON.parse(opts.body) });
      return new Response("{}", { status: updateStatus });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  return calls;
}

const call = ({ cookie = "wrike_session=s", bearer = "jwt", body } = {}) => {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  return worker.fetch(
    new Request("https://x.test/api/auth/link", { method: "POST", headers, body }),
    env, ctx
  );
};

{
  const calls = scenario();
  const res = await call({ body: JSON.stringify({ wrike_user_id: "SOMEONE_ELSE" }) });
  const out = await res.json();
  check("link: stamps the id from the Wrike login", calls.updates[0]?.body, { app_metadata: { wrike_user_id: "W1" } });
  check("link: updates the caller's own account", calls.updates[0]?.url, "https://sb.test/auth/v1/admin/users/u1");
  check("link: the account is looked up with the caller's token", calls.userAuth, "Bearer jwt");
  check("link: reports linked", out, { ok: true, linked: true, wrikeUserId: "W1" });
}
{
  const calls = scenario({ user: { id: "u1", app_metadata: { provider: "anonymous", wrike_user_id: "W1" } } });
  const out = await (await call()).json();
  check("link: already linked makes no update", calls.updates.length, 0);
  check("link: ...and says so", out.linked, false);
}
{
  scenario();
  check("link: no Wrike session is 401", (await call({ cookie: null })).status, 401);
  check("link: no Supabase token is 401", (await call({ bearer: null })).status, 401);
}
{
  const calls = scenario({ row: null });
  check("link: unknown Wrike session is 401", (await call()).status, 401);
  check("link: ...and updates nothing", calls.updates.length, 0);
}
{
  const calls = scenario({ userStatus: 401 });
  check("link: a bad Supabase token is 401", (await call()).status, 401);
  check("link: ...and updates nothing", calls.updates.length, 0);
}
{
  scenario({ updateStatus: 500 });
  check("link: a failed update is reported", (await call()).status, 502);
}
{
  scenario();
  const res = await worker.fetch(new Request("https://x.test/api/auth/link", { headers: { Cookie: "wrike_session=s" } }), { ...env, ASSETS: { fetch: () => new Response("asset") } }, ctx);
  check("link: GET is not routed to the endpoint", await res.text(), "asset");
}
