// Bounded-concurrency fetching for the Wrike proxy.
//
// Wrike rate-limits per account, and the proxy passes a 429 straight through
// untouched. A `Promise.all(tasks.map(fetch))` therefore works fine while the
// list is short and collapses the moment it isn't: every request leaves at
// once, Wrike refuses most of them, and — because the budget is shared across
// the whole account — it takes down whatever else was mid-flight too. That is
// what turned a board with a few hundred assigned tasks into a wall of 429s
// that also killed the Job Book's folder scan.
//
// Two things fix it, and both are needed. A cap on how many requests are in
// flight keeps the burst under the limit; retrying a 429 handles the case where
// somebody else's traffic has already spent the budget.

/**
 * Map `fn` over `items` with at most `limit` calls in flight at once.
 * Results come back in the original order. Never rejects on an individual
 * failure — `fn` is expected to handle its own errors — so one bad item cannot
 * discard every result that already succeeded, which is what Promise.all does.
 */
export async function mapPool(items, limit, fn) {
  const list = [...items];
  const results = new Array(list.length);
  const width = Math.max(1, Math.min(limit, list.length));
  let next = 0;

  // Each worker pulls the next index rather than taking a fixed slice, so one
  // slow request doesn't hold up a whole share of the queue behind it.
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= list.length) return;
      results[i] = await fn(list[i], i);
    }
  };

  await Promise.all(Array.from({ length: width }, worker));
  return results;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch() that waits and retries when the server says it is over budget.
 *
 * Honours Retry-After when present — the server knows better than any backoff
 * curve we invent — and otherwise backs off exponentially from `baseDelay`.
 * Returns the last Response either way, so callers see the 429 rather than an
 * exception if it never clears.
 */
export async function fetchRetrying(url, { retries = 3, baseDelay = 600, signal, ...init } = {}) {
  let res;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(url, { ...init, signal });

    // A response with no numeric status isn't something to interpret — a test
    // double, or a fetch replacement returning a bare object. Hand it straight
    // back. Testing `status < 500` alone would send it down the RETRY path,
    // because `undefined < 500` is false, and then crash reaching for
    // headers it doesn't have.
    const status = Number(res?.status);
    if (!Number.isFinite(status)) return res;

    // 429 is the one worth waiting out. A 5xx gets the same treatment because
    // Wrike returns 503 under load, which is the same problem wearing a
    // different number.
    if (status !== 429 && status < 500) return res;
    if (attempt >= retries) return res;

    const header = Number(res.headers?.get?.("Retry-After"));
    const wait = Number.isFinite(header) && header > 0
      ? Math.min(header * 1000, 30_000)
      : baseDelay * 2 ** attempt;
    await sleep(wait);
    if (signal?.aborted) return res;
  }
}
