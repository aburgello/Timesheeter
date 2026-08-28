// Own file so the receiver's module-level config cache starts fresh: the
// re-read this exercises is rate-limited, and the sibling wrikeWebhook test
// spends that budget. See tests/run.mjs — each file is bundled separately.
//
// The trap being guarded: a Supabase outage must never turn into a Wrike
// webhook suspension. The outage is transient; the suspension isn't, since
// leaving it needs a manual admin re-register.
import worker from "../worker/index.js";

const SECRET = "secret";
const env = { SUPABASE_URL: "https://sb.test", SUPABASE_SERVICE_ROLE_KEY: "srk" };

async function sign(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

let supabaseUp = true;
globalThis.fetch = async (url) => {
  if (!supabaseUp) throw new Error("network down");
  if (url.includes("/wrike_webhook_config")) {
    return new Response(JSON.stringify([{ webhook_id: "HOOK", secret: SECRET }]), { status: 200 });
  }
  return new Response("", { status: 201 });
};

const ctx = { waitUntil: () => {} };
const body = JSON.stringify([{ taskId: "A", eventType: "TaskStatusChanged" }]);

const post = (signature) => worker.fetch(
  new Request("https://x.test/api/wrike/webhook", {
    method: "POST", headers: { "X-Hook-Signature": signature }, body,
  }),
  env, ctx
);

// Warm the cache while Supabase is healthy.
const warm = await post(await sign(SECRET, body));
check("outage: healthy delivery is accepted first", warm.status, 200);

// Now Supabase goes away, and a delivery arrives that doesn't match the cached
// secret — so the receiver tries to re-read, and that read fails. It must not
// answer with a status Wrike reads as a broken endpoint.
supabaseUp = false;
const during = await post("deadbeef");
check("outage: a failed config re-read acknowledges instead of erroring", during.status, 200);
const parsed = await during.json();
check("outage: ...and says why it dropped the delivery", parsed.dropped, "config_unavailable");
