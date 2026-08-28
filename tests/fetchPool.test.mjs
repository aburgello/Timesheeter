import { mapPool } from "../src/lib/fetchPool.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Results come back in input order regardless of which finished first — the
// caller zips them against the input list, so order is load-bearing.
{
  const out = await mapPool([30, 5, 20, 1], 2, async (ms) => {
    await sleep(ms);
    return ms;
  });
  check("results keep input order", out, [30, 5, 20, 1]);
}

// The whole point: never more than `limit` in flight. This is what keeps the
// burst under Wrike's rate limit.
{
  let inFlight = 0;
  let peak = 0;
  await mapPool([...Array(12).keys()], 3, async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await sleep(5);
    inFlight--;
  });
  check("never exceeds the concurrency limit", peak <= 3, true);
  check("and actually uses it", peak, 3);
}

// A worker pulls the next index when it frees up rather than owning a fixed
// slice, so one slow item doesn't stall everything queued behind it.
{
  const order = [];
  await mapPool([50, 1, 1, 1], 2, async (ms, i) => {
    await sleep(ms);
    order.push(i);
  });
  check("fast items overtake a slow one", order, [1, 2, 3, 0]);
}

// One failure must not discard the results that already succeeded — the
// Promise.all this replaces threw away the whole batch.
{
  const out = await mapPool([1, 2, 3], 2, async (n) => {
    if (n === 2) return null; // caller-handled failure
    return n * 10;
  });
  check("a failed item doesn't lose the others", out, [10, null, 30]);
}

check("empty input", await mapPool([], 4, async (x) => x), []);
check("limit larger than the list", await mapPool([1, 2], 99, async (x) => x), [1, 2]);
check("limit of zero is treated as one", await mapPool([1, 2], 0, async (x) => x), [1, 2]);

// ── fetchRetrying ───────────────────────────────────────────────────────────
import { fetchRetrying } from "../src/lib/fetchPool.js";

const realFetch = globalThis.fetch;
const resp = (status, headers = {}) => ({
  status,
  ok: status < 400,
  headers: { get: (k) => headers[k] ?? null },
});

// A 429 is waited out and retried rather than surfaced as a failure.
{
  let calls = 0;
  globalThis.fetch = async () => { calls++; return calls < 3 ? resp(429) : resp(200); };
  const res = await fetchRetrying("/x", { baseDelay: 1 });
  check("retries past a 429", res.status, 200);
  check("and took the retries it needed", calls, 3);
}

// Gives up rather than looping forever, returning the 429 so the caller sees it.
{
  let calls = 0;
  globalThis.fetch = async () => { calls++; return resp(429); };
  const res = await fetchRetrying("/x", { retries: 2, baseDelay: 1 });
  check("gives up after the retry budget", res.status, 429);
  check("one initial call plus two retries", calls, 3);
}

// A normal failure must NOT be retried — a 404 will never become a 200.
{
  let calls = 0;
  globalThis.fetch = async () => { calls++; return resp(404); };
  const res = await fetchRetrying("/x", { baseDelay: 1 });
  check("a 404 is returned immediately", res.status, 404);
  check("and is not retried", calls, 1);
}

// 5xx is retried too: Wrike answers 503 under load, same problem as a 429.
{
  let calls = 0;
  globalThis.fetch = async () => { calls++; return calls < 2 ? resp(503) : resp(200); };
  const res = await fetchRetrying("/x", { baseDelay: 1 });
  check("retries a 503", res.status, 200);
}

// The bug the scan tests caught: a stub response with no status must be handed
// straight back. `undefined < 500` is false, so the old check sent it down the
// retry path and crashed reaching for headers it didn't have.
{
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: [] }) });
  const res = await fetchRetrying("/x", { baseDelay: 1 });
  check("a response without a status is passed through", res.ok, true);
}

// ── timeouts ────────────────────────────────────────────────────────────────
// The bug behind every "it just spins forever": no request had a deadline, so
// one that never answered was waited on indefinitely and the UI had no failure
// path to take.

// A fetch that never settles is abandoned and retried, then reported.
{
  let calls = 0;
  globalThis.fetch = (url, { signal } = {}) => {
    calls++;
    return new Promise((_, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  let thrown = null;
  try {
    await fetchRetrying("/hangs", { retries: 1, baseDelay: 1, timeoutMs: 20 });
  } catch (err) {
    thrown = err;
  }
  check("a request that never answers throws instead of hanging", !!thrown, true);
  check("...naming the url so the failure is diagnosable", thrown.message.includes("/hangs"), true);
  check("...after using its retry budget", calls, 2);
}

// A stall on the first attempt recovers on the second.
{
  let calls = 0;
  globalThis.fetch = (url, { signal } = {}) => {
    calls++;
    if (calls === 1) {
      return new Promise((_, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    return Promise.resolve(resp(200));
  };
  const res = await fetchRetrying("/x", { baseDelay: 1, timeoutMs: 20 });
  check("a stalled attempt is retried rather than fatal", res.status, 200);
  check("...on the second attempt", calls, 2);
}

// A caller cancelling deliberately is final — retrying behind them would defeat
// the cancellation.
{
  let calls = 0;
  globalThis.fetch = (url, { signal } = {}) => {
    calls++;
    return new Promise((_, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  const ac = new AbortController();
  const p = fetchRetrying("/x", { baseDelay: 1, timeoutMs: 5000, signal: ac.signal });
  ac.abort(new Error("caller cancelled"));
  let thrown = null;
  try { await p; } catch (err) { thrown = err; }
  check("a caller's cancel propagates", !!thrown, true);
  check("...and is not retried", calls, 1);
}

// A successful request must not be delayed or altered by the deadline wiring.
{
  globalThis.fetch = async () => resp(200);
  const res = await fetchRetrying("/x", { baseDelay: 1 });
  check("the happy path is untouched", res.status, 200);
}

globalThis.fetch = realFetch;
