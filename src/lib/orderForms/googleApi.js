// Google sign-in and the Drive and Sheets reads behind Client Orders.
//
// Read-only by scope: drive.readonly lets the signed-in person's own access be
// used to read files, and nothing else. The access token is held in memory for
// this tab only, never stored, and goes to googleapis.com and nowhere else, so
// the Worker and Supabase never see it or anything it reads.

// Public by design, like the Supabase anon key: it names the app to Google and
// only works from the origins registered for it in Google Cloud.
const CLIENT_ID =
  import.meta.env.VITE_GOOGLE_CLIENT_ID ||
  "1047837005704-h04jm219u2mm5rojhpv1vo797rei5v3a.apps.googleusercontent.com";
const SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const GSI_SRC = "https://accounts.google.com/gsi/client";
const DRIVE = "https://www.googleapis.com/drive/v3";
const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";

const FOLDER = "application/vnd.google-apps.folder";
const GOOGLE_SHEET = "application/vnd.google-apps.spreadsheet";
const SHORTCUT = "application/vnd.google-apps.shortcut";
const XLSX_FILE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export const googleConfigured = () => !!CLIENT_ID;

let token = null;
let expiresAt = 0;
let gsiLoading = null;

export const googleConnected = () => !!token && Date.now() < expiresAt;

function loadGsi() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (!gsiLoading) {
    gsiLoading = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = GSI_SRC;
      script.async = true;
      script.onload = resolve;
      script.onerror = () => { gsiLoading = null; reject(new GoogleError("offline")); };
      document.head.appendChild(script);
    });
  }
  return gsiLoading;
}

// `reason` is what the page shows a message for; nothing read from a sheet is
// ever put in one of these.
export class GoogleError extends Error {
  constructor(reason, status) {
    super(reason);
    this.reason = reason;
    this.status = status;
  }
}

// Opens Google's own sign-in window. Must be called from a click, or the
// browser blocks the popup.
export async function connectGoogle() {
  if (!CLIENT_ID) throw new GoogleError("not-configured");
  await loadGsi();
  return new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      callback: (res) => {
        if (res.error || !res.access_token) return reject(new GoogleError("denied"));
        token = res.access_token;
        // A minute early, so a load never starts on a token about to lapse.
        expiresAt = Date.now() + (Number(res.expires_in) - 60) * 1000;
        resolve();
      },
      error_callback: (err) => reject(new GoogleError(err?.type === "popup_closed" ? "cancelled" : "popup")),
    });
    client.requestAccessToken();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gfetch(url, tries = 4) {
  if (!googleConnected()) throw new GoogleError("signed-out");
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.ok) return res;
  if (res.status === 401) { token = null; throw new GoogleError("signed-out", 401); }
  // Google answers 429, or 403 with a rate reason, when reads come too fast.
  const limited = res.status === 429 || (res.status === 403 && /rateLimit|quota/i.test(await res.clone().text()));
  if ((limited || res.status >= 500) && tries > 1) {
    await sleep((5 - tries) * 1500 + Math.random() * 500);
    return gfetch(url, tries - 1);
  }
  throw new GoogleError(res.status === 404 ? "not-found" : res.status === 403 ? "no-access" : "failed", res.status);
}

const query = (params) => new URLSearchParams(params).toString();
const ALL_DRIVES = { supportsAllDrives: "true", includeItemsFromAllDrives: "true" };

// ── The index workbook ────────────────────────────────────────────────────────

// Every tab's title with its header row. Only row 1 is read here.
export async function readIndexTabs(indexId) {
  const meta = await (await gfetch(`${SHEETS}/${indexId}?${query({ fields: "properties.title,sheets.properties.title" })}`)).json();
  const titles = (meta.sheets || []).map((s) => s.properties.title);
  if (!titles.length) return { title: meta.properties?.title || "", tabs: [] };
  const ranges = titles.map((t) => `ranges=${encodeURIComponent(`'${t.replace(/'/g, "''")}'!1:1`)}`).join("&");
  const data = await (await gfetch(`${SHEETS}/${indexId}/values:batchGet?${ranges}`)).json();
  return {
    title: meta.properties?.title || "",
    tabs: titles.map((title, i) => ({ title, header: data.valueRanges?.[i]?.values?.[0] || [] })),
  };
}

// Two named columns of one tab, top to bottom, without the header row. The
// caller asks for Market and Link, so the email columns are never fetched.
export async function readIndexColumns(indexId, tab, letters) {
  const quoted = `'${tab.replace(/'/g, "''")}'`;
  const ranges = letters.map((l) => `ranges=${encodeURIComponent(`${quoted}!${l}2:${l}`)}`).join("&");
  const data = await (await gfetch(`${SHEETS}/${indexId}/values:batchGet?${ranges}&majorDimension=COLUMNS`)).json();
  return letters.map((_, i) => data.valueRanges?.[i]?.values?.[0] || []);
}

// ── A market's Drive link ─────────────────────────────────────────────────────

const isSheet = (f) => f.mimeType === GOOGLE_SHEET || f.mimeType === XLSX_FILE;
const FILE_FIELDS = "id,name,mimeType,modifiedTime,webViewLink,shortcutDetails";

const followShortcut = (f) =>
  f.mimeType === SHORTCUT && f.shortcutDetails
    ? { ...f, id: f.shortcutDetails.targetId, mimeType: f.shortcutDetails.targetMimeType }
    : f;

// The spreadsheets a market's link leads to: the ones in the folder, or the
// one file if the link is a spreadsheet itself.
export async function listMarketSheets(driveId) {
  const item = followShortcut(await (await gfetch(`${DRIVE}/files/${driveId}?${query({ fields: FILE_FIELDS, supportsAllDrives: "true" })}`)).json());
  if (isSheet(item)) return [item];
  if (item.mimeType !== FOLDER) return [];

  const files = [];
  let pageToken = "";
  do {
    const page = await (await gfetch(`${DRIVE}/files?${query({
      q: `'${item.id}' in parents and trashed = false`,
      fields: `nextPageToken,files(${FILE_FIELDS})`,
      pageSize: "200",
      ...ALL_DRIVES,
      ...(pageToken ? { pageToken } : {}),
    })}`)).json();
    files.push(...(page.files || []).map(followShortcut).filter(isSheet));
    pageToken = page.nextPageToken || "";
  } while (pageToken);
  return files;
}

// A spreadsheet's bytes as .xlsx. Through Drive, not the Sheets API: one call
// a file, and Drive's limit is far higher than Sheets' 60 reads a minute.
export async function downloadSheet(file) {
  const url = file.mimeType === GOOGLE_SHEET
    ? `${DRIVE}/files/${file.id}/export?${query({ mimeType: XLSX_FILE })}`
    : `${DRIVE}/files/${file.id}?${query({ alt: "media", supportsAllDrives: "true" })}`;
  return (await gfetch(url)).arrayBuffer();
}
