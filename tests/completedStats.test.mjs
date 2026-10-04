// Profile's completed-task counts (src/lib/completedStats.js): only this
// year's tasks are fetched day to day; earlier years come from a saved total
// made by one full download per year.
import { countCompleted, completedStats } from "../src/lib/completedStats.js";

const NOW = new Date("2026-10-04T12:00:00");
const task = (completedDate) => ({ id: completedDate, completedDate });
const ALL = [
  task("2026-10-01T10:00:00Z"), // last 30 days, this year
  task("2026-06-01T10:00:00Z"), // this year
  task("2025-05-01T10:00:00Z"), // earlier
  task("2024-03-01T10:00:00Z"), // earlier
];

function fakeWrike({ refuseFilter = false } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const filtered = url.includes("completedDate=");
    if (filtered && refuseFilter) return { ok: false, status: 400, json: async () => ({}) };
    let data = ALL;
    if (filtered) {
      const since = JSON.parse(decodeURIComponent(url.split("completedDate=")[1])).start;
      data = ALL.filter((t) => t.completedDate >= since);
    }
    return { ok: true, status: 200, json: async () => ({ data }) };
  };
  return { fetchImpl, calls };
}

check("counts: month, year and earlier", countCompleted(ALL, NOW), { month: 1, year: 2, earlier: 2 });

// First run: one full download, which also saves the earlier-years total.
{
  const { fetchImpl, calls } = fakeWrike();
  const r = await completedStats("U1", null, { now: NOW, fetchImpl });
  check("first run: counts", [r.month, r.year, r.allTime], [1, 2, 4]);
  check("first run: saves earlier years", [r.earlierTotal, r.earlierYear], [2, 2026]);
  check("first run: one unfiltered request", calls.map((u) => u.includes("completedDate=")), [false]);
}

// Later runs: only this year is fetched, and all time adds the saved total.
{
  const { fetchImpl, calls } = fakeWrike();
  const saved = { earlierTotal: 2, earlierYear: 2026 };
  const r = await completedStats("U1", saved, { now: NOW, fetchImpl });
  check("daily: same counts", [r.month, r.year, r.allTime], [1, 2, 4]);
  check("daily: only this year is asked for", calls.length === 1 && calls[0].includes("completedDate="), true);
  const since = JSON.parse(decodeURIComponent(calls[0].split("completedDate=")[1])).start;
  check("daily: from 1 January, UTC, no milliseconds", /^2025-12-31T\d\d:00:00Z$|^2026-01-01T00:00:00Z$/.test(since), true);
}

// New Year: last year's saved total is stale, so one full download again.
{
  const { fetchImpl, calls } = fakeWrike();
  await completedStats("U1", { earlierTotal: 1, earlierYear: 2025 }, { now: NOW, fetchImpl });
  check("new year: full download", calls.map((u) => u.includes("completedDate=")), [false]);
}

// In January the month window reaches into last year.
{
  const jan = new Date("2026-01-10T12:00:00");
  const { fetchImpl, calls } = fakeWrike();
  await completedStats("U1", { earlierTotal: 2, earlierYear: 2026 }, { now: jan, fetchImpl });
  const since = JSON.parse(decodeURIComponent(calls[0].split("completedDate=")[1])).start;
  check("january: window starts in December", since.startsWith("2025-12"), true);
}

// Wrike refuses the filter: the full download is used, counts still right.
{
  const { fetchImpl, calls } = fakeWrike({ refuseFilter: true });
  const r = await completedStats("U1", { earlierTotal: 2, earlierYear: 2026 }, { now: NOW, fetchImpl });
  check("refused filter: falls back to the full download", [r.month, r.year, r.allTime], [1, 2, 4]);
  check("refused filter: two requests", calls.length, 2);
}

// A failed page is an error, not a zero count.
{
  let threw = false;
  try {
    await completedStats("U1", null, { now: NOW, fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
  } catch { threw = true; }
  check("failure: throws rather than counting zero", threw, true);
}
