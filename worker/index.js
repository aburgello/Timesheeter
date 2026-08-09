import { isBoardTask, isStale } from "../src/lib/jobFilter";
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
    if (url.pathname === "/api/jobs-feed") {
      return handleJobsFeed(request, env);
    }
    if (url.pathname === "/api/jobs-feed/import" && request.method === "POST") {
      return handleJobsFeedImport(request, env);
    }
    // Read-only feed for the XYi Toolbox CEP panel. Own route, not a reuse of
    // /api/jobs-feed: that one is the TIMESHEET table and gates on a browser
    // session cookie, neither of which suits a panel whose origin is `null`.
    if (url.pathname === "/api/panel/jobs") {
      if (request.method === "OPTIONS") return panelPreflight();
      return handlePanelJobs(request, url, env);
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

// ── Admin Jobs Feed (all users' time) ────────────────────────────────────────
// The tasks table has a per-user RLS policy (wrike_user_isolation), so a browser
// read only ever returns the caller's own rows. The Administration Jobs Feed is
// a management view that must show everyone's time, so it reads through here:
// service-role query bypasses RLS server-side. Gated on a valid Wrike session so
// only a connected member can call it (jobs/profiles are already world-readable
// to authenticated users, so only tasks needs this).
async function handleJobsFeed(request, env) {
  const cookies = parseCookies(request);
  const session = cookies[SESSION_COOKIE];
  if (!session) return json({ error: "not_connected" }, { status: 401 });
  const row = await getTokenRowBySession(env, session);
  if (!row) return json({ error: "not_connected" }, { status: 401 });

  // Limit raised alongside the CSV importer: a bulk load of historical time
  // can push the table well past the old 5000 cap, and a silently truncated
  // feed reads as "those hours were never imported".
  const res = await sbFetch(env, "/tasks?select=*&order=id.desc&limit=20000");
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error(`[jobs-feed] tasks query ${res.status}:`, detail);
    return json({ error: "query_failed" }, { status: 502 });
  }
  const data = await res.json();
  return json(data);
}

// ── Jobs Feed import ─────────────────────────────────────────────────────────
// Bulk-load timesheet rows from a CSV shaped like the feed's own export.
//
// Server-side for the same reason the read is: `tasks` carries a per-user RLS
// policy, so a browser insert can only ever write the caller's own rows — and
// an import file covers the whole team. The service-role write bypasses that,
// so this is gated on a valid Wrike session like the read.
//
// Runs in two passes. `dryRun` classifies every row and returns the plan
// without writing; the same request without it applies exactly that plan. The
// UI always previews first — same plan/apply contract the Wrike write layer
// uses (see src/lib/wrikeCampaign.js).

const IMPORT_MAX_ROWS = 5000;
const EMOJI_RE = /\p{Extended_Pictographic}/gu;

// Mirrors src/lib/formatName.js — the export writes emoji-stripped names, so
// the same stripping has to happen here for "Worked On By" to match a profile.
const cleanName = (s) => (s || "").replace(EMOJI_RE, "").replace(/\s+/g, " ").trim();
const nameKey = (s) => cleanName(s).toLowerCase();

// The feed stores time as "H:MM" text. Accept that, "H:MM:SS" (what a
// spreadsheet writes when the column is formatted as a duration/time), or a
// decimal ("1.5"), and normalise to "H:MM" so imported rows read identically
// to tracked ones. Seconds are rounded into the minutes rather than dropped.
function normaliseTime(v) {
  const s = String(v ?? "").trim();
  if (!s || s === "-" || s === "—") return null;
  const hms = s.match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
  if (hms) {
    const mins = Number(hms[1]) * 60 + Number(hms[2]) + Math.round(Number(hms[3] || 0) / 60);
    if (mins <= 0) return null;
    return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, "0")}`;
  }
  const n = parseFloat(s.replace(/[^0-9.]/g, ""));
  if (isNaN(n) || n <= 0) return null;
  const mins = Math.round(n * 60);
  if (mins <= 0) return null;
  return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, "0")}`;
}

