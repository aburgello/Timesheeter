// Cloudflare Worker: Wrike OAuth (authorization code flow) + API proxy.
//
// Members never see a Wrike access token. They hit /api/wrike/oauth/start,
// approve on Wrike's site, and land back here. From then on the browser talks
// to /api/wrike/* (this Worker), which attaches the stored token, refreshes it
// when it's about to expire, and forwards the request to the real Wrike API.
//
// Tokens live in Supabase (wrike_oauth_tokens), reachable only with the
// service role key held in this Worker's secrets — RLS blocks the anon/
// authenticated roles the browser client uses entirely.

const WRIKE_AUTHORIZE_URL = "https://login.wrike.com/oauth2/authorize/v4";
const WRIKE_TOKEN_URL = "https://login.wrike.com/oauth2/token";
const SESSION_COOKIE = "wrike_session";
const STATE_COOKIE = "wrike_oauth_state";
const SESSION_MAX_AGE = 60 * 60 * 24 * 180; // 180 days
const STATE_MAX_AGE = 600; // 10 minutes

// A page load fires several /api/wrike/* calls in parallel. If more than one
// happens to see a near-expired/expired access token at once, each would
// independently call Wrike's refresh endpoint with the SAME refresh_token —
// and since Wrike rotates refresh tokens on use, only the first actually
// succeeds; every other concurrent caller's refresh_token is already dead by
// the time it lands, so it gets rejected (token_refresh_failed) even though a
// valid new token now exists in the DB from the winning call. Keyed by
// session_token, so concurrent requests share one in-flight refresh instead
// of racing each other; cleared as soon as that refresh settles either way.
const refreshInFlight = new Map();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isHttps = url.protocol === "https:";

    if (url.pathname === "/api/wrike/oauth/start") {
      return handleOAuthStart(url, env, isHttps);
    }
    if (url.pathname === "/api/wrike/oauth/callback") {
      return handleOAuthCallback(request, url, env, isHttps);
    }
    if (url.pathname === "/api/wrike/oauth/disconnect") {
      return handleDisconnect(request, env);
    }
    if (url.pathname === "/api/wrike/oauth/status") {
      return handleStatus(request, env);
    }
    if (url.pathname === "/api/wrike/webhook/register" && request.method === "POST") {
      return handleWebhookRegister(request, url, env);
    }
    if (url.pathname === "/api/wrike/webhook" && request.method === "POST") {
      return handleWebhookEvent(request, env);
    }
    if (url.pathname.startsWith("/api/wrike/")) {
      return handleProxy(request, url, env);
    }

    return env.ASSETS.fetch(request);
  },
};

// ── Cookie helpers ───────────────────────────────────────────────────────────

function parseCookies(request) {
  const header = request.headers.get("Cookie") || "";
  const out = {};
  for (const pair of header.split(";")) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function setCookie(name, value, { maxAge, path = "/", secure }) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, "HttpOnly", "SameSite=Lax"];
  if (maxAge != null) parts.push(`Max-Age=${maxAge}`);
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function clearCookie(name, path = "/") {
  return `${name}=; Path=${path}; Max-Age=0; HttpOnly; SameSite=Lax`;
}

function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

// ── Supabase (service role) helpers ──────────────────────────────────────────

