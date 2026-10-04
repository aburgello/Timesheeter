import { isBoardTask, isStale } from "../src/lib/jobFilter";
// Cloudflare Worker: Wrike OAuth (authorization code flow) + API proxy.
//
// Members never see a Wrike token. After /api/wrike/oauth/start and Wrike's
// approval page, the browser calls /api/wrike/* here, and this attaches the
// stored token (refreshing it when needed) and forwards to Wrike.
//
// Tokens live in Supabase (wrike_oauth_tokens), reachable only with the service
// role key in this Worker's secrets; RLS blocks the browser's roles entirely.

const WRIKE_AUTHORIZE_URL = "https://login.wrike.com/oauth2/authorize/v4";
const WRIKE_TOKEN_URL = "https://login.wrike.com/oauth2/token";
const SESSION_COOKIE = "wrike_session";
const STATE_COOKIE = "wrike_oauth_state";
const SESSION_MAX_AGE = 60 * 60 * 24 * 180; // 180 days
const STATE_MAX_AGE = 600; // 10 minutes

// One in-flight refresh per session_token. Wrike rotates the refresh token on
// use, so two concurrent refreshes with the same token mean the second fails
// (token_refresh_failed) even though the first just stored a good one.
const refreshInFlight = new Map();

// Deadline for Supabase calls on the auth path. Every /api/wrike/* call starts
// with a token-row read, and a stalled read would otherwise eat the whole
// request budget.
const SB_AUTH_TIMEOUT_MS = 5000;

// ...and retry, because stalls hit individual requests, not the service: a
// retry is almost always answered at once. Three attempts, worst case ~15.5s,
// inside Cloudflare's 30s limit.
const SB_AUTH_RETRY_DELAYS_MS = [100, 400];

// Backoff for re-attempting a token write that failed. See unpersistedTokens.
const TOKEN_PERSIST_RETRY_DELAYS_MS = [1000, 3000, 8000];

// Credentials Wrike has issued but we haven't managed to store yet.
//
// Wrike kills the old refresh token as soon as it issues a new pair, so losing
// the save would sign the member out for good. Holding the pair here keeps
// them working while the save is retried in the background.
const unpersistedTokens = new Map();