// The export writes dd.mm.yy; hand-made files carry dd/mm/yyyy or ISO, and a
// spreadsheet that treated the column as a datetime serialises a midnight time
// alongside it ("06/01/2026 00:00:00"). The feed's date column is a date only,
// so any time part is dropped before matching rather than failing the row.
//
// Day-first, not month-first: it's what the rest of the app assumes when it
// normalises the mixed-format `date` column (see toIso in the feed), so
// "06/01/2026" is 6 January.
function normaliseDate(v) {
  const s = String(v ?? "").trim().split(/[T\s]/)[0];
  if (!s) return null;
  // Year first is unambiguous whatever the separator.
  const iso = s.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
  const m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})$/);
  if (!m) return null;
  const [, d, mo, y] = m;
  const year = y.length === 2 ? `20${y}` : y;
  return `${year}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

const truthy = (v) => ["y", "yes", "true", "1", "x", "✓"].includes(String(v ?? "").trim().toLowerCase());
const money = (v) => {
  const n = parseFloat(String(v ?? "").replace(/[^0-9.\-]/g, ""));
  return isNaN(n) ? null : n;
};
const clean = (v) => {
  const s = String(v ?? "").trim();
  return s && s !== "—" && s !== "-" ? s : null;
};

async function handleJobsFeedImport(request, env) {
  const cookies = parseCookies(request);
  const session = cookies[SESSION_COOKIE];
  if (!session) return json({ error: "not_connected" }, { status: 401 });
  const tokenRow = await getTokenRowBySession(env, session);
  if (!tokenRow) return json({ error: "not_connected" }, { status: 401 });

  let body;
  try { body = await request.json(); } catch { return json({ error: "bad_json" }, { status: 400 }); }
  const rows = Array.isArray(body?.rows) ? body.rows : null;
  const dryRun = body?.dryRun !== false; // default to the safe pass
  if (!rows) return json({ error: "rows_required" }, { status: 400 });
  if (rows.length > IMPORT_MAX_ROWS) {
    return json({ error: "too_many_rows", max: IMPORT_MAX_ROWS }, { status: 413 });
  }

  // Reference data: existing time (duplicate detection), the Job Book, and
  // everyone's name so "Worked On By" resolves to a wrike_user_id.
  const [tasksRes, jobsRes, profilesRes] = await Promise.all([
    sbFetch(env, "/tasks?select=job_number,date,wrike_user_id,category,time_spent,additional_time&limit=20000"),
    sbFetch(env, "/jobs?select=*&limit=20000"),
    sbFetch(env, "/profiles?select=wrike_user_id,first_name,last_name"),
  ]);
  if (!tasksRes.ok || !jobsRes.ok || !profilesRes.ok) {
    console.error("[jobs-feed/import] reference read failed",
      tasksRes.status, jobsRes.status, profilesRes.status);
    return json({ error: "query_failed" }, { status: 502 });
  }
  const [existingTasks, jobs, profiles] = await Promise.all([
    tasksRes.json(), jobsRes.json(), profilesRes.json(),
  ]);

  const peopleByName = {};
  for (const p of profiles) {
    const key = nameKey(`${p.first_name || ""} ${p.last_name || ""}`);
    if (key) peopleByName[key] = p.wrike_user_id;
  }
  // Existing jobs keyed on the CODE, not the whole label.
  //
  // One job legitimately arrives written several ways — "XY025091" from a
  // panel that hadn't consulted the Job Book, "Film : XY025091, Desc" from one
  // that had, the same description with or without the region prefix the
  // folder scan writes. Keying on the label made an import file's variant of a
  // job we already hold look brand-new, so it was queued for creation: before
  // the jobs_job_code_key index that quietly produced a second row for one
  // job, and after it, a constraint violation that fails the entire insert
  // chunk and aborts the whole import.
  //
  // Mirrors jobKey in src/utils/wrikeHelpers.js — same rule, and the fallback
  // is the same too: no code means the label is all we have to match on.
  const codeKeyOf = (s) => (String(s || "").match(/XY\d{5,6}/i) || [""])[0].toUpperCase() || String(s || "").trim();
  const jobByNumber = {};
  for (const j of jobs) if (j.job_number) jobByNumber[codeKeyOf(j.job_number)] = j;

  // A row is "the same time already logged" when job, day, person, category
  // and both durations match. Deliberately not id-based: a re-exported file
  // carries no ids, and matching on the timesheet's own natural key is what
  // makes re-running a corrected file safe.
  const dupKey = (r) => [
    r.job_number || "", r.date || "", r.wrike_user_id || "",
    r.category || "", r.time_spent || "", r.additional_time || "",
  ].join(" ");
  const seen = new Set(existingTasks.map(dupKey));

  const toInsert = [];
  const errors = [];
  const unknownStaff = new Set();
  const jobsToCreate = new Map();  // job_number -> row payload
  const jobsToUpdate = new Map();  // job_number -> patch
  let duplicates = 0;

  rows.forEach((raw, i) => {
    const line = i + 2; // header is line 1, so this is the file's own line number
    const jobNumber = clean(raw.job_number);
    const date = normaliseDate(raw.date);
    const timeSpent = normaliseTime(raw.time_spent);
    const extra = normaliseTime(raw.additional_time);

    if (!jobNumber) { errors.push({ line, reason: "No job number" }); return; }
    if (!date) { errors.push({ line, reason: `Unreadable date "${raw.date ?? ""}"` }); return; }
    if (!timeSpent && !extra) { errors.push({ line, reason: "No time on the row" }); return; }

    const worked = clean(raw.worked_on);
    const wrikeUserId = worked ? peopleByName[nameKey(worked)] || null : null;
    if (worked && !wrikeUserId) unknownStaff.add(worked);

    const task = {
      job_number: jobNumber,
      date,
      client: clean(raw.client),
      film_title: clean(raw.film_title),
      project_description: clean(raw.project_description),
      category: clean(raw.category),
      client_amends: truthy(raw.client_amends),
      is_3d: truthy(raw.is_3d),
      time_spent: timeSpent,
      additional_time: extra,
      wrike_user_id: wrikeUserId,
      source: "import",
    };

    if (seen.has(dupKey(task))) { duplicates++; return; }
    seen.add(dupKey(task));
    toInsert.push(task);

    // Job-level columns ride along on the file. An unknown job number gets a
    // stub created from them; a known one gets them written over the top.
    const jobFields = {
      office: clean(raw.office),
      print_digital: clean(raw.print_digital),
      job_work_category: clean(raw.job_category),
      ordered_by: clean(raw.ordered_by),
      billed_to: clean(raw.billed_to),
      fixed_cost: money(raw.costs),
    };
    const present = Object.fromEntries(Object.entries(jobFields).filter(([, v]) => v != null));

    const jobCodeKey = codeKeyOf(jobNumber);
    const existingJob = jobByNumber[jobCodeKey];

    if (!existingJob && !jobsToCreate.has(jobCodeKey)) {
      // Every key on every object, nulls included — PostgREST rejects a bulk
      // insert whose objects don't all share the same key set (PGRST102), and
      // spreading only the populated columns gives each row a different shape.
      // On a create a null is right anyway: the column genuinely has no value.
      jobsToCreate.set(jobCodeKey, {
        job_number: jobNumber,
        client: task.client,
        film_title: task.film_title,
        project_description: task.project_description,
        start_date: date,
        status: "Active",
        ...jobFields,
      });
    } else if (existingJob && Object.keys(present).length) {
      // Keyed on the row's OWN stored label, not the file's and not the code:
      // the apply pass patches with job_number=eq.<key>, so this has to be the
      // string actually in the table or the PATCH matches nothing.
      jobsToUpdate.set(existingJob.job_number, {
        ...(jobsToUpdate.get(existingJob.job_number) || {}),
        ...present,
      });
    }
  });

  const plan = {
    rows: rows.length,
    toInsert: toInsert.length,
    duplicates,
    errors,
    unknownStaff: [...unknownStaff],
    jobsToCreate: [...jobsToCreate.keys()],
    jobsToUpdate: [...jobsToUpdate.keys()],
  };

  if (dryRun) return json({ dryRun: true, plan });

  // ── Apply ──────────────────────────────────────────────────────────────
  // Jobs first: a task row is only meaningful in the feed once its job exists.
  try {
    if (jobsToCreate.size) {
      const res = await sbFetch(env, "/jobs?on_conflict=job_number", {
        method: "POST",
        headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
        body: JSON.stringify([...jobsToCreate.values()]),
      });
      if (!res.ok) throw new Error(`jobs insert ${res.status}: ${await res.text()}`);
    }

    for (const [jobNumber, patch] of jobsToUpdate) {
      const res = await sbFetch(env, `/jobs?job_number=eq.${encodeURIComponent(jobNumber)}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(`job patch ${jobNumber} ${res.status}: ${await res.text()}`);
    }

    // tasks.id has no default or identity — the client has always supplied it
    // (Date.now() in the tracker). Base off the current max so an import can
    // never collide with a row the tracker writes at the same moment.
    const maxRes = await sbFetch(env, "/tasks?select=id&order=id.desc&limit=1");
    const maxRows = maxRes.ok ? await maxRes.json() : [];
    let nextId = Math.max(Number(maxRows[0]?.id || 0), Date.now()) + 1;

    let inserted = 0;
    for (let i = 0; i < toInsert.length; i += 500) {
      const chunk = toInsert.slice(i, i + 500).map((t) => ({ ...t, id: nextId++ }));
      const res = await sbFetch(env, "/tasks", {
        method: "POST",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify(chunk),
      });
      if (!res.ok) throw new Error(`tasks insert ${res.status}: ${await res.text()}`);
      inserted += chunk.length;
    }

    return json({ dryRun: false, plan: { ...plan, inserted } });
  } catch (e) {
    console.error("[jobs-feed/import] apply failed:", e.message);
    return json({ error: "import_failed", detail: e.message }, { status: 502 });
  }
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