async function sbFetch(env, path, opts = {}) {
  return fetch(`${env.SUPABASE_URL}/rest/v1${path}`, {
    ...opts,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
}

async function getTokenRowBySession(env, sessionToken) {
  const res = await sbFetch(
    env,
    `/wrike_oauth_tokens?session_token=eq.${encodeURIComponent(sessionToken)}&select=*`
  );
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0] || null;
}

// Keyed by session_token, NOT wrike_user_id — the same Wrike account can be
// connected from several browsers/environments at once (e.g. localhost +
// the deployed site), and each keeps its own row. Keying by wrike_user_id
// used to make every new connect overwrite (upsert) or every disconnect/
// refresh wipe (delete/patch) *every* environment's session sharing that
// account, causing a 401 cascade in whichever one didn't just touch it.
async function upsertTokenRow(env, row) {
  const res = await sbFetch(env, `/wrike_oauth_tokens?on_conflict=session_token`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`Supabase upsert failed: ${res.status} ${await res.text()}`);
  return (await res.json())[0];
}

async function updateTokenRow(env, sessionToken, patch) {
  const res = await sbFetch(env, `/wrike_oauth_tokens?session_token=eq.${encodeURIComponent(sessionToken)}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`Supabase update failed: ${res.status} ${await res.text()}`);
  return (await res.json())[0];
}

async function deleteTokenRow(env, sessionToken) {
  await sbFetch(env, `/wrike_oauth_tokens?session_token=eq.${encodeURIComponent(sessionToken)}`, {
    method: "DELETE",
  });
}

async function getWebhookConfig(env) {
  const res = await sbFetch(env, `/wrike_webhook_config?select=*&limit=1`);
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0] || null;
}

async function upsertWebhookConfig(env, { webhookId, secret }) {
  const res = await sbFetch(env, `/wrike_webhook_config?on_conflict=id`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({ id: true, webhook_id: webhookId, secret }),
  });
  if (!res.ok) throw new Error(`Supabase upsert failed: ${res.status} ${await res.text()}`);
  return (await res.json())[0];
}

async function insertWebhookEvent(env, { taskId, eventType, occurredAt }) {
  const res = await sbFetch(env, `/wrike_webhook_events`, {
    method: "POST",
    // return=minimal: this is a fire-and-forget insert, we don't need the row
    // echoed back — asking for the representation just adds a SELECT that can
    // fail on its own.
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ task_id: taskId, event_type: eventType, occurred_at: occurredAt }),
  });
  if (!res.ok) {
    console.error(`[webhook] insert failed ${res.status}:`, await res.text().catch(() => ""));
  }
  return res;
}

// ── HMAC helpers (Wrike webhook signature verification) ─────────────────────

async function hmacSha256Hex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ── Wrike OAuth helpers ───────────────────────────────────────────────────────

async function exchangeCodeForToken(env, code, redirectUri) {
  const body = new URLSearchParams({
    client_id: env.WRIKE_CLIENT_ID,
    client_secret: env.WRIKE_CLIENT_SECRET,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });
  const res = await fetch(WRIKE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Wrike token exchange failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function refreshAccessToken(env, refreshToken) {
  const body = new URLSearchParams({
    client_id: env.WRIKE_CLIENT_ID,
    client_secret: env.WRIKE_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const res = await fetch(WRIKE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Wrike token refresh failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// ── Route handlers ───────────────────────────────────────────────────────────

async function handleOAuthStart(url, env, isHttps) {
  const state = crypto.randomUUID();
  const redirectUri = `${url.origin}/api/wrike/oauth/callback`;

  const authorizeUrl = new URL(WRIKE_AUTHORIZE_URL);
  authorizeUrl.searchParams.set("client_id", env.WRIKE_CLIENT_ID);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("state", state);

  const headers = new Headers({ Location: authorizeUrl.toString() });
  headers.append(
    "Set-Cookie",
    setCookie(STATE_COOKIE, state, { maxAge: STATE_MAX_AGE, path: "/api/wrike/oauth", secure: isHttps })
  );
  return new Response(null, { status: 302, headers });
}

async function handleOAuthCallback(request, url, env, isHttps) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const cookies = parseCookies(request);

  const fail = (reason) => Response.redirect(`${url.origin}/?wrike_error=${encodeURIComponent(reason)}`, 302);

  if (error) return fail(error);
  if (!code || !state || state !== cookies[STATE_COOKIE]) return fail("invalid_state");

  const redirectUri = `${url.origin}/api/wrike/oauth/callback`;

  let tokenData;
  try {
    tokenData = await exchangeCodeForToken(env, code, redirectUri);
  } catch (err) {
    console.error(err);
    return fail("token_exchange_failed");
  }

  const apiHost = tokenData.host || "www.wrike.com";
  const meRes = await fetch(`https://${apiHost}/api/v4/contacts?me=true`, {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  if (!meRes.ok) return fail("profile_fetch_failed");
  const me = (await meRes.json()).data?.[0];
  if (!me) return fail("no_profile");

  const sessionToken = crypto.randomUUID() + crypto.randomUUID();
  const expiresAt = new Date(Date.now() + Number(tokenData.expires_in || 3600) * 1000).toISOString();

  await upsertTokenRow(env, {
    wrike_user_id: me.id,
    session_token: sessionToken,
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    api_host: apiHost,
    expires_at: expiresAt,
    updated_at: new Date().toISOString(),
  });

  const params = new URLSearchParams({
    wrike_connected: "1",
    wrike_user_id: me.id,
    first_name: me.firstName || "",
    last_name: me.lastName || "",
    email: me.profiles?.[0]?.email || "",
    avatar_url: me.avatarUrl || "",
  });

  const headers = new Headers({ Location: `${url.origin}/?${params.toString()}` });
  headers.append(
    "Set-Cookie",
    setCookie(SESSION_COOKIE, sessionToken, { maxAge: SESSION_MAX_AGE, path: "/", secure: isHttps })
  );
  headers.append("Set-Cookie", clearCookie(STATE_COOKIE, "/api/wrike/oauth"));
  return new Response(null, { status: 302, headers });
}

async function handleDisconnect(request, env) {
  const cookies = parseCookies(request);
  const session = cookies[SESSION_COOKIE];
  if (session) {
    const row = await getTokenRowBySession(env, session);
    if (row) await deleteTokenRow(env, row.session_token);
  }
  const res = json({ ok: true });
  res.headers.append("Set-Cookie", clearCookie(SESSION_COOKIE, "/"));
  return res;
}

async function handleStatus(request, env) {
  const cookies = parseCookies(request);
  const session = cookies[SESSION_COOKIE];
  if (!session) return json({ connected: false });
  const row = await getTokenRowBySession(env, session);
  return json({ connected: !!row, wrikeUserId: row?.wrike_user_id || null });
}

// One-time admin action: register an account-wide Wrike webhook pointed at
// this Worker's /api/wrike/webhook endpoint. Any connected user's token
// works — the webhook fires for the whole account regardless of who
// registered it.
async function handleWebhookRegister(request, url, env) {
  const cookies = parseCookies(request);
  const session = cookies[SESSION_COOKIE];
  if (!session) return json({ error: "not_connected" }, { status: 401 });

  const row = await getTokenRowBySession(env, session);
  if (!row) return json({ error: "not_connected" }, { status: 401 });

  // Wrike validates hookUrl synchronously by calling back to it during
  // creation — a localhost/private-network origin can never be reached from
  // Wrike's servers, so this can never succeed from a dev environment. Reject
  // it up front with a clear reason instead of a generic 502 after Wrike
  // rejects it (which — see below — used to also corrupt the shared config).
  if (["localhost", "127.0.0.1", "0.0.0.0"].includes(url.hostname) || url.hostname.endsWith(".local")) {
    return json({
      error: "unreachable_origin",
      detail: "Live sync must be enabled from the deployed site — Wrike can't reach a localhost URL to deliver webhooks.",
    }, { status: 400 });
  }

  const hookUrl = `${url.origin}/api/wrike/webhook`;
  const authHeader = { Authorization: `Bearer ${row.access_token}` };

  // Preserve whatever config is live right now. If Wrike rejects the new
  // webhook below, we restore this instead of leaving the shared config
  // half-written — a blank webhookId plus a secret that no longer matches
  // whatever webhook Wrike is still actually delivering with, which silently
  // 401s (and drops) every future delivery until someone notices the outage.
  const previousConfig = await getWebhookConfig(env);

  // Delete any webhooks already pointing at this Worker before creating a new
  // one. Each register generates a fresh secret, but wrike_webhook_config can
  // only hold one — so every previously-created webhook keeps firing signed
  // with a secret we no longer have, failing signature verification (401) and
  // inserting nothing while a valid delivery hides among the rejects. Clearing
  // them first guarantees exactly one live webhook whose secret matches config.
  try {
    const listRes = await fetch(`https://${row.api_host}/api/v4/webhooks`, { headers: authHeader });
    if (listRes.ok) {
      const existing = (await listRes.json()).data || [];
      await Promise.all(
        existing
          .filter((w) => w.hookUrl === hookUrl)
          .map((w) =>
            fetch(`https://${row.api_host}/api/v4/webhooks/${w.id}`, { method: "DELETE", headers: authHeader })
              .catch((err) => console.error("webhook delete failed", w.id, err))
          )
      );
    }
  } catch (err) {
    console.error("webhook cleanup failed (continuing to create)", err);
  }

  const secret = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");

  // Wrike validates hookUrl synchronously as part of webhook creation — it
  // calls back to /api/wrike/webhook and expects a signed handshake response
  // before the create call returns, so the secret must already be saved.
  await upsertWebhookConfig(env, { webhookId: "", secret });

  const body = new URLSearchParams({ hookUrl, secret });
  const res = await fetch(`https://${row.api_host}/api/v4/webhooks`, {
    method: "POST",
    headers: { ...authHeader, "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error("wrike webhook create failed", res.status, text);
    if (previousConfig) {
      await upsertWebhookConfig(env, { webhookId: previousConfig.webhook_id, secret: previousConfig.secret });
    }
    return json({ error: "wrike_webhook_create_failed", detail: text }, { status: 502 });
  }
  const data = await res.json();
  const webhookId = data.data?.[0]?.id;
  if (!webhookId) {
    if (previousConfig) {
      await upsertWebhookConfig(env, { webhookId: previousConfig.webhook_id, secret: previousConfig.secret });
    }
    return json({ error: "no_webhook_id_returned" }, { status: 502 });
  }

  await upsertWebhookConfig(env, { webhookId, secret });
  return json({ ok: true, webhookId });
}

// Public endpoint Wrike calls directly (no session cookie). Handles both the
// one-time secret-verification challenge Wrike sends when validating hookUrl
// and real event deliveries. Per developers.wrike.com/webhooks, BOTH request
// types carry X-Hook-Secret and X-Hook-Signature — header presence can't
// distinguish them (a routing mistake this code made twice before landing
// here). The real discriminator is the body: the verification challenge is
// {"requestType":"WebHook secret verification"}; real deliveries are a JSON
// array of event objects. Both are signature-verified the same way first.
async function handleWebhookEvent(request, env) {
  const config = await getWebhookConfig(env);
  if (!config) return json({ error: "webhook_not_configured" }, { status: 404 });

  const rawBody = await request.text();
  const signatureHeader = request.headers.get("X-Hook-Signature") || "";

  const expectedBodySignature = await hmacSha256Hex(config.secret, rawBody);
  if (!timingSafeEqual(signatureHeader, expectedBodySignature)) {
    // Signature mismatch — not from Wrike. Discard per Wrike's docs.
    console.error("[webhook] invalid signature — dropping delivery");
    return json({ error: "invalid_signature" }, { status: 401 });
  }

  let parsedBody;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    return json({ error: "invalid_body" }, { status: 400 });
  }

  if (parsedBody && !Array.isArray(parsedBody) && parsedBody.requestType === "WebHook secret verification") {
    const hookSecretHeader = request.headers.get("X-Hook-Secret");
    if (!hookSecretHeader) return json({ error: "missing_hook_secret" }, { status: 400 });
    // Prove we know the secret by signing the challenge Wrike sent us and
    // echoing it back in the *same* header name (X-Hook-Secret).
    const responseSignature = await hmacSha256Hex(config.secret, hookSecretHeader);
    return new Response(null, { status: 200, headers: { "X-Hook-Secret": responseSignature } });
  }

  let events = Array.isArray(parsedBody) ? parsedBody : [parsedBody];
  for (const evt of events) {
    if (!evt?.taskId) continue; // ignore folder/comment/attachment-only events
    await insertWebhookEvent(env, {
      taskId: evt.taskId,
      eventType: evt.eventType || null,
      occurredAt: evt.lastUpdatedDate || new Date().toISOString(),
    });
  }

  return json({ ok: true });
}

async function handleProxy(request, url, env) {
  const cookies = parseCookies(request);
  const session = cookies[SESSION_COOKIE];
  if (!session) return json({ error: "not_connected" }, { status: 401 });

  let row = await getTokenRowBySession(env, session);
  if (!row) return json({ error: "not_connected" }, { status: 401 });

  const restPath = url.pathname.replace(/^\/api\/wrike/, "");

  // Buffer any request body once — a request stream can only be read a single
  // time, and we may need to replay the call after a token refresh below.
  const bodyBuffer = ["GET", "HEAD"].includes(request.method)
    ? undefined
    : await request.arrayBuffer();

  const callWrike = () => {
    const fwdHeaders = new Headers(request.headers);
    fwdHeaders.delete("Cookie");
    fwdHeaders.delete("Host");
    fwdHeaders.set("Authorization", `Bearer ${row.access_token}`);
    const init = { method: request.method, headers: fwdHeaders };
    if (bodyBuffer !== undefined) init.body = bodyBuffer;
    return fetch(`https://${row.api_host}/api/v4${restPath}${url.search}`, init);
  };

  const refreshToken = async () => {
    const key = row.session_token;
    if (!refreshInFlight.has(key)) {
      refreshInFlight.set(
        key,
        (async () => {
          try {
            const refreshed = await refreshAccessToken(env, row.refresh_token);
            return await updateTokenRow(env, key, {
              access_token: refreshed.access_token,
              refresh_token: refreshed.refresh_token || row.refresh_token,
              api_host: refreshed.host || row.api_host,
              expires_at: new Date(Date.now() + Number(refreshed.expires_in || 3600) * 1000).toISOString(),
              updated_at: new Date().toISOString(),
            });
          } finally {
            refreshInFlight.delete(key);
          }
        })()
      );
    }
    // Every concurrent caller — the one that started this refresh and any
    // that arrived while it was in flight — awaits the SAME promise and gets
    // the SAME resulting row, instead of each spending its own (possibly
    // already-rotated-out) refresh_token.
    row = await refreshInFlight.get(key);
  };

  // Proactive refresh when the token is about to expire by the clock.
  if (new Date(row.expires_at).getTime() - Date.now() < 60_000) {
    try {
      await refreshToken();
    } catch (err) {
      console.error(err);
      return json({ error: "token_refresh_failed" }, { status: 401 });
    }
  }

  let wrikeRes = await callWrike();

  // Reactive refresh: Wrike can invalidate a token *before* its clock-expiry
  // (the user re-auths elsewhere, a webhook re-registration rotates it). A 401
  // means the stored access token is dead even though we thought it valid —
  // refresh once and retry, so a single prematurely-invalidated token doesn't
  // 401 every call until it happens to reach its expiry timestamp. If the
  // refresh token itself is dead, the retry 401s too and the user must re-auth.
  if (wrikeRes.status === 401) {
    try {
      await refreshToken();
      wrikeRes = await callWrike();
    } catch (err) {
      console.error("[proxy] refresh-on-401 failed", err);
    }
  }

  if (!wrikeRes.ok) {
    // The proxy used to pass failures through silently — every "why did this
    // one request 400" investigation needed a browser Network-tab screenshot
    // because wrangler tail showed nothing. Log Wrike's actual error body so
    // future failures are visible from the Worker side too.
    const text = await wrikeRes.text().catch(() => "");
    console.error(`[proxy] Wrike ${wrikeRes.status} on ${request.method} ${restPath}${url.search}:`, text);
    const resHeaders = new Headers(wrikeRes.headers);
    resHeaders.delete("Set-Cookie");
    return new Response(text, { status: wrikeRes.status, headers: resHeaders });
  }

  const resHeaders = new Headers(wrikeRes.headers);
  resHeaders.delete("Set-Cookie");
  return new Response(wrikeRes.body, { status: wrikeRes.status, headers: resHeaders });
}
