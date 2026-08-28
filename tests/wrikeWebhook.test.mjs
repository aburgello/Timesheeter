// Guards the Wrike webhook receiver's delivery-timeout contract.
//
// Wrike counts a slow delivery as a failed one, and enough consecutive
// failures suspend the webhook for the WHOLE account until an admin manually
// re-registers. So the receiver must answer before it does any Supabase work,
// and must never answer 401 to a genuine delivery just because its cached
// secret went stale behind a re-register.
import worker from "../worker/index.js";

const SECRET_OLD = "secret-old";
const SECRET_NEW = "secret-new";

const env = { SUPABASE_URL: "https://sb.test", SUPABASE_SERVICE_ROLE_KEY: "srk" };

async function sign(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Stub Supabase. `currentSecret` is what a config read returns; `insertGate` is
// a promise the insert waits on, so a test can prove the response landed while
// the write was still outstanding.
let currentSecret = SECRET_OLD;
let insertGate = null;
let inserts = [];
let configReads = 0;

globalThis.fetch = async (url, opts = {}) => {
  if (url.includes("/wrike_webhook_config")) {
    configReads++;
    return new Response(JSON.stringify([{ webhook_id: "HOOK", secret: currentSecret }]), { status: 200 });
  }
  if (url.includes("/wrike_webhook_events")) {
    if (insertGate) await insertGate;
    inserts.push(JSON.parse(opts.body));
    return new Response("", { status: 201 });
  }
  throw new Error(`unexpected fetch: ${url}`);
};

// Collects what waitUntil was handed so a test can await it deliberately.
function makeCtx() {
  const pending = [];
  return { waitUntil: (p) => pending.push(p), pending };
}

async function deliver(body, secret, ctx) {
  const raw = JSON.stringify(body);
  const req = new Request("https://x.test/api/wrike/webhook", {
    method: "POST",
    headers: { "X-Hook-Signature": await sign(secret, raw) },
    body: raw,
  });
  return worker.fetch(req, env, ctx);
}

const evt = (id) => ({ taskId: id, eventType: "TaskStatusChanged", lastUpdatedDate: "2026-08-27T10:00:00Z" });

// 1. The response must not wait on the Supabase write.
{
  let release;
  insertGate = new Promise((r) => { release = r; });
  const ctx = makeCtx();
  const res = await deliver([evt("A")], SECRET_OLD, ctx);
  check("acknowledges Wrike before the insert has resolved", [res.status, inserts.length], [200, 0]);
  release();
  await Promise.all(ctx.pending);
  check("the deferred insert still runs after the response", inserts.length, 1);
  insertGate = null;
}

// 2. A multi-event delivery costs one round trip, not one per event.
{
  inserts = [];
  const ctx = makeCtx();
  await deliver([evt("A"), evt("B"), evt("C")], SECRET_OLD, ctx);
  await Promise.all(ctx.pending);
  check("one batched insert for a 3-event delivery", inserts.length, 1);
  check("...carrying all three rows", inserts[0].map((r) => r.task_id), ["A", "B", "C"]);
}

// 3. Events without a taskId are dropped, and a delivery of only those writes nothing.
{
  inserts = [];
  const ctx = makeCtx();
  const res = await deliver([{ eventType: "CommentAdded" }], SECRET_OLD, ctx);
  await Promise.all(ctx.pending);
  check("a taskId-less delivery is acknowledged", res.status, 200);
  check("...and writes nothing", inserts.length, 0);
}

// 4. A re-register rotates the secret. The cached one is now stale, and
//    answering 401 here is what suspends the hook — so it must re-read instead.
{
  inserts = [];
  currentSecret = SECRET_NEW;
  const ctx = makeCtx();
  const res = await deliver([evt("D")], SECRET_NEW, ctx);
  await Promise.all(ctx.pending);
  check("a rotated secret is picked up rather than 401'd", res.status, 200);
  check("...and the event is still recorded", inserts.length, 1);
}

// 5. A genuinely forged signature is still rejected.
{
  inserts = [];
  const ctx = makeCtx();
  const res = await deliver([evt("E")], "not-the-secret", ctx);
  await Promise.all(ctx.pending);
  check("a forged signature is rejected", res.status, 401);
  check("...and writes nothing", inserts.length, 0);
}