// Wrike positively rejected our credentials. Only this means the member must
// reconnect; anything else is transient and must not look like a sign-out.
class WrikeAuthInvalid extends Error {}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const isHttps = url.protocol === "https:";

    if (url.pathname === "/api/embed/video") {
      return handleVideoEmbed(url, env);
    }
    if (url.pathname === "/api/wrike/oauth/start") {
      return handleOAuthStart(url, env, isHttps);
    }
    if (url.pathname === "/api/wrike/oauth/callback") {
      return handleOAuthCallback(request, url, env, isHttps);
    }
    if (url.pathname === "/api/wrike/oauth/disconnect") {
      return handleDisconnect(request, env, ctx);
    }
    if (url.pathname === "/api/wrike/oauth/status") {
      return handleStatus(request, env);
    }
    if (url.pathname === "/api/wrike/webhook/register" && request.method === "POST") {
      return handleWebhookRegister(request, url, env);
    }
    if (url.pathname === "/api/wrike/webhook" && request.method === "POST") {
      return handleWebhookEvent(request, env, ctx);
    }
    if (url.pathname.startsWith("/api/wrike/")) {
      return handleProxy(request, url, env, ctx);
    }
    if (url.pathname === "/api/jobs-feed") {
      return handleJobsFeed(request, env);
    }
    if (url.pathname === "/api/jobs-feed/import" && request.method === "POST") {
      return handleJobsFeedImport(request, env);
    }
    // Read-only feed for the XYi Toolbox panel. Not /api/jobs-feed, which needs a
    // browser session cookie; the panel's origin is `null`.
    if (url.pathname === "/api/panel/jobs") {
      if (request.method === "OPTIONS") return panelPreflight();
      return handlePanelJobs(request, url, env);
    }
    // A job's latest Wrike comment -- where the amends are written, per
    // deliverable. Read on demand by the panel, one task at a time.
    if (url.pathname === "/api/panel/comment") {
      if (request.method === "OPTIONS") return panelPreflight();
      return handlePanelComment(request, url, env);
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

// ── Video embed page (Notes Canvas sketches) ─────────────────────────────────
// Excalidraw can only embed via an iframe, and an iframe pointed at an .mp4 gets
// the browser's own player (autoplay is up to the browser). Our wrapper page
// sets controls and no autoplay.
//
// The src must be in this project's own Storage bucket, or the route would frame
// any URL on our origin.
function handleVideoEmbed(url, env) {
  const src = url.searchParams.get("src") || "";
  const allowedPrefix = `${env.SUPABASE_URL}/storage/v1/object/public/notes-images/`;
  if (!src.startsWith(allowedPrefix)) {
    return new Response("Forbidden", { status: 403 });
  }
  // src is same-origin-prefixed and already proven to be our own Storage URL,
  // but it still lands inside an HTML attribute, so quote-escape it.
  const safeSrc = src.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  html,body{margin:0;height:100%;background:#000;overflow:hidden}
  video{width:100%;height:100%;object-fit:contain;display:block;background:#000}
</style></head>
<body><video src="${safeSrc}" controls preload="metadata" playsinline></video></body></html>`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
      // The page holds exactly one media element from a known origin; nothing
      // here should ever run a script or be framed by anyone but us.
      "Content-Security-Policy":
        `default-src 'none'; media-src ${env.SUPABASE_URL}; style-src 'unsafe-inline'; frame-ancestors 'self'`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

// ── Admin Jobs Feed (all users' time) ────────────────────────────────────────
// `tasks` has per-user RLS, so the browser only sees its own rows. The
// Administration Jobs Feed shows everyone's time, so it reads here with the
// service role, gated on a valid Wrike session.
async function handleJobsFeed(request, env) {
  const cookies = parseCookies(request);
  const session = cookies[SESSION_COOKIE];
  if (!session) return json({ error: "not_connected" }, { status: 401 });
  let row;
  try {
    row = await getTokenRowBySession(env, session);
  } catch (err) {
    console.error("[jobs-feed] token lookup unavailable:", err.message);
    return json({ error: "backend_unavailable" }, { status: 503 });
  }
  if (!row) return json({ error: "not_connected" }, { status: 401 });

  // 20000 limit: after bulk imports the table is well past the old 5000, and a
  // silently truncated feed looks like missing hours.
  // Ordered by the day the work happened (id only reflects when it was pulled);
  // undated rows last, ties by most recently synced.
  const res = await sbFetch(env, "/tasks?select=*&order=work_date.desc.nullslast,id.desc&limit=20000");
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
// Server-side because `tasks` has per-user RLS and an import covers the whole
// team; gated on a valid Wrike session.
//
// Two passes: `dryRun` returns the plan without writing; the same request
// without it applies exactly that plan. The UI always previews first.

const IMPORT_MAX_ROWS = 5000;
const EMOJI_RE = /\p{Extended_Pictographic}/gu;

// Mirrors src/lib/formatName.js — the export writes emoji-stripped names, so
// the same stripping has to happen here for "Worked On By" to match a profile.
const cleanName = (s) => (s || "").replace(EMOJI_RE, "").replace(/\s+/g, " ").trim();
const nameKey = (s) => cleanName(s).toLowerCase();

// Time as "H:MM", "H:MM:SS" (spreadsheet durations) or decimal "1.5",
// normalised to "H:MM". Seconds are rounded, not dropped.
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

// Dates as dd.mm.yy (the export), dd/mm/yyyy or ISO; a trailing time
// ("06/01/2026 00:00:00") is dropped. Day-first, like the rest of the app, so
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
  let tokenRow;
  try {
    tokenRow = await getTokenRowBySession(env, session);
  } catch (err) {
    console.error("[jobs-feed-import] token lookup unavailable:", err.message);
    return json({ error: "backend_unavailable" }, { status: 503 });
  }
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
  // Existing jobs keyed on the XY code, not the whole label: the same job arrives
  // written several ways ("XY025091", "Film : XY025091, Desc", with or without a
  // region prefix). Keyed on the label, a variant looked new and the insert hit
  // the jobs_job_code_key constraint, aborting the import. Same rule as jobKey in
  // src/utils/wrikeHelpers.js; no code means match on the label.
  const codeKeyOf = (s) => (String(s || "").match(/XY\d{5,6}/i) || [""])[0].toUpperCase() || String(s || "").trim();
  const jobByNumber = {};
  for (const j of jobs) if (j.job_number) jobByNumber[codeKeyOf(j.job_number)] = j;

  // "Already logged" = same job, day, person, category and both durations. Not by
  // id: a re-exported file has none, and this is what makes re-running a
  // corrected file safe.
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
      // The same day in both columns: `date` for the export and older clients,
      // work_date for queries.
      work_date: date,
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
      // Every key on every object, nulls included: PostgREST rejects a bulk insert
      // whose objects have different key sets (PGRST102).
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
      // Keyed on the label actually stored in the table, because the apply pass
      // PATCHes with job_number=eq.<key>.
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

    // tasks.id has no default; clients supply it (Date.now() in the tracker). Start
    // above the current max so an import can't collide with a tracker write.
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
  // timeoutMs is ours, not fetch's — pull it out before forwarding.
  const { timeoutMs, ...init } = opts;
  return fetch(`${env.SUPABASE_URL}/rest/v1${path}`, {
    ...init,
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
}

// Returns the row, or null when Supabase says there's no such session. Throws
// SupabaseUnavailable when it couldn't be asked. Callers read null as "not
// connected", so a database stall must never come back as null.
async function getTokenRowBySession(env, sessionToken) {
  let rows;
  let lastError;
  for (let attempt = 0; attempt <= SB_AUTH_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, SB_AUTH_RETRY_DELAYS_MS[attempt - 1]));
    }
    try {
      const res = await sbFetch(
        env,
        `/wrike_oauth_tokens?session_token=eq.${encodeURIComponent(sessionToken)}&select=*`,
        { timeoutMs: SB_AUTH_TIMEOUT_MS }
      );
      if (!res.ok) throw new Error(`status ${res.status}`);
      rows = await res.json();
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
      console.error(`[token] read attempt ${attempt + 1} failed:`, err.message);
    }
  }
  if (lastError) throw new SupabaseUnavailable(`token row read failed: ${lastError.message}`);
  const stored = rows[0] || null;
  // Prefer credentials we minted but couldn't store: once Wrike has rotated, the
  // stored refresh token is dead and the in-memory pair is the only working one.
  const pending = unpersistedTokens.get(sessionToken);
  return pending || stored;
}

// Keyed by session_token, not wrike_user_id: one Wrike account can be connected
// from several browsers or environments, each with its own row, and keying by
// user made one environment's connect or disconnect break the others.
async function upsertTokenRow(env, row) {
  const res = await sbFetch(env, `/wrike_oauth_tokens?on_conflict=session_token`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`Supabase upsert failed: ${res.status} ${await res.text()}`);
  return (await res.json())[0];
}

async function updateTokenRow(env, sessionToken, patch, timeoutMs) {
  const res = await sbFetch(env, `/wrike_oauth_tokens?session_token=eq.${encodeURIComponent(sessionToken)}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(patch),
    timeoutMs,
  });
  if (!res.ok) throw new Error(`Supabase update failed: ${res.status} ${await res.text()}`);
  return (await res.json())[0];
}

async function deleteTokenRow(env, sessionToken) {
  const res = await sbFetch(env, `/wrike_oauth_tokens?session_token=eq.${encodeURIComponent(sessionToken)}`, {
    method: "DELETE",
    timeoutMs: SB_AUTH_TIMEOUT_MS,
  });
  if (!res.ok) throw new Error(`row delete failed: ${res.status}`);
}

// Signing out must not leave a usable token behind: panelWrikeToken uses the
// freshest stored token, so an orphaned row would still be live. Keep retrying
// the delete, detached from the response.
async function deleteTokenRowPersistently(env, sessionToken) {
  for (let attempt = 0; ; attempt++) {
    try {
      await deleteTokenRow(env, sessionToken);
      return;
    } catch (err) {
      if (attempt >= TOKEN_PERSIST_RETRY_DELAYS_MS.length) {
        console.error("[disconnect] row delete gave up; a stored token may outlive the sign-out:", err.message);
        return;
      }
      await new Promise((r) => setTimeout(r, TOKEN_PERSIST_RETRY_DELAYS_MS[attempt]));
    }
  }
}

// Raised when Supabase itself didn't answer — as opposed to answering "there
// is no such row". Callers that talk to Wrike have to tell those apart; see
// getWebhookConfig.
class SupabaseUnavailable extends Error {}

// Returns the row, or null when Supabase says no webhook is configured. Throws
// SupabaseUnavailable when Supabase couldn't be reached or refused (402, 5xx,
// network). The difference matters: answering Wrike "not configured" during an
// outage gets the webhook suspended account-wide, and that outlasts the outage.
//
// Cached per isolate, because every delivery needs the secret and that read is
// on Wrike's delivery-timeout clock. Staleness is bounded by a short TTL and a
// forced re-read when a signature doesn't match (an admin re-register rotates
// the secret).
let webhookConfigCache = null;
let webhookConfigCachedAt = 0;
let webhookConfigForcedAt = 0;
const WEBHOOK_CONFIG_TTL_MS = 60_000;
// Floor between forced re-reads, so a flood of bad signatures can't turn into a
// flood of Supabase reads.
const WEBHOOK_CONFIG_FORCE_MIN_GAP_MS = 10_000;

async function getWebhookConfig(env, { force = false } = {}) {
  const now = Date.now();
  if (!force && webhookConfigCache && now - webhookConfigCachedAt < WEBHOOK_CONFIG_TTL_MS) {
    return webhookConfigCache;
  }
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
  webhookConfigCache = rows[0] || null;
  webhookConfigCachedAt = now;
  return webhookConfigCache;
}

// Re-read past the cache, but no more often than the floor above. Returns null
// when the floor says "too soon" so the caller keeps whatever it already had.
async function refreshWebhookConfig(env) {
  const now = Date.now();
  if (now - webhookConfigForcedAt < WEBHOOK_CONFIG_FORCE_MIN_GAP_MS) return null;
  webhookConfigForcedAt = now;
  return getWebhookConfig(env, { force: true });
}

async function upsertWebhookConfig(env, { webhookId, secret }) {
  const res = await sbFetch(env, `/wrike_webhook_config?on_conflict=id`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({ id: true, webhook_id: webhookId, secret }),
  });
  if (!res.ok) throw new Error(`Supabase upsert failed: ${res.status} ${await res.text()}`);
  const row = (await res.json())[0];
  // This isolate just rotated the secret — adopt it now rather than serving a
  // secret we know is dead until the TTL lapses.
  webhookConfigCache = row;
  webhookConfigCachedAt = Date.now();
  return row;
}

