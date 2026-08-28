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

// How long one attempt may take before it is abandoned.
//
// Nothing in this app used to time out. `signal` existed on fetchRetrying and
// no caller ever passed one, so a request that simply never answered hung for
// ever — and every one of those surfaced to the user as a spinner that span
// until they gave up, with no error and nothing in the console. A stalled
// database three layers away and a dead Wrike endpoint looked identical, and
// both looked like the app was broken.
//
// Cloudflare cuts a Worker request off at 30s, so anything past that is never
// coming back regardless.
const DEFAULT_TIMEOUT_MS = 20_000;

// One attempt's signal: the caller's cancellation and our deadline, combined.
// Written by hand rather than with AbortSignal.any so this keeps working on
// runtimes that predate it.
function withDeadline(signal, timeoutMs) {
  if (!timeoutMs) return { signal, cleanup: () => {} };
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  const timer = setTimeout(() => {
    const err = new Error(`timed out after ${timeoutMs}ms`);
    err.name = "TimeoutError";
    controller.abort(err);
  }, timeoutMs);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener?.("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
    },
  };
}

/**
 * fetch() that waits and retries when the server says it is over budget.
 *
 * Honours Retry-After when present — the server knows better than any backoff
 * curve we invent — and otherwise backs off exponentially from `baseDelay`.
 * Returns the last Response either way, so callers see the 429 rather than an
 * exception if it never clears.
 *
 * An attempt that does not answer within `timeoutMs` is abandoned and retried
 * like any other transient failure, and once the budget is spent it throws
 * rather than hanging. A caller that cancels deliberately is final — that is
 * not a failure to retry.
 */
export async function fetchRetrying(
  url,
  { retries = 3, baseDelay = 600, signal, timeoutMs = DEFAULT_TIMEOUT_MS, ...init } = {}
) {
  let res;
  for (let attempt = 0; ; attempt++) {
    const deadline = withDeadline(signal, timeoutMs);
    let failure = null;
    try {
      res = await fetch(url, { ...init, signal: deadline.signal });
    } catch (err) {
      failure = err;
    } finally {
      deadline.cleanup();
    }

    if (failure) {
      // The caller pulled the plug — respect it rather than retrying behind them.
      if (signal?.aborted) throw failure;
      if (attempt >= retries) {
        throw new Error(
          `Request to ${url} failed after ${attempt + 1} attempt(s): ${failure.message}`
        );
      }
      await sleep(baseDelay * 2 ** attempt);
      continue;
    }

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
