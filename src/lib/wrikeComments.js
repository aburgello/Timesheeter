// The comments YOU posted in Wrike on one day — what Wrike's Inbox shows under
// "Sent". There is no inbox endpoint; this is GET /comments, which returns
// every comment in the account in a createdDate window (7 days at most) and
// can't filter by author, so the author filter happens here.
//
// It answers at most `limit` (1000) comments per call, busiest-account-wide.
// A window that comes back full may be missing some, so it is split in two
// and each half asked again, down to a floor — past that, what came back is
// used and the result is flagged `truncated` so the screen can say so.
import { dayRangeUtc } from "../utils/commentActivity";

const LIMIT = 1000;
const MIN_WINDOW_MS = 30 * 60 * 1000;

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

async function fetchWindow(startMs, endMs) {
  const range = encodeURIComponent(JSON.stringify({ start: iso(startMs), end: iso(endMs) }));
  const res = await fetch(`/api/wrike/comments?createdDate=${range}&plainText=true&limit=${LIMIT}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.errorDescription || body.error || `Wrike answered ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  const data = json.data || [];
  if (data.length < LIMIT || endMs - startMs <= MIN_WINDOW_MS) {
    return { data, truncated: data.length >= LIMIT };
  }
  const mid = startMs + Math.floor((endMs - startMs) / 2);
  const [a, b] = await Promise.all([fetchWindow(startMs, mid), fetchWindow(mid, endMs)]);
  return { data: [...a.data, ...b.data], truncated: a.truncated || b.truncated };
}

/**
 * Your comments on the local calendar day `date`, oldest first.
 * Resolves { comments: [{ id, taskId, folderId, text, createdDate }], truncated }.
 */
export async function fetchMyCommentsForDay(date, authorId) {
  const { start, end } = dayRangeUtc(date);
  const { data, truncated } = await fetchWindow(Date.parse(start), Date.parse(end));
  const seen = new Set();
  const comments = data
    .filter((c) => c.authorId === authorId && !seen.has(c.id) && seen.add(c.id))
    .map((c) => ({
      id: c.id,
      taskId: c.taskId || null,
      folderId: c.folderId || null,
      text: (c.text || "").trim(),
      createdDate: c.createdDate,
    }))
    .sort((x, y) => Date.parse(x.createdDate) - Date.parse(y.createdDate));
  return { comments, truncated };
}
