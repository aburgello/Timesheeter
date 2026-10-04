// The Profile's completed-task counts: last 30 days, this year, and all time.
//
// Only this year's completed tasks are fetched from Wrike (completedDate
// filter). All time is this year plus a saved total for earlier years, which
// needs one full download per person per year: when it's first needed, and
// again after New Year. If Wrike refuses the date filter, the full download is
// used instead, so the counts still come out.

const DAY_MS = 24 * 60 * 60 * 1000;

// When a task was completed. Older tasks can lack completedDate; the other
// dates are the closest stand-ins.
const completionTime = (task) =>
  new Date(task.completedDate || task.updatedDate || task.createdDate || 0).getTime();

const startOfYear = (now) => new Date(now.getFullYear(), 0, 1).getTime();

export function countCompleted(tasks, now = new Date()) {
  const monthFrom = now.getTime() - 30 * DAY_MS;
  const yearFrom = startOfYear(now);
  let month = 0, year = 0, earlier = 0;
  for (const t of tasks) {
    const at = completionTime(t);
    if (at >= monthFrom) month++;
    if (at >= yearFrom) year++;
    else earlier++;
  }
  return { month, year, earlier };
}

// Every completed task assigned to `uid`, optionally only those completed since
// `sinceIso`. Throws on any failed page rather than counting a partial list.
export async function fetchCompletedTasks(uid, { sinceIso = null, fetchImpl = fetch } = {}) {
  const filter = sinceIso ? `&completedDate=${encodeURIComponent(JSON.stringify({ start: sinceIso }))}` : "";
  let url = `/api/wrike/tasks?responsibles=[${uid}]&status=Completed&pageSize=1000${filter}`;
  const tasks = [];
  while (url) {
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`Wrike completed tasks: HTTP ${res.status}`);
    const json = await res.json();
    tasks.push(...(json.data || []));
    url = json.nextPageToken ? `/api/wrike/tasks?nextPageToken=${json.nextPageToken}` : null;
  }
  return tasks;
}

// The three counts. `saved` is what this returned last time (it carries
// earlierTotal/earlierYear); the result is to be saved for next time.
export async function completedStats(uid, saved = null, { now = new Date(), fetchImpl = fetch } = {}) {
  const thisYear = now.getFullYear();

  const fullDownload = async () => {
    const counts = countCompleted(await fetchCompletedTasks(uid, { fetchImpl }), now);
    return {
      month: counts.month,
      year: counts.year,
      allTime: counts.year + counts.earlier,
      earlierTotal: counts.earlier,
      earlierYear: thisYear,
    };
  };

  // Earlier years' total is missing or from last year: one full download.
  if (!saved || saved.earlierYear !== thisYear || typeof saved.earlierTotal !== "number") {
    return fullDownload();
  }

  // Wrike wants a UTC timestamp with a trailing Z and no milliseconds. The
  // window reaches back 30 days in January, so the month count stays right.
  const from = Math.min(startOfYear(now), now.getTime() - 30 * DAY_MS);
  const sinceIso = new Date(from).toISOString().split(".")[0] + "Z";
  let recent;
  try {
    recent = await fetchCompletedTasks(uid, { sinceIso, fetchImpl });
  } catch {
    return fullDownload();
  }
  const counts = countCompleted(recent, now);
  return {
    month: counts.month,
    year: counts.year,
    allTime: saved.earlierTotal + counts.year,
    earlierTotal: saved.earlierTotal,
    earlierYear: thisYear,
  };
}
