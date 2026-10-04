// Bounded-concurrency fetching for the Wrike proxy.
//
// Wrike's rate limit is per account and the proxy passes 429s straight through,
// so firing every request at once gets most of them refused and starves
// everything else in flight. Two fixes, both needed: cap how many requests are
// in flight, and retry a 429 when someone else has spent the budget.

/**
 * Map `fn` over `items` with at most `limit` calls in flight.
 * Results keep the input order. Never rejects on one item (`fn` handles its own
 * errors), so one failure can't throw away the results that succeeded.
 */
export async function mapPool(items, limit, fn) {
  const list = [...items];
  const results = new Array(list.length);
  const width = Math.max(1, Math.min(limit, list.length));
  let next = 0;

  // Workers pull the next index, so one slow request doesn't hold up a fixed share.
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

// How long one attempt may take before it's abandoned. Without a timeout a
// request that never answers is an endless spinner with no error. Cloudflare
// cuts Worker requests off at 30s anyway.
const DEFAULT_TIMEOUT_MS = 20_000;

// The caller's cancellation and our deadline combined. Hand-written rather than
// AbortSignal.any so it works on older runtimes.
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
 * fetch() that waits and retries when the server is over budget (429 or 5xx).
 *
 * Honours Retry-After, otherwise backs off exponentially from `baseDelay`.
 * Returns the last Response if it never clears, so callers see the 429.
 * An attempt slower than `timeoutMs` is retried like any transient failure, and
 * throws once retries run out. A caller's own cancel is final.
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
      if (signal?.aborted) throw failure;
      if (attempt >= retries) {
        throw new Error(
          `Request to ${url} failed after ${attempt + 1} attempt(s): ${failure.message}`
        );
      }
      await sleep(baseDelay * 2 ** attempt);
      continue;
    }

    // A response with no numeric status (a test double, say) is returned as-is.
    // `undefined < 500` is false, so it would otherwise be retried and crash.
    const status = Number(res?.status);
    if (!Number.isFinite(status)) return res;

    // Wrike answers 503 under load, so 5xx is retried like a 429.
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
