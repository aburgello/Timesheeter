# Deploying (Wrike OAuth + Cloudflare Workers)

This app now has three moving pieces, not just a static site:

1. **The React app** (`src/`) — built by Vite, served as static assets.
2. **A Cloudflare Worker** (`worker/index.js`) — handles the Wrike OAuth
   flow and proxies all `/api/wrike/*` calls so the browser never sees a
   Wrike token.
3. **A Supabase project** — stores each user's Wrike OAuth tokens
   (`wrike_oauth_tokens` table), reachable only via a service-role key that
   lives in the Worker's secrets.

Because of this, deploying is no longer "connect the repo to Cloudflare
Pages and forget about it" — you also need a Wrike OAuth app and a Supabase
project wired up. This doc replaces the old Cloudflare Pages walkthrough.

---

## Do we need a new Cloudflare account?

Short answer: **not strictly, but recommended for the company launch.**

- Cloudflare Workers projects are just deployed *into* whichever Cloudflare
  account you connect the repo to — there's nothing in this repo tied to a
  specific existing account.
- If this is going to be the company's official tool, deploy it under a
  **company-owned Cloudflare account** (not a personal one) so nobody's
  personal login is a single point of failure for admin access, billing,
  custom domains, etc. Cloudflare's free tier covers this comfortably.
- Whoever creates that account becomes the account owner; add teammates as
  members afterwards (Cloudflare dashboard → **Manage Account** → **Members**).

---

## Part 1 — Wrike OAuth app

The Worker authenticates users against Wrike using OAuth 2.0 (authorization
code flow), so you need a Wrike app registered before anything else works.

1. In Wrike, go to **Apps & Integrations** → **API** → create a new app
   (or reuse the existing one if you're just redeploying the same app to a
   new domain).
2. Note the **Client ID** and **Client Secret** it gives you.
3. Set the **Redirect URI** to:
   ```
   https://<your-deployed-domain>/api/wrike/oauth/callback
   ```
   Replace `<your-deployed-domain>` with the real domain once you know it
   (e.g. `timehub.xyidesign.com` or the `*.workers.dev` URL Cloudflare
   assigns on first deploy). You can add multiple redirect URIs to the same
   Wrike app if you need to support both a preview and production domain.

If you're moving this from one Cloudflare account/domain to another, you
either need to add the new domain's callback URL to the **existing** Wrike
app, or register a new one — an old app's redirect URI won't accept
callbacks from a domain it doesn't know about.

---

## Part 2 — Supabase project

1. Create a Supabase project (or use an existing one your company owns —
   don't keep using someone's personal Supabase project for production).
2. Create the tokens table the Worker expects. There's no migration file
   committed yet, so run this manually in the Supabase SQL editor:

   ```sql
   create table wrike_oauth_tokens (
     wrike_user_id text primary key,
     session_token text unique not null,
     access_token text not null,
     refresh_token text not null,
     api_host text not null,
     expires_at timestamptz not null,
     updated_at timestamptz not null default now()
   );

   alter table wrike_oauth_tokens enable row level security;
   -- No policies are added on purpose: the Worker talks to this table only
   -- with the service-role key, which bypasses RLS. The anon/authenticated
   -- keys used by the browser should never be able to read this table.
   ```

3. From **Project Settings → API**, note:
   - **Project URL** (goes in `wrangler.jsonc` as `SUPABASE_URL`, not secret)
   - **service_role key** (goes in Worker secrets, never committed)

---

## Part 3 — Configure `wrangler.jsonc`

Non-secret values live directly in `wrangler.jsonc` under `vars`:

```jsonc
"vars": {
  "WRIKE_CLIENT_ID": "<your Wrike app's client id>",
  "SUPABASE_URL": "<your Supabase project url>"
}
```

These are safe to commit — a client ID and a project URL are meaningless
without the paired secret. Update these two values for your Wrike app /
Supabase project before deploying.

---

## Part 4 — Set Worker secrets

Two values must **never** go in `wrangler.jsonc` or any committed file:

- `WRIKE_CLIENT_SECRET`
- `SUPABASE_SERVICE_ROLE_KEY`

### Local development
```bash
cp .dev.vars.example .dev.vars
# edit .dev.vars and fill in both values
```
`.dev.vars` is gitignored — `wrangler dev` reads secrets from it locally.

### Production
```bash
npx wrangler login                      # first time only, authorizes the CLI
npx wrangler secret put WRIKE_CLIENT_SECRET
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
```
Each prompts you to paste the value; it's stored encrypted on Cloudflare,
never in git.

---

## Part 5 — Deploy

```bash
npm install
npm run deploy      # = npm run build && wrangler deploy
```

First deploy will ask you to authenticate with the Cloudflare account you
want this under (`wrangler login` opens a browser). It publishes the Worker
+ static assets together and gives you a `https://<name>.<subdomain>.workers.dev`
URL.

To use a custom domain instead: Cloudflare dashboard → your Worker →
**Settings → Domains & Routes → Add Custom Domain**. If you do this, go back
and add the new domain's `/api/wrike/oauth/callback` URL to the Wrike app
(Part 1) — Wrike will reject the OAuth callback otherwise.

---

## Updating the app later

```bash
git pull origin main
npm run deploy
```

There's no auto-deploy-on-push wired up for the Worker (unlike the old
Cloudflare Pages setup, which redeployed automatically on every push) —
`wrangler deploy` is a manual step each time, run from whoever has
`wrangler login` access to the Cloudflare account. If you want push-to-deploy
back, connect the repo via **Workers & Pages → Create → Import a repository**
in the Cloudflare dashboard instead of deploying from the CLI, and configure
the same secrets there under **Settings → Variables and Secrets**.

---

## Quick checklist when moving this to a new Cloudflare account / domain

- [ ] Cloudflare account created, `wrangler login` done against it
- [ ] Wrike OAuth app has this domain's `/api/wrike/oauth/callback` as a
      registered redirect URI
- [ ] Supabase project created, `wrike_oauth_tokens` table exists
- [ ] `wrangler.jsonc` → `WRIKE_CLIENT_ID` and `SUPABASE_URL` updated
- [ ] `wrangler secret put WRIKE_CLIENT_SECRET` run
- [ ] `wrangler secret put SUPABASE_SERVICE_ROLE_KEY` run
- [ ] `npm run deploy` succeeds
- [ ] Sign-in through Wrike OAuth actually works end-to-end on the new URL

---

## Notes

- Timesheet/task data still goes through the Wrike API via the Worker proxy
  (`/api/wrike/*`) — the Worker attaches the stored token server-side and
  refreshes it automatically when it's close to expiring.
- Members never see or hold a raw Wrike access token; only a random session
  cookie (`wrike_session`, `HttpOnly`, 180-day expiry) that maps to a row in
  `wrike_oauth_tokens`.
- Free tiers (Cloudflare Workers, Supabase) change over time — if the
  dashboard shows something different from what's described here, trust the
  dashboard.
