// Guards the rule that a database problem must never present as a Wrike
// sign-out.
//
// Two separate failures on 2026-08-28 came from breaking it:
//   - getTokenRowBySession returned null both for "no such session" and for
//     "couldn't reach Supabase", so a stalled read logged people out on paper.
//   - a refresh persisted through a stalled write lost credentials Wrike had
//     already rotated to, which logs them out for real — permanently.
import worker from "../worker/index.js";

const env = { SUPABASE_URL: "https://sb.test", SUPABASE_SERVICE_ROLE_KEY: "srk" };
const ctx = { waitUntil: () => {} };

const soon = () => new Date(Date.now() + 30_000).toISOString();   // triggers refresh
const later = () => new Date(Date.now() + 3_600_000).toISOString(); // does not

// Each test uses its own session token: the worker keeps module-level state
// (in-flight refreshes, held credentials) keyed by it.
function scenario({ tokenRead, patch, wrikeToken, wrikeApi }) {
  globalThis.fetch = async (url, opts = {}) => {
    if (url.includes("/wrike_oauth_tokens")) {
      if ((opts.method || "GET") === "GET") return tokenRead();
      if (opts.method === "PATCH") return patch(JSON.parse(opts.body));
    }
    if (url.includes("login.wrike.com")) return wrikeToken();
    if (url.includes("/api/v4/")) return wrikeApi(opts);
    throw new Error(`unexpected fetch: ${url}`);
  };
}

const rowFor = (session, expires, refresh = "rt-old") => new Response(JSON.stringify([{
  session_token: session, wrike_user_id: "U1", api_host: "www.wrike.com",
  access_token: "at-old", refresh_token: refresh, expires_at: expires,
}]), { status: 200 });

const call = (session, path = "/api/wrike/tasks") => worker.fetch(
  new Request(`https://x.test${path}`, { headers: { Cookie: `wrike_session=${session}` } }),
  env, ctx
);

// 1. The phantom sign-out: the token read fails, the session is fine.
{
  scenario({
    tokenRead: () => { throw new Error("network down"); },
    patch: () => new Response("", { status: 200 }),
    wrikeToken: () => new Response("{}", { status: 200 }),
    wrikeApi: () => new Response("{}", { status: 200 }),
  });
  const res = await call("s1");
  check("an unreachable database is 503, not a 401 sign-out", res.status, 503);
  const status = await worker.fetch(
    new Request("https://x.test/api/wrike/oauth/status", { headers: { Cookie: "wrike_session=s1" } }),
    env, ctx
  );
  check("status says 'couldn't check' rather than 'not connected'", status.status, 503);
  check("...and never claims connected:false", (await status.json()).connected, undefined);
}

// 2. A session that genuinely doesn't exist must still read as disconnected.
{
  scenario({
    tokenRead: () => new Response("[]", { status: 200 }),
    patch: () => new Response("", { status: 200 }),
    wrikeToken: () => new Response("{}", { status: 200 }),
    wrikeApi: () => new Response("{}", { status: 200 }),
  });
  const res = await call("s2");
  check("a genuinely unknown session is still 401", res.status, 401);
  check("...with not_connected", (await res.json()).error, "not_connected");
}

// 3. Wrike rotates, the save fails. Wrike has already killed the old refresh
//    token, so losing this is unrecoverable — the request must still succeed on
//    the new credentials, and the write must be retried until it lands.
{
  let patchAttempts = 0;
  let authSeen = null;
  scenario({
    tokenRead: () => rowFor("s3", soon()),
    patch: () => {
      patchAttempts++;
      if (patchAttempts === 1) throw new Error("database stalled");
      return new Response(JSON.stringify([{ session_token: "s3", access_token: "at-new" }]), { status: 200 });
    },
    wrikeToken: () => new Response(JSON.stringify({
      access_token: "at-new", refresh_token: "rt-new", expires_in: 3600, host: "www.wrike.com",
    }), { status: 200 }),
    wrikeApi: (opts) => {
      authSeen = new Headers(opts.headers).get("Authorization");
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    },
  });

  const pending = [];
  const res = await worker.fetch(
    new Request("https://x.test/api/wrike/tasks", { headers: { Cookie: "wrike_session=s3" } }),
    env, { waitUntil: (p) => pending.push(p) }
  );
  check("a failed token save does not fail the request", res.status, 200);
  check("...and the call uses the newly minted token", authSeen, "Bearer at-new");
  check("...and the save was attempted", patchAttempts, 1);

  await Promise.all(pending); // the background retry
  check("...and the retry eventually persists it", patchAttempts >= 2, true);
}