// Raised when Supabase itself didn't answer — as opposed to answering "there
// is no such row". Callers that talk to Wrike have to tell those apart; see
// getWebhookConfig.
class SupabaseUnavailable extends Error {}

// Returns the row, or null when Supabase positively reports no webhook is
// configured. Throws SupabaseUnavailable when Supabase couldn't be reached or
// refused the read (402 over-quota, 5xx, network error).
//
// These two used to collapse into the same null, and handleWebhookEvent turned
// any null into a 404 — so while Supabase was over its quota and 402ing, every
// Wrike delivery was answered "webhook_not_configured". That reads to Wrike as
// an endpoint that no longer exists, and it suspends the webhook account-wide.
// The outage was transient; the suspension it caused was not, since clearing it
// needs a manual admin re-register long after Supabase recovered.
async function getWebhookConfig(env) {
  let res;
  try {
    res = await sbFetch(env, `/wrike_webhook_config?select=*&limit=1`);
  } catch (err) {
    throw new SupabaseUnavailable(`webhook config fetch failed: ${err.message}`);
  }
  if (!res.ok) {
    throw new SupabaseUnavailable(`webhook config read failed: ${res.status}`);
  }
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
  // Bail out early and legibly if Supabase is unreachable. Registering writes
  // the new secret to Supabase before Wrike validates the hook URL, so there
  // is no version of this that succeeds while the database is down — without
  // this the run would get as far as that write and surface an opaque 500.
  let previousConfig;
  try {
    previousConfig = await getWebhookConfig(env);
  } catch (err) {
    console.error("[webhook] register aborted, Supabase unavailable:", err.message);
    return json({
      error: "database_unavailable",
      detail: "Couldn't reach the database to save the webhook secret. Live sync can't be enabled until that recovers.",
    }, { status: 503 });
  }

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
  let config;
  try {
    config = await getWebhookConfig(env);
  } catch (err) {
    // Supabase didn't answer, so we can't read the secret — meaning we can
    // neither verify nor record this delivery. Answering Wrike with an error
    // would be the honest status, but Wrike responds to a failing endpoint by
    // suspending the webhook for the whole account, and that suspension
    // outlives the outage that caused it. Acknowledge and drop instead: the
    // periodic Wrike sync (useWrikeCache) re-fetches tasks independently of
    // this feed, so an outage costs freshness until it recovers rather than
    // taking live sync down until someone notices and re-registers by hand.
    console.error("[webhook] config unavailable, ACKing to keep hook alive:", err.message);
    return json({ ok: true, dropped: "config_unavailable" });
  }
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

// ── Panel jobs feed ──────────────────────────────────────────────────────────
// Serves the XYi Toolbox panel's "Active Jobs" card from wrike_tasks_cache.
//
// AUTH is a shared header key, not the session cookie the browser app uses: a
// CEP panel has no session, and its origin is `null` so cookies never attach
// cross-origin. That is acceptable here ONLY because this route is read-only
// and returns what every studio member can already read in Wrike — it grants
// no privilege anyone lacks. It is emphatically not a Wrike token: those are
// read AND write and carry an individual's identity, which is why the panel
// never sees one.
//
// FILTERING BY MEMBER happens here rather than client-side so the panel gets a
// short payload, but it is a convenience, not a security boundary — the key
// holder could ask for anyone. The panel sends the member name its machine is
// tagged with; profiles maps that to a Wrike user id.
//
// Reads the CACHE, never Wrike: wrike_tasks_cache is kept current by the app
// and the webhook, so this costs one Supabase query and no Wrike API budget.
// Wrike's `status` field only ever holds a BASE status. "Backlog"/"In Progress"
// are CUSTOM status names living behind customStatusId and never appear here --
// confirmed against the live cache, which contained only Completed/Active/
// Cancelled. Filtering on the custom names was therefore dead weight.
const PANEL_ACTIVE_STATUSES = ["Active", "Deferred"];

function panelCors(extra = {}) {
  return {
    // The panel's origin is `null` (file://), which cannot be allow-listed by
    // name. The key is the actual gate, and no credentials are sent, so `*` is
    // both necessary and safe here.
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "X-Panel-Key, Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    ...extra,
  };
}

function panelPreflight() {
  return new Response(null, { status: 204, headers: panelCors() });
}

async function handlePanelJobs(request, url, env) {
  if (!env.PANEL_KEY || request.headers.get("X-Panel-Key") !== env.PANEL_KEY) {
    return json({ error: "unauthorized" }, { status: 401, headers: panelCors() });
  }

  // Resolve the member name the panel sent to a Wrike user id.
  const member = (url.searchParams.get("member") || "").trim();
  let wrikeUserId = "";
  if (member) {
    const profRes = await sbFetch(env, "/profiles?select=wrike_user_id,first_name,last_name");
    if (profRes.ok) {
      const profiles = await profRes.json();
      const wanted = member.toLowerCase();
      const hit = (profiles || []).find((p) => {
        const first = (p.first_name || "").trim().toLowerCase();
        const full = `${p.first_name || ""} ${p.last_name || ""}`.trim().toLowerCase();
        // The panel tags a machine with a display name ("Antonio"), which is
        // usually the first name — accept either form rather than forcing the
        // studio to keep two naming schemes in step.
        return first === wanted || full === wanted;
      });
      if (hit) wrikeUserId = hit.wrike_user_id;
    }
  }
  if (member && !wrikeUserId) {
    // Say so rather than returning [] — an empty list would read as "no work"
    // when the real answer is "we could not match that name".
    return json({ error: "unknown_member", member, jobs: [] }, { status: 404, headers: panelCors() });
  }

  // FILTER IN THE DATABASE, not in JS. The first version pulled
  // `select=id,task_data&limit=5000` and filtered here -- but PostgREST caps
  // responses at 1000 rows by default and the query had no ORDER BY, so it
  // returned an arbitrary slice that was 986/1000 Completed tasks. Active jobs
  // simply never made it into the payload, and because the slice was unordered
  // it differed between requests. Filtering server-side keeps the result small
  // enough that no cap applies.
  const statusFilter = `task_data->>status=in.(${PANEL_ACTIVE_STATUSES.join(",")})`;
  const assigneeFilter = wrikeUserId
    ? `&task_data->responsibleIds=cs.${encodeURIComponent(JSON.stringify([wrikeUserId]))}`
    : "";
  const res = await sbFetch(
    env,
    `/wrike_tasks_cache?select=id,task_data&${statusFilter}${assigneeFilter}&limit=500`
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error(`[panel/jobs] cache query ${res.status}:`, detail);
    return json({ error: "query_failed", detail: detail.slice(0, 200) }, { status: 502, headers: panelCors() });
  }
  const rows = await res.json();

  // Subtask names live in rows that the filters above deliberately exclude (a
  // subtask can be Completed while its parent is Active, and is usually
  // assigned to nobody). Fetch just the ones referenced, by id.
  const wantedSubIds = [];
  for (const row of rows || []) {
    for (const id of row?.task_data?.subTaskIds || []) wantedSubIds.push(String(id));
  }
  let subRows = [];
  if (wantedSubIds.length) {
    const ids = wantedSubIds.slice(0, 400).map((i) => `"${i}"`).join(",");
    const subRes = await sbFetch(env, `/wrike_tasks_cache?select=id,task_data&id=in.(${ids})`);
    if (subRes.ok) subRows = await subRes.json();
  }

  // subTaskIds gives IDs only. The cache holds every task it has seen,
  // subtasks included, so their names are resolvable from the same rows --
  // no second query and no Wrike call. A subtask that is not cached falls
  // back to an empty name, which the panel renders as an unparseable row
  // rather than inventing one.
  const byId = new Map();
  for (const row of [...(rows || []), ...(subRows || [])]) {
    if (row?.id && row?.task_data) byId.set(String(row.id), row.task_data);
  }

  // ?debug=1 -- counts at each filter stage, so "why is only one job showing"
  // is answerable with data instead of guesses. Key-gated like everything else
  // here, and returns no task content beyond titles.
  if (url.searchParams.get("debug")) {
    const seenStatuses = {};
    let withTitle = 0, topLevel = 0, mine = 0, active = 0, hasResponsible = 0, withDueDate = 0;
    const mineTitles = [];
    for (const row of rows || []) {
      const t = row?.task_data;
      if (!t || !t.title) continue;
      withTitle++;
      if (Array.isArray(t.responsibleIds)) hasResponsible++;
      seenStatuses[t.status || "(none)"] = (seenStatuses[t.status || "(none)"] || 0) + 1;
      const isTop = !(t.superTaskIds || []).length;
      if (isTop) topLevel++;
      const isMine = !wrikeUserId || (t.responsibleIds || []).includes(wrikeUserId);
      if (isMine) {
        mine++;
        mineTitles.push({ title: t.title, status: t.status || "(none)", sub: !isTop });
      }
      const hasDue = t.dueDate && t.dueDate !== "No Due Date";
      const dueOk = hasDue && !isNaN(new Date(t.dueDate).getTime()) && new Date(t.dueDate) <= new Date(new Date().setHours(23, 59, 59, 999));
      if (isMine && isTop && hasDue) withDueDate++;
      if (isMine && isTop && dueOk) active++;
    }
    return json({
      member, wrikeUserId,
      cacheRows: (rows || []).length,
      subRowsFetched: (subRows || []).length,
      withTitle, hasResponsibleIds: hasResponsible,
      topLevel, assignedToMember: mine, assignedWithDueDate: withDueDate, passingAllFilters: active,
      statusesSeen: seenStatuses,
      // Everything assigned to them, INCLUDING what the filters drop, with the
      // reason visible (sub = dropped as a subtask).
      assigned: mineTitles.slice(0, 40),
    }, { headers: panelCors() });
  }

  // SELECTION IS SHARED with the board -- src/lib/jobFilter.js, the same
  // isBoardTask() TodaysList.js calls. Not a copy of its rules: the same code.
  // That matters because the rules are subtler than they look (the "Today"
  // window starts at the EPOCH, so it means due-today-or-overdue), and an
  // earlier version of this route reimplemented them and quietly disagreed.

  const jobs = [];
  for (const row of rows || []) {
    const t = row?.task_data;
    if (!t || !t.title) continue;
    // Status, due-date presence and the window, all in one shared predicate.
    if (!isBoardTask(t, "Today")) continue;
    // Stale = overdue by more than a week. The board hides these by default
    // (its "hidden" counter in the header), and the panel is meant to be a
    // SHORT list of what to build, so a job that has been sitting for months
    // is noise here too. Same isStale() the board uses.
    if (isStale(t.dueDate)) continue;
    // Subtasks are tasks too and would otherwise be listed as jobs in their own
    // right, duplicating what already appears inside their parent.
    if ((t.superTaskIds || []).length > 0) continue;
    if (wrikeUserId && !(t.responsibleIds || []).includes(wrikeUserId)) continue;
    const status = t.customStatusId ? t.status || "" : t.status || "";
    if (status && !PANEL_ACTIVE_STATUSES.includes(status)) continue;

    jobs.push({
      id: String(row.id),
      title: String(t.title),
      // The panel filters on this, so send the name it tagged the machine
      // with rather than a Wrike id it has no way to interpret.
      assignee: member,
      // customStatusName is the human status the board displays ("on hold",
      // "retouch", "to amend"); `status` is only ever the base Active/Completed.
      status: t.customStatusName || status,
      due_date: t.dueDate || "",
      updated_at: t.updatedDate || "",
      permalink: t.permalink || "",
      subtasks: (t.subTaskIds || []).map((id) => {
        const sub = byId.get(String(id));
        return {
          id: String(id),
          name: sub?.title || "",
          status: sub?.status || "",
        };
      }),
      subtask_count: (t.subTaskIds || []).length,
      subtasks_done: (t.subTaskIds || []).filter((id) => {
        const sub = byId.get(String(id));
        return sub && (sub.status === "Completed" || sub.status === "Cancelled");
      }).length,
    });
  }

  // Freshest first: most jobs carry no due date at all, so updated is the only
  // ordering that reflects real activity.
  jobs.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));

  return json(jobs, { headers: panelCors() });
}