// One call per delivery for all its events. The database function writes
// wrike_webhook_events and copies status and assignment changes into
// wrike_task_activity (see migration 20260923181757).
async function insertWebhookEvents(env, rows) {
  if (!rows.length) return;
  try {
    const res = await sbFetch(env, `/rpc/record_wrike_webhook_events`, {
      method: "POST",
      // return=minimal: fire-and-forget, nothing to read back.
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ events: rows }),
    });
    if (!res.ok) {
      console.error(`[webhook] insert failed ${res.status}:`, await res.text().catch(() => ""));
    }
  } catch (err) {
    // Wrike already has its response, so just log. The periodic sync backfills.
    console.error("[webhook] insert threw:", err.message);
  }
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
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    // 400/401 means the refresh token itself is bad and the member must reconnect.
    // A 5xx or rate limit is temporary and must not look like a sign-out.
    if (res.status === 400 || res.status === 401) {
      throw new WrikeAuthInvalid(`Wrike rejected the refresh token: ${res.status} ${detail}`);
    }
    throw new Error(`Wrike token refresh failed: ${res.status} ${detail}`);
  }
  return res.json();
}

// Refresh one token row, sharing a single in-flight refresh per session_token.
// Returns the updated row; throws if the refresh fails.
//
// THE ONLY PLACE THAT SHOULD CALL refreshAccessToken + updateTokenRow, the proxy
// and the panel included. Wrike rotates the refresh token on use, and two
// concurrent refreshes of one row sign the member out (see refreshInFlight).
// retryTokenPersist below keeps trying to store credentials Wrike has already
// rotated to, detached via waitUntil because the triggering request is usually
// the one that just died.
async function retryTokenPersist(env, sessionToken, patch) {
  for (const delay of TOKEN_PERSIST_RETRY_DELAYS_MS) {
    await new Promise((r) => setTimeout(r, delay));
    try {
      const saved = await updateTokenRow(env, sessionToken, patch, SB_AUTH_TIMEOUT_MS);
      unpersistedTokens.delete(sessionToken);
      console.log("[token] background persist succeeded");
      return saved;
    } catch (err) {
      console.error("[token] background persist retry failed:", err.message);
    }
  }
  // Out of attempts. The in-memory pair is still the only working one, so keep
  // using it until this isolate is recycled.
  console.error("[token] background persist gave up; session survives only in this isolate");
}

