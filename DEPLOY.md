# Deploying OAuth Flow Lab to Vercel

This guide puts the app on Vercel's free **Hobby** plan, which is meant for personal, non-commercial projects. It takes about 10 minutes.

## How it runs on Vercel

Locally the app is one long-running Node process with its state in memory. On Vercel each request runs in a short-lived serverless function, and two requests from the same visitor may hit different instances. So the deployed app needs two things:

| Needs | Why | Provided by |
|---|---|---|
| **Shared state** | Authorization codes, sessions, refresh tokens and the Inspector's traffic log must be visible to every instance | **Upstash Redis** (free) from the Vercel Marketplace |
| **One stable public URL** | It's the OAuth issuer, the `redirect_uri`, and the target of the app's server-to-server calls to itself | Your project's production domain, `https://<project>.vercel.app` |

You don't need a `vercel.json`. Vercel detects `src/app.ts` (which default-exports the Express app) and runs it as a function. Files in `public/` are served from Vercel's CDN.

## Prerequisites

- A free [Vercel](https://vercel.com) account
- Node.js 20 or newer (`node -v`)
- The Vercel CLI: `npm i -g vercel`, then `vercel login`

## Option A: deploy from the CLI

From the project folder:

### 1. Create and link the project

```bash
vercel link
```

Answer the prompts: pick your account, create a new project (e.g. `oauth-flow-lab`), and accept the detected settings. This creates a `.vercel/` folder, which is git-ignored.

### 2. Add Upstash Redis

1. Open your project in the Vercel dashboard → **Storage** tab → **Create Database**.
2. Choose **Upstash** → **Redis**, pick the free plan and a region close to your functions (the default `iad1` / US East is fine), and create it.
3. Connect it to the project for the **Production** environment (Preview and Development are optional).

This adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` to the project's environment variables. The app reads them automatically. `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` also work if you'd rather use your own Upstash account and set them yourself.

### 3. Deploy to production

```bash
vercel --prod
```

The CLI prints the URL when it finishes. Use the **production domain** (`https://<project>.vercel.app`), not the long per-deployment URL (`https://<project>-abc123-<team>.vercel.app`). See [Deployment Protection](#deployment-protection-use-the-production-domain) below for why.

> Deploy again after you add or change environment variables. Running deployments don't pick up new values.

## Option B: deploy from GitHub

1. Put the project in a GitHub repo. It isn't a git repo yet, so start with `git init`. `.gitignore` already excludes `node_modules`, `.env*` and `.vercel`.
2. In the Vercel dashboard: **Add New… → Project**, then import the repo. Leave the build settings at their defaults.
3. Add Upstash Redis as in [step 2](#2-add-upstash-redis), then **Redeploy** from the Deployments tab.

After that, every push to the default branch deploys to production automatically.

## Environment variables

All are optional except the Redis pair, which the Marketplace sets for you.

| Variable | Default | When to set it |
|---|---|---|
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | set by the Upstash integration | Always required on Vercel |
| `APP_ORIGIN` | `https://$VERCEL_PROJECT_PRODUCTION_URL` | You use a **custom domain**, or system environment variables are turned off. Set it to the exact public origin with no trailing slash, e.g. `https://oauth.example.com` |
| `OAUTH_PRIVATE_JWK` | generated on first use and stored in Redis | You want a fixed signing key (an RS256 private key as JWK JSON) |

`APP_ORIGIN` decides the issuer (`$APP_ORIGIN/auth`), the registered `redirect_uri` (`$APP_ORIGIN/client/callback`) and the API audience (`$APP_ORIGIN/api`). If it doesn't match the address in your browser's address bar, the flow breaks.

`VERCEL_PROJECT_PRODUCTION_URL` is a Vercel system variable. It's exposed by default (Project → Settings → Environment Variables → "Automatically expose System Environment Variables").

## Check the deployment

1. Open `https://<project>.vercel.app/auth/.well-known/openid-configuration`. `issuer` should be `https://<project>.vercel.app/auth`.
2. Run the end-to-end test against it from your machine:

   ```bash
   npm run smoke -- https://<project>.vercel.app
   ```

   It should end with `All checks passed`.
3. Open `/client` and `/inspector` side by side and click through flow 1. The Inspector should show solid back-channel arrows for `/auth/token` and `/auth/jwks`.

## Deployment Protection: use the production domain

On Hobby, Vercel's default **Standard Protection** puts every deployment URL *except* the production domain behind a Vercel login. That includes preview deployments and the per-deployment URLs. The app makes HTTP calls to itself (client → `/auth/token`, API → `/auth/jwks`). If those hit a protected URL, they get Vercel's login page back instead of JSON.

- Always demo on `https://<project>.vercel.app` (or your custom domain).
- Don't set `APP_ORIGIN` to a preview or per-deployment URL.
- Preview deployments don't work for the full flow. If you need them, you'd have to turn off protection for previews (Project → Settings → Deployment Protection), but that makes them public.

## Custom domain

1. Project → Settings → **Domains** → add your domain and follow the DNS instructions.
2. Set `APP_ORIGIN=https://your.domain` for Production.
3. Redeploy.

After this, use only the custom domain. The `.vercel.app` address will still load, but its issuer and `redirect_uri` won't match.

## Free-tier usage

From the app's own behavior:

- An open Inspector tab polls once per second, which costs **1 Redis command per poll** (about 3,600/hour). It pauses while the tab is hidden.
- A full run of flow 1 costs a few dozen Redis commands. Each recorded request adds about 3.
- Recorded traffic expires after 2 hours, and each visitor's log keeps at most 500 exchanges.

Upstash's free plan has a monthly command allowance; check Upstash's pricing page for the current numbers. For occasional demos you'll stay well inside it. Close Inspector tabs you aren't using.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| "This sign-in request expired or was already used", login loops, or an empty Inspector | No Redis, so every instance has its own in-memory state. The function logs show `[store] No Upstash Redis env vars found` | Connect Upstash to the **Production** environment, then redeploy |
| Back-channel calls in the Inspector return an HTML page or `401` from Vercel | The app is calling itself through a protected URL | Use the production domain; check `APP_ORIGIN` |
| `invalid_request: redirect_uri … is not registered` | The address you opened doesn't match `APP_ORIGIN` (e.g. custom domain vs `.vercel.app`) | Open the matching address, or set `APP_ORIGIN` and redeploy |
| `404 Not found` for every path | Express wasn't detected | Check the build log; `src/app.ts` must default-export the app. Framework preset should be detected as Express (or "Other") |
| Pages load without styling | `public/` not served | Check that `https://<project>.vercel.app/theme.css` loads; `public/` must be at the project root |
| Old tokens suddenly fail with `invalid_token` | The signing key changed (Redis was flushed, or `OAUTH_PRIVATE_JWK` was changed) | Expected. Start the flow again |

To read function logs: Project → **Logs**, or run `vercel logs https://<project>.vercel.app`.

## Updating and removing

- **Update:** run `vercel --prod` again, or push to GitHub with Option B.
- **Reset all demo data:** in the Upstash console for the database, use **Flush** (this also regenerates the signing key on next use).
- **Remove:** Project → Settings → **Delete Project**, and delete the Upstash database from the Storage tab.

> The users, clients and secrets in this demo are fake and deliberately shown on screen. Don't reuse this as a real authorization server.