// 3b. A wedged read must be retried, not surfaced as 503. During the stalls the
//     median read stayed ~20ms while a few hung for minutes, so asking again is
//     almost always answered at once.
{
  let reads = 0;
  scenario({
    tokenRead: () => {
      reads++;
      if (reads === 1) throw new Error("connection wedged");
      return rowFor("s3b", later());
    },
    patch: () => new Response("", { status: 200 }),
    wrikeToken: () => new Response("{}", { status: 200 }),
    wrikeApi: () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
  });
  const res = await call("s3b");
  check("a wedged read is retried rather than returned as 503", res.status, 200);
  check("...and it took a second attempt to get there", reads, 2);
}

// 3c. Persistently unreachable still gives up, rather than retrying forever.
{
  let reads = 0;
  scenario({
    tokenRead: () => { reads++; throw new Error("still down"); },
    patch: () => new Response("", { status: 200 }),
    wrikeToken: () => new Response("{}", { status: 200 }),
    wrikeApi: () => new Response("{}", { status: 200 }),
  });
  const res = await call("s3c");
  check("a database that stays down is 503", res.status, 503);
  check("...after a bounded number of attempts", reads, 3);
}

// 4. Wrike rejecting the refresh token is a real sign-out and must stay one.
{
  scenario({
    tokenRead: () => rowFor("s4", soon()),
    patch: () => new Response("", { status: 200 }),
    wrikeToken: () => new Response('{"error":"invalid_grant"}', { status: 400 }),
    wrikeApi: () => new Response("{}", { status: 200 }),
  });
  const res = await call("s4");
  check("Wrike rejecting the credentials is a genuine 401", res.status, 401);
  check("...with token_refresh_failed", (await res.json()).error, "token_refresh_failed");
}

// 5. Wrike having a bad moment is not a sign-out.
{
  scenario({
    tokenRead: () => rowFor("s5", soon()),
    patch: () => new Response("", { status: 200 }),
    wrikeToken: () => new Response("upstream boom", { status: 503 }),
    wrikeApi: () => new Response("{}", { status: 200 }),
  });
  const res = await call("s5");
  check("a Wrike 5xx during refresh is 503, not a sign-out", res.status, 503);
}

// 6. The ordinary path stays ordinary: valid token, no refresh, straight through.
{
  let refreshCalled = false;
  scenario({
    tokenRead: () => rowFor("s6", later()),
    patch: () => new Response("", { status: 200 }),
    wrikeToken: () => { refreshCalled = true; return new Response("{}", { status: 200 }); },
    wrikeApi: () => new Response(JSON.stringify({ data: [1] }), { status: 200 }),
  });
  const res = await call("s6");
  check("a healthy session passes through", res.status, 200);
  check("...without refreshing a token that isn't due", refreshCalled, false);
}

// 7. Signing out is local: clearing the cookie ends the session, so it must not
//    wait on the database. It used to read the row before deleting it, which
//    made Disconnect hang for as long as a stalled read took.
{
  let reads = 0;
  let deletes = 0;
  globalThis.fetch = async (url, opts = {}) => {
    if (url.includes("/wrike_oauth_tokens")) {
      if ((opts.method || "GET") === "GET") { reads++; return new Response("[]", { status: 200 }); }
      if (opts.method === "DELETE") {
        deletes++;
        if (deletes === 1) throw new Error("database stalled");
        return new Response("", { status: 200 });
      }
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const pending = [];
  const res = await worker.fetch(
    new Request("https://x.test/api/wrike/oauth/disconnect", {
      method: "POST", headers: { Cookie: "wrike_session=s7" },
    }),
    env, { waitUntil: (p) => pending.push(p) }
  );

  check("disconnect answers without waiting on the database", res.status, 200);
  check("...and never reads the row it doesn't need", reads, 0);
  check("...and clears the session cookie", /wrike_session=;|wrike_session=\s*;/.test(res.headers.get("Set-Cookie") || ""), true);

  await Promise.all(pending);
  check("...and still removes the stored token, retrying if needed", deletes >= 2, true);
}