async function refreshTokenRow(env, row, ctx) {
  const key = row.session_token;
  if (!refreshInFlight.has(key)) {
    refreshInFlight.set(
      key,
      (async () => {
        try {
          const refreshed = await refreshAccessToken(env, row.refresh_token);
          const patch = {
            access_token: refreshed.access_token,
            refresh_token: refreshed.refresh_token || row.refresh_token,
            api_host: refreshed.host || row.api_host,
            expires_at: new Date(Date.now() + Number(refreshed.expires_in || 3600) * 1000).toISOString(),
            updated_at: new Date().toISOString(),
          };
          // Wrike has already burned the old refresh token, so a failed save must not
          // propagate (it would sign the member out over a database blip). Hold the new
          // pair, serve from it, and retry the save in the background.
          try {
            const saved = await updateTokenRow(env, key, patch, SB_AUTH_TIMEOUT_MS);
            unpersistedTokens.delete(key);
            return saved;
          } catch (err) {
            console.error("[token] persist failed, holding new credentials in memory:", err.message);
            const next = { ...row, ...patch };
            unpersistedTokens.set(key, next);
            const retry = retryTokenPersist(env, key, patch);
            if (ctx) ctx.waitUntil(retry);
            else retry.catch(() => {});
            return next;
          }
        } finally {
          refreshInFlight.delete(key);
        }
      })()
    );
  }
  // Every concurrent caller awaits the same promise and gets the same row.
  return refreshInFlight.get(key);
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

// Signing out is clearing the cookie, which needs no database. The row is
// deleted in the background (its primary key is the session token), so a slow
// database can't make Disconnect hang.
async function handleDisconnect(request, env, ctx) {
  const cookies = parseCookies(request);
  const session = cookies[SESSION_COOKIE];
  const res = json({ ok: true });
  res.headers.append("Set-Cookie", clearCookie(SESSION_COOKIE, "/"));
  if (session) {
    unpersistedTokens.delete(session);
    const cleanup = deleteTokenRowPersistently(env, session);
    if (ctx) ctx.waitUntil(cleanup);
    else cleanup.catch(() => {});
  }
  return res;
}

async function handleStatus(request, env) {
  const cookies = parseCookies(request);
  const session = cookies[SESSION_COOKIE];
  if (!session) return json({ connected: false });
  let row;
  try {
    row = await getTokenRowBySession(env, session);
  } catch (err) {
    // "Couldn't check" is not "not connected".
    console.error("[status] token lookup unavailable:", err.message);
    return json({ error: "status_unavailable" }, { status: 503 });
  }
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

  let row;
  try {
    row = await getTokenRowBySession(env, session);
  } catch (err) {
    console.error("[webhook-register] token lookup unavailable:", err.message);
    return json({ error: "backend_unavailable" }, { status: 503 });
  }
  if (!row) return json({ error: "not_connected" }, { status: 401 });

  // Wrike calls hookUrl back during creation, which it can't do for localhost.
  // Refuse up front with a clear reason.
  if (["localhost", "127.0.0.1", "0.0.0.0"].includes(url.hostname) || url.hostname.endsWith(".local")) {
    return json({
      error: "unreachable_origin",
      detail: "Live sync must be enabled from the deployed site — Wrike can't reach a localhost URL to deliver webhooks.",
    }, { status: 400 });
  }

  const hookUrl = `${url.origin}/api/wrike/webhook`;
  const authHeader = { Authorization: `Bearer ${row.access_token}` };

  // Keep the live config so a failed create below can restore it rather than
  // leave a half-written one (whose secret wouldn't match what Wrike is still
  // sending). Stop early if Supabase is unreachable: registering has to save the
  // new secret before Wrike validates the URL.
  let previousConfig;
  try {
    // Forced: this value is the rollback target if the create below fails, so
    // it has to be what Supabase actually holds, not a cached copy.
    previousConfig = await getWebhookConfig(env, { force: true });
  } catch (err) {
    console.error("[webhook] register aborted, Supabase unavailable:", err.message);
    return json({
      error: "database_unavailable",
      detail: "Couldn't reach the database to save the webhook secret. Live sync can't be enabled until that recovers.",
    }, { status: 503 });
  }

  // Delete any webhooks already pointing here first. Config holds one secret, and
  // older webhooks keep firing with secrets we no longer have, failing every
  // signature check. This leaves exactly one live webhook matching config.
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

  // Wrike validates hookUrl during creation by calling it with a signed handshake,
  // so the secret must already be saved.
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

// Public endpoint Wrike calls directly (no session cookie): both the one-time
// secret-verification challenge and real deliveries. Both carry X-Hook-Secret
// and X-Hook-Signature, so headers can't tell them apart; the body can (the
// challenge is {"requestType":"WebHook secret verification"}, deliveries are an
// array). Both are signature-checked first.
async function handleWebhookEvent(request, env, ctx) {
  let config;
  try {
    config = await getWebhookConfig(env);
  } catch (err) {
    // Without Supabase we can't read the secret, so we can neither verify nor
    // record this. Acknowledge anyway: an error makes Wrike suspend the webhook
    // account-wide, and that lasts long after the outage. The periodic sync covers
    // the gap.
    console.error("[webhook] config unavailable, ACKing to keep hook alive:", err.message);
    return json({ ok: true, dropped: "config_unavailable" });
  }
  if (!config) return json({ error: "webhook_not_configured" }, { status: 404 });

  const rawBody = await request.text();
  const signatureHeader = request.headers.get("X-Hook-Signature") || "";

  let expectedBodySignature = await hmacSha256Hex(config.secret, rawBody);
  if (!timingSafeEqual(signatureHeader, expectedBodySignature)) {
    // A forgery, or our cached secret is stale because an admin just re-registered.
    // Re-read once before rejecting: a 401 to a genuine delivery gets the webhook
    // suspended.
    let fresh = null;
    try {
      fresh = await refreshWebhookConfig(env);
    } catch (err) {
      console.error("[webhook] config re-read failed, ACKing to keep hook alive:", err.message);
      return json({ ok: true, dropped: "config_unavailable" });
    }
    if (fresh) {
      config = fresh;
      expectedBodySignature = await hmacSha256Hex(config.secret, rawBody);
    }
    if (!timingSafeEqual(signatureHeader, expectedBodySignature)) {
      // Signature mismatch against the current secret — not from Wrike.
      // Discard per Wrike's docs.
      console.error("[webhook] invalid signature — dropping delivery");
      return json({ error: "invalid_signature" }, { status: 401 });
    }
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

  const events = Array.isArray(parsedBody) ? parsedBody : [parsedBody];
  const rows = events
    .filter((evt) => evt?.taskId) // ignore folder/comment/attachment-only events
    .map((evt) => ({
      task_id: evt.taskId,
      event_type: evt.eventType || null,
      occurred_at: evt.lastUpdatedDate || new Date().toISOString(),
      // Only kept in wrike_task_activity (status and assignment changes), for
      // telling when work on a task began. See record_wrike_webhook_events.
      author_id: evt.eventAuthorId || null,
      status: evt.status || null,
      custom_status_id: evt.customStatusId || null,
      old_custom_status_id: evt.oldCustomStatusId || null,
      user_ids: evt.addedResponsibles || evt.removedResponsibles || null,
    }));

  // Acknowledge first, write after. Wrike counts a slow delivery as a failure,
  // and enough failures suspend the webhook account-wide until an admin
  // re-registers it. The signature is already verified, so the write can safely
  // run after the response, via waitUntil.
  ctx.waitUntil(insertWebhookEvents(env, rows));

  return json({ ok: true });
}

async function handleProxy(request, url, env, ctx) {
  const cookies = parseCookies(request);
  const session = cookies[SESSION_COOKIE];
  if (!session) return json({ error: "not_connected" }, { status: 401 });

  let row;
  try {
    row = await getTokenRowBySession(env, session);
  } catch (err) {
    // Transient: tell the caller to retry, not that the member is disconnected.
    console.error("[proxy] token lookup unavailable:", err.message);
    return json({ error: "backend_unavailable" }, { status: 503 });
  }
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
    row = await refreshTokenRow(env, row, ctx);
  };

  // Proactive refresh when the token is about to expire by the clock.
  if (new Date(row.expires_at).getTime() - Date.now() < 60_000) {
    try {
      await refreshToken();
    } catch (err) {
      console.error("[proxy] proactive refresh failed", err);
      // Only Wrike rejecting the credentials means reconnect. Anything else is
      // temporary, and a 401 for it would sign the member out over nothing.
      if (err instanceof WrikeAuthInvalid) {
        return json({ error: "token_refresh_failed" }, { status: 401 });
      }
      return json({ error: "backend_unavailable" }, { status: 503 });
    }
  }

  let wrikeRes = await callWrike();

  // Reactive refresh: Wrike can invalidate a token before its expiry time. Refresh
  // once and retry; if the refresh token is dead too, the retry 401s and the
  // member must reconnect.
  if (wrikeRes.status === 401) {
    try {
      await refreshToken();
      wrikeRes = await callWrike();
    } catch (err) {
      console.error("[proxy] refresh-on-401 failed", err);
    }
  }

  if (!wrikeRes.ok) {
    // Log Wrike's error body so failures are visible in the Worker logs.
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
// AUTH is a shared header key, not a session: a CEP panel has none, and its
// origin is `null`. That's acceptable ONLY because this is read-only and returns
// what any studio member can already see in Wrike. The panel never sees a Wrike
// token (those can write and carry a person's identity).
//
// Filtering by member happens here to keep the payload small. It's a
// convenience, not a security boundary.
//
// Reads the cache, not Wrike: one Supabase query, no Wrike API budget.
// `status` only ever holds the base status (Active, Completed, Deferred,
// Cancelled); custom names like "In Progress" are behind customStatusId.
const PANEL_ACTIVE_STATUSES = ["Active", "Deferred"];

// Whose name wins when the panel's member name matches more than one person.
const PANEL_PREFERRED_DEPARTMENT = "Motion";

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

// A usable Wrike token for the panel routes, which have only the shared key:
// the freshest connected member's, refreshed through refreshTokenRow when
// needed. Only used for account-level reads that return the same thing for
// anyone. Returns null rather than throwing; callers fall back to the cache.
async function panelWrikeToken(env) {
  const rowsRes = await sbFetch(
    env,
    "/wrike_oauth_tokens?select=*&order=expires_at.desc&limit=1"
  );
  if (!rowsRes.ok) return null;
  const tokenRows = await rowsRes.json();
  let row = tokenRows && tokenRows[0];
  if (!row) return null;
  if (new Date(row.expires_at).getTime() - Date.now() < 60_000) {
    // Through refreshTokenRow, so it can't race that member's own browser session.
    row = await refreshTokenRow(env, row);
  }
  return row;
}

// Custom status NAMES ("Render review", "On hold") aren't in the task cache; they
// come from /workflows, as the website's statusNameMap does. Without them every
// subtask showed as "Active" in the panel.
//
// Cached in module scope with a long TTL (workflows almost never change), so the
// feed stays at one Supabase query. Any member's token will do for this
// account-level read. NEVER THROWS: on failure returns {} and callers show the
// base status.
let panelStatusMapCache = { at: 0, map: null };
const PANEL_STATUS_MAP_TTL = 60 * 60 * 1000;

async function panelStatusNameMap(env) {
  if (panelStatusMapCache.map && Date.now() - panelStatusMapCache.at < PANEL_STATUS_MAP_TTL) {
    return panelStatusMapCache.map;
  }
  try {
    const row = await panelWrikeToken(env);
    if (!row) return {};

    const wfRes = await fetch(`https://${row.api_host}/api/v4/workflows`, {
      headers: { Authorization: `Bearer ${row.access_token}` },
    });
    if (!wfRes.ok) return {};
    const body = await wfRes.json();
    const map = {};
    for (const wf of body.data || []) {
      for (const cs of wf.customStatuses || []) {
        if (cs && cs.id) map[cs.id] = cs.name || "";
      }
    }
    panelStatusMapCache = { at: Date.now(), map };
    return map;
  } catch (err) {
    console.error("[panel/jobs] workflows lookup failed:", err);
    return {};
  }
}

// LIVE FETCH for the panel's refresh button (?refresh=1). The cache is only as
// current as the last time someone had the Motion board open. User-triggered
// only, so a normal panel open still costs no Wrike budget.
//
// Does NOT write to wrike_tasks_cache: the cache holds enriched tasks, and raw
// Wrike rows would replace them with thinner data under the website.
//
// Same query as the board (useBoardTasks.js), including the dueDate
// format without a trailing "Z". superTaskIds is also requested so subtasks
// can be dropped instead of appearing twice.
const PANEL_LIVE_FIELDS = "[customFields,parentIds,responsibleIds,subTaskIds,superTaskIds,description]";

function panelWrikeDate(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Subtasks by id, straight from Wrike, in chunks of 100 (Wrike's limit).
// Returns [] on failure so the caller falls back to the cache.
async function panelLiveSubtasks(env, ids) {
  const row = await panelWrikeToken(env);
  if (!row || !ids.length) return [];
  const unique = [...new Set(ids.map(String))].slice(0, 400);
  const out = [];
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100).join(",");
    try {
      // NO fields= ON A BY-ID REQUEST: Wrike returns these fields by default and 400s
      // when they're named (see useWrikeCache.js).
      const res = await fetch(`https://${row.api_host}/api/v4/tasks/${chunk}`, {
        headers: { Authorization: `Bearer ${row.access_token}` },
      });
      if (!res.ok) {
        // Return what we have so far rather than discarding earlier chunks.
        console.warn("[panel/jobs] live subtask fetch failed", res.status);
        return out;
      }
      const body = await res.json();
      for (const t of body.data || []) {
        out.push({
          id: t.id,
          task_data: { ...t, dueDate: t.dueDate || (t.dates && t.dates.due) || "No Due Date" },
        });
      }
    } catch (err) {
      console.warn("[panel/jobs] live subtask fetch threw", err);
      return out;
    }
  }
  return out;
}

async function panelLiveTasks(env, teamIds) {
  const row = await panelWrikeToken(env);
  if (!row || !teamIds.length) return null;

  // End of TOMORROW, matching the two-window filter the cached path uses.
  const end = new Date();
  end.setDate(end.getDate() + 1);
  end.setHours(23, 59, 59, 0);

  const dueDate = encodeURIComponent(JSON.stringify({ end: panelWrikeDate(end) }));
  const responsibles = encodeURIComponent(JSON.stringify(teamIds));
  const fields = encodeURIComponent(PANEL_LIVE_FIELDS);

  let out = [];
  let nextPageToken = null;
  // Bounded, so a runaway pager can't spend the Wrike budget.
  for (let page = 0; page < 10; page++) {
    const qs = nextPageToken
      ? `nextPageToken=${nextPageToken}`
      : `status=Active&dueDate=${dueDate}&responsibles=${responsibles}&fields=${fields}&pageSize=1000`;
    const res = await fetch(`https://${row.api_host}/api/v4/tasks?${qs}`, {
      headers: { Authorization: `Bearer ${row.access_token}` },
    });
    if (!res.ok) {
      console.warn("[panel/jobs] live fetch failed", res.status, await res.text().catch(() => ""));
      return out.length ? out : null;
    }
    const body = await res.json();
    out = out.concat(body.data || []);
    nextPageToken = body.nextPageToken || null;
    if (!nextPageToken) break;
  }
  return out;
}

// ── /api/panel/comment ───────────────────────────────────────────────────────
// A job's latest Wrike comments, for the XYi panel. Amends are written on the
// PARENT task as one comment listing deliverables, each with its note; the panel
// puts each note on its deliverable's row.
//
// One Wrike call (GET /tasks/{id}/comments), cached per task for
// PANEL_COMMENT_TTL; `fresh=1` bypasses the cache. Author names come from
// `profiles`. The task id must look like a Wrike id before it goes into a URL.
// Plain text only.
const PANEL_COMMENT_TTL = 3 * 60 * 1000;
const PANEL_COMMENT_RECENT = 8;
const panelCommentCache = new Map();

function panelPlainText(s) {
  return String(s || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\r\n?/g, "\n")
    .trim();
}

async function handlePanelComment(request, url, env) {
  if (!env.PANEL_KEY || request.headers.get("X-Panel-Key") !== env.PANEL_KEY) {
    return json({ error: "unauthorized" }, { status: 401, headers: panelCors() });
  }
  const task = (url.searchParams.get("task") || "").trim();
  // Wrike ids are mixed case and may include _ or - (MAAAAAEQLrrJ, MAAAAABrMQm_).
  if (!/^[A-Za-z0-9_-]{4,40}$/.test(task)) {
    return json({ error: "bad_task" }, { status: 400, headers: panelCors() });
  }
  const fresh = url.searchParams.get("fresh") === "1";
  const hit = panelCommentCache.get(task);
  if (!fresh && hit && Date.now() - hit.at < PANEL_COMMENT_TTL) {
    return json(hit.body, { headers: panelCors({ "Cache-Control": "no-store" }) });
  }

  const row = await panelWrikeToken(env);
  if (!row) return json({ error: "no_wrike_token" }, { status: 502, headers: panelCors() });
  let comments = [];
  try {
    const res = await fetch(`https://${row.api_host}/api/v4/tasks/${task}/comments?plainText=true`, {
      headers: { Authorization: `Bearer ${row.access_token}` },
    });
    if (!res.ok) {
      console.warn("[panel/comment] wrike", res.status, await res.text().catch(() => ""));
      return json({ error: `wrike_${res.status}` }, { status: 502, headers: panelCors() });
    }
    comments = ((await res.json()) || {}).data || [];
  } catch (err) {
    console.error("[panel/comment] fetch threw", err);
    return json({ error: "wrike_unreachable" }, { status: 502, headers: panelCors() });
  }

  // The newest few, not just the newest: the amends aren't always last (a hand-off
  // can follow them). The panel picks the newest one shaped like amends;
  // `comment` stays the newest.
  const recent = comments
    .filter((c) => c && panelPlainText(c.text))
    .sort((a, b) => new Date(b.createdDate || 0) - new Date(a.createdDate || 0))
    .slice(0, PANEL_COMMENT_RECENT);
  const names = {};
  const authorIds = [...new Set(recent.map((c) => c.authorId).filter((id) => /^[A-Za-z0-9_-]{2,40}$/.test(String(id || ""))))];
  if (authorIds.length) {
    try {
      const pr = await sbFetch(env, `/profiles?select=wrike_user_id,first_name,last_name&wrike_user_id=in.(${authorIds.map(encodeURIComponent).join(",")})`);
      if (pr.ok) {
        for (const p of (await pr.json()) || []) {
          if (p && p.wrike_user_id) names[p.wrike_user_id] = `${p.first_name || ""} ${p.last_name || ""}`.trim();
        }
      }
    } catch (_) { /* nameless is fine */ }
  }
  const shaped = recent.map((c) => ({ text: panelPlainText(c.text), author: names[c.authorId] || "", date: c.createdDate || "" }));
  const body = { task, count: comments.length, comment: shaped[0] || null, recent: shaped };
  panelCommentCache.set(task, { at: Date.now(), body });
  return json(body, { headers: panelCors({ "Cache-Control": "no-store" }) });
}

async function handlePanelJobs(request, url, env) {
  if (!env.PANEL_KEY || request.headers.get("X-Panel-Key") !== env.PANEL_KEY) {
    return json({ error: "unauthorized" }, { status: 401, headers: panelCors() });
  }

  // Resolve the member name the panel sent to a Wrike user id.
  const member = (url.searchParams.get("member") || "").trim();
  let wrikeUserId = "";
  if (member) {
    // Ordered and ranked, because `profiles` can hold more than one row per person;
    // taking whichever came first resolved names to the wrong user.
    const profRes = await sbFetch(
      env,
      // select=* so left_at is included once that column exists.
      "/profiles?select=*&order=updated_at.desc"
    );
    if (profRes.ok) {
      const profiles = (await profRes.json()) || [];
      const wanted = member.trim().toLowerCase();
      // Best match wins: exact full name, then first name, then surname (the panel
      // usually tags machines by first name, but some people go by surname).
      const score = (p) => {
        const first = (p.first_name || "").trim().toLowerCase();
        const last = (p.last_name || "").trim().toLowerCase();
        const full = (first + " " + last).trim();
        if (full === wanted) return 3;
        if (first === wanted) return 2;
        if (last === wanted) return 1;
        return 0;
      };
      // The panel is the Motion team's After Effects tool, so on a tie a Motion
      // member wins: "Luke" is Luke Trott, not Luke Steer in Print, whichever
      // profile was edited last. Other ties go to the most recently updated
      // row (the query's order), so the answer is deterministic.
      const preferred = (p) => (p.department === PANEL_PREFERRED_DEPARTMENT ? 1 : 0);
      let best = null;
      let bestScore = 0;
      for (const p of profiles) {
        if (!p || !p.wrike_user_id || p.left_at) continue; // leavers can't be matched
        const sc = score(p);
        if (sc > bestScore || (sc > 0 && sc === bestScore && preferred(p) > preferred(best))) {
          bestScore = sc;
          best = p;
        }
      }
      if (best) wrikeUserId = best.wrike_user_id;
    }
  }
  if (member && !wrikeUserId) {
    // Say so rather than return [], which would read as "no work".
    return json({ error: "unknown_member", member, jobs: [] }, { status: 404, headers: panelCors() });
  }

  // FILTER IN THE DATABASE: PostgREST caps responses at 1000 rows, and filtering
  // an unordered capped slice in JS lost the active jobs.
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
  let rows = await res.json();

  // ?refresh=1, the panel's refresh button: replace the cached rows with a live
  // read for the whole team, then apply the same filters below, so refreshed and
  // cached answers follow the same rules. Falls back to the cached rows if the
  // live read fails.
  let liveUsed = false;
  if (url.searchParams.get("refresh") === "1") {
    const teamIds = [];
    const teamRes = await sbFetch(env, "/profiles?select=*");
    if (teamRes.ok) {
      for (const p of (await teamRes.json()) || []) {
        if (p && p.wrike_user_id && !p.left_at) teamIds.push(p.wrike_user_id);
      }
    }
    const live = await panelLiveTasks(env, teamIds);
    if (live && live.length) {
      // Flatten dates.due -> dueDate: cached tasks are already enriched that way, raw
      // Wrike tasks aren't, and isBoardTask reads dueDate. Only the fields the filters
      // read are normalised.
      rows = live.map((t) => ({
        id: t.id,
        task_data: {
          ...t,
          dueDate: t.dueDate || (t.dates && t.dates.due) || "No Due Date",
        },
      }));
      liveUsed = true;
    }
  }

  // One lookup per request, served from the module cache almost every time.
  const statusNames = await panelStatusNameMap(env);
  const customName = (t) => (t && t.customStatusId ? statusNames[t.customStatusId] || "" : "");

  // Subtask names live in rows the filters exclude (a subtask can be Completed
  // under an Active parent), so look them up by id. Only for jobs that survive the
  // filter, so cached and refreshed paths ask for the same few ids.
  const panelKeeps = (t) => {
    if (!t || !t.title) return false;
    if (!isBoardTask(t, "Today") && !isBoardTask(t, "Tomorrow")) return false;
    if (isStale(t.dueDate)) return false;
    if ((t.superTaskIds || []).length > 0) return false;
    if (wrikeUserId && !(t.responsibleIds || []).includes(wrikeUserId)) return false;
    const st = t.status || "";
    if (st && !PANEL_ACTIVE_STATUSES.includes(st)) return false;
    return true;
  };
  const keptRows = (rows || []).filter((row) => panelKeeps(row?.task_data));

  const wantedSubIds = [];
  for (const row of keptRows) {
    for (const id of row?.task_data?.subTaskIds || []) wantedSubIds.push(String(id));
  }
  let subRows = [];
  let subCacheError = null;
  let subLiveError = null;
  if (wantedSubIds.length) {
    // Cache first, then overlay live rows, so the worst case is cached names, never
    // blank ones.
    const ids = wantedSubIds.slice(0, 400).map((i) => `"${i}"`).join(",");
    const subRes = await sbFetch(env, `/wrike_tasks_cache?select=id,task_data&id=in.(${ids})`);
    if (subRes.ok) {
      subRows = await subRes.json();
    } else {
      // Record the failure so a failed lookup isn't mistaken for no subtasks.
      subCacheError = `${subRes.status} ${(await subRes.text().catch(() => "")).slice(0, 120)}`;
      console.error("[panel/jobs] subtask cache query failed:", subCacheError);
    }

    // Match what TimeHub shows: on a normal load, fetch live only the subtask ids
    // the cache can't name (usually none, so no Wrike call); on a refresh, all of them.
    const cachedNames = new Set(
      (subRows || []).filter((r) => r && r.task_data && r.task_data.title).map((r) => String(r.id))
    );
    const missingSubIds = wantedSubIds.filter((id) => !cachedNames.has(String(id)));
    const liveSubIds = liveUsed ? wantedSubIds : missingSubIds;
    if (liveSubIds.length) {
      // Only live rows with a title overlay the cached copy.
      const live = await panelLiveSubtasks(env, liveSubIds);
      for (const row of live) {
        if (row && row.task_data && row.task_data.title) subRows.push(row);
      }
      // Fewer subtasks back than asked for: surface it.
      if (live.length < liveSubIds.length) {
        subLiveError = `live returned ${live.length} of ${liveSubIds.length}`;
      }
    }
  }

  // Subtask names come from the cache rows (it holds subtasks too), so no extra
  // query. An uncached subtask gets an empty name rather than an invented one.
  const byId = new Map();
  for (const row of [...(rows || []), ...(subRows || [])]) {
    if (row?.id && row?.task_data) byId.set(String(row.id), row.task_data);
  }

  // ?debug=1: counts at each filter stage, key-gated, titles only.
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
      // End of TOMORROW, matching the real route's window, so the diagnostic agrees
      // with what it diagnoses.
      const dueCutoff = new Date(new Date().setHours(23, 59, 59, 999));
      dueCutoff.setDate(dueCutoff.getDate() + 1);
      const dueOk = hasDue && !isNaN(new Date(t.dueDate).getTime()) && new Date(t.dueDate) <= dueCutoff;
      if (isMine && isTop && hasDue) withDueDate++;
      if (isMine && isTop && dueOk) active++;
    }
    return json({
      member, wrikeUserId,
      cacheRows: (rows || []).length,
      wantedSubIds: wantedSubIds.length,
      subRowsFetched: (subRows || []).length,
      // Separate, because a healthy total could hide one source returning nothing.
      subCacheError,
      subLiveError,
      keptRows: keptRows.length,
      subtaskNamesMissing: keptRows.reduce((n, row) => {
        const t = row?.task_data || {};
        return n + (t.subTaskIds || []).filter((id) => !byId.get(String(id))?.title).length;
      }, 0),
      withTitle, hasResponsibleIds: hasResponsible,
      topLevel, assignedToMember: mine, assignedWithDueDate: withDueDate, passingAllFilters: active,
      statusesSeen: seenStatuses,
      // Everything assigned to them, INCLUDING what the filters drop, with the
      // reason visible (sub = dropped as a subtask).
      assigned: mineTitles.slice(0, 40),
    }, { headers: panelCors() });
  }

  // Selection uses src/lib/jobFilter.js's isBoardTask(), the same code the board
  // uses, not a copy of its rules (they're subtler than they look: "Today" means
  // due today or overdue).

  const jobs = [];
  for (const row of keptRows) {
    // Already filtered by panelKeeps above. Not repeated, so the subtask lookup
    // and this loop can't disagree about which jobs exist.
    const t = row.task_data;
    const status = t.status || "";

    jobs.push({
      id: String(row.id),
      title: String(t.title),
      // The panel filters on this, so send the name it tagged the machine
      // with rather than a Wrike id it has no way to interpret.
      assignee: member,
      // customStatusName is the human status the board displays ("on hold",
      // "retouch", "to amend"); `status` is only ever the base Active/Completed.
      status: customName(t) || t.customStatusName || status,
      due_date: t.dueDate || "",
      updated_at: t.updatedDate || "",
      permalink: t.permalink || "",
      subtasks: (t.subTaskIds || []).map((id) => {
        const sub = byId.get(String(id));
        return {
          id: String(id),
          name: sub?.title || "",
          // Wrike's status group (Active/Completed/Deferred/Cancelled), kept as-is.
          status: sub?.status || "",
          // The custom workflow status the board shows ("Delivering", "Backlog"), which
          // the panel needs to tell a batch waiting for localisation from one in flight.
          // From the same cached task_data, so no extra query.
          customStatusName: customName(sub) || sub?.customStatusName || "",
        };
      }),
      subtask_count: (t.subTaskIds || []).length,
      subtasks_done: (t.subTaskIds || []).filter((id) => {
        const sub = byId.get(String(id));
        return sub && (sub.status === "Completed" || sub.status === "Cancelled");
      }).length,
    });
  }

  // Freshest first: most jobs have no due date, so updated is the useful order.
  jobs.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));

  // The response stays a bare array (changing its shape would break the panel),
  // so diagnostics go in headers. X-Panel-Build is a hand-bumped marker for "is my
  // fix deployed?". Bump it with any change here.
  return json(jobs, {
    headers: panelCors({
      "X-Panel-Live": liveUsed ? "1" : "0",
      "X-Panel-Build": "2026-08-13-kept-rows-6",
    }),
  });
}
