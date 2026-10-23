# AIchef.food — AI Chef (powered by Malcolm AI)

**Live preview:** https://luxthorley.github.io/luxprime-ai-chef/

[![Deploy to GitHub Pages](https://github.com/LuxThorley/luxprime-ai-chef/actions/workflows/pages.yml/badge.svg)](https://github.com/LuxThorley/luxprime-ai-chef/actions/workflows/pages.yml) [![CI](https://github.com/LuxThorley/luxprime-ai-chef/actions/workflows/ci.yml/badge.svg)](https://github.com/LuxThorley/luxprime-ai-chef/actions/workflows/ci.yml)

## Two editions

| | Static preview (GitHub Pages) | Full service (Node server) |
|---|---|---|
| Where | `luxthorley.github.io/luxprime-ai-chef/` | Render / any Node 18+ host |
| Recipe search | In-browser ranking over the 60-recipe curated library | Malcolm AI (Omni-Lattice) with curated-library fallback |
| Export / print / share | Print, PDF, image card, X, Facebook, WhatsApp, Pinterest, LinkedIn, email, copy link (share links encode the recipe in the URL) | Same, plus short `/r/:id` links with per-recipe Open Graph cards |
| Accounts, favourites, history | "Coming soon – full service" | Yes |
| Subscriptions | "Coming soon – full service" (no payments taken) | Stripe Checkout + Customer Portal |
| Secrets | **None.** The Malcolm AI key is never shipped to the browser | Server-side env vars only |

GitHub Pages only serves static files, so it cannot run Express, SQLite, Stripe webhooks or hold an API key safely.
`scripts/build-static.js` builds `dist/` by bundling `src/recipes.js`, `src/ranker.js` and `src/safety.js` for the browser,
rewriting paths for the `/luxprime-ai-chef/` base and replacing server calls with `static/static-api.js`.
`.github/workflows/pages.yml` builds and deploys it on every push to `main`; `.github/workflows/ci.yml` runs `npm test`.

## Full service on Cloudflare Workers (live)

**Live full service:** https://luxprime-ai-chef.oliverluxthorley.workers.dev

`worker/` is a Workers-native port of `src/server.js` (Hono): same `/api/*` contract, so the `public/` frontend runs unchanged.

* **D1** `luxprime-ai-chef-db` — `worker/migrations/0001_init.sql` (users, sessions, favourites, history, subscriptions, shares, stripe_events, rate_limits)
* **Auth** — PBKDF2-SHA256 (WebCrypto, 100k iterations, per-user salt), revocable D1 sessions in an HttpOnly cookie, CSRF double-submit, D1 rate limits
* **Stripe** over `fetch` (Checkout, Customer Portal) and webhook signature verification with WebCrypto HMAC (`/api/billing/webhook`)
* **Malcolm AI** called from the Worker (`MALCOLM_AI_MODE=lattice`), curated-library fallback
* **Workers Assets** serve `public/`; `/api/*` and `/r/*` run the Worker first; daily cron purges expired sessions
* Shared logic (`src/ai.js`, `ranker.js`, `recipes.js`, `safety.js`, `plans.js`) is bundled from the same source as the Node server

Worker secrets: `MALCOLM_AI_KEY`, `JWT_SECRET` (set). To switch on payments add `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
`STRIPE_PRICE_CHEF_DE_PARTIE`, `STRIPE_PRICE_HEAD_CHEF`, `STRIPE_PRICE_GASTRONOMIQUE`, `STRIPE_PRICE_MAGAZINE` + the `…_ANNUAL` versions (Stripe webhook → `https://luxprime-ai-chef.oliverluxthorley.workers.dev/api/billing/webhook`,
events `checkout.session.completed`, `customer.subscription.*`). Optional `APP_URL` for a custom domain.

```bash
cd worker && npm ci && npx wrangler dev            # local (needs worker/.dev.vars, git-ignored)
npx wrangler secret put STRIPE_SECRET_KEY          # add secrets (never commit them)
npm run deploy                                     # migrations + deploy
```
CI: `.github/workflows/deploy-worker.yml` deploys on push once repo secrets `CLOUDFLARE_API_TOKEN` (scoped: Workers Scripts:Edit,
D1:Edit, Account Settings:Read) and `CLOUDFLARE_ACCOUNT_ID` exist; otherwise it skips with a notice.

## Deploying the Node server instead (Render)

1. Render → **New → Web Service** → connect `LuxThorley/luxprime-ai-chef`. Runtime Node, build `npm ci`, start `npm start`
   (or use the included `Dockerfile`). Add a **persistent disk** mounted at e.g. `/var/data` and set `DB_PATH=/var/data/app.db`.
2. Environment variables: `NODE_ENV=production`, `JWT_SECRET` (`openssl rand -hex 32`), `APP_URL` (your domain),
   `AI_PROVIDER=malcolm`, `MALCOLM_AI_URL=https://malcolmai-live.oliverluxthorley.workers.dev/`, `MALCOLM_AI_MODE=lattice`,
   `MALCOLM_AI_KEY` (paste the Malcolm token into Render's secret field — never into the repo), plus the Stripe keys when ready.
3. The token is also stored as the GitHub Actions secret `MALCOLM_AI_KEY` (and `MALCOLM_AI_URL` as a repo variable) so a
   future deploy workflow can push it to the host via `${{ secrets.MALCOLM_AI_KEY }}`. GitHub never shows secret values back.
4. Stripe: create the eight prices (monthly £4.99 / £7.99 / £11.99 / magazine £3.49; annual £49 / £79 / £119 / magazine £34.90), set `STRIPE_SECRET_KEY`, `STRIPE_PRICE_CHEF_DE_PARTIE`, `STRIPE_PRICE_HEAD_CHEF`, `STRIPE_PRICE_GASTRONOMIQUE`, `STRIPE_PRICE_MAGAZINE` (+ `_ANNUAL` versions), and a webhook to
   `{APP_URL}/api/billing/webhook` → `STRIPE_WEBHOOK_SECRET`. Test mode first.

### Malcolm AI endpoint (updated 2026-10-21)
The Malcolm worker now exposes **`POST /v1/recipes`** (same Bearer auth as `/omni/command`). It takes the AI Chef query
(`include, exclude, dish, maxMinutes, difficulty, servings, diets, cuisine, kidsMode, count`), generates recipes with
Cloudflare Workers AI (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`, JSON-schema mode, one retry) and returns `{recipes:[...]}`
matching `ResponseSchema`. Typical latency is 25–40 s, so `AI_TIMEOUT_MS` is 60–75 s. Existing endpoints
(`/healthz`, `/modes/status`, `/omni/command`, `/optimize`, `/auth/inspect`) are unchanged. On any error users get curated-library picks.

## Quick start
```bash
npm install            # Node 18+ (20 LTS recommended). better-sqlite3 builds natively.
cp .env.example .env   # set JWT_SECRET at minimum
npm test               # node:test — ranking + API tests
npm start              # http://localhost:3000
```

## Structure
```
src/server.js     Express app: helmet CSP, rate limits, CSRF (double-submit), auth, search, favourites,
                  history, share (/r/:id with OG meta), Stripe checkout/portal/webhook, dish images
src/ai.js         Provider-agnostic AI layer (openai-compatible | malcolm | none), zod schema, retry, fallback
src/ranker.js     Offline deterministic ranking (ingredient overlap, dish text, time, difficulty, diet, cuisine, kids)
src/recipes.js    Expands dataset, derives UK-14 allergens + diet flags, scales quantities
src/safety.js     Food-safety guardrails: core temperatures, banned unsafe advice, allergen re-derivation
src/images.js     Curated category photos + optional AI dish-image generation with disk cache
src/plans.js      Tiers: Commis Chef (free, 3 searches; new sign-ups get a 7-day Head Chef trial), Chef de Partie £4.99/mo or £49/yr, Head Chef £7.99/mo or £79/yr (magazine included), Gastronomique £11.99/mo or £119/yr (5 household seats, magazine for each member); Magazine add-on £3.49/mo or £34.90/yr; entitlements
src/db.js         SQLite schema (better-sqlite3)
data/recipes.js   60 curated recipes
public/           Landing, pricing, app (3-step wizard), account, share, terms, privacy; css/js/img/vendor(jsPDF)
test/             ranking.test.js, api.test.js
```

## Environment (.env)
| Var | Purpose |
|---|---|
| `JWT_SECRET` | **Required in production.** `openssl rand -hex 32` |
| `APP_URL` | Public base URL (used in Stripe redirects and share links) |
| `DB_PATH` | SQLite file (use a persistent volume in production) |
| `AI_PROVIDER` | `none` (offline library), `openai` (any OpenAI-compatible API), `malcolm` |
| `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL` | OpenAI-compatible endpoint (OpenAI, OpenRouter, Groq, Together, Ollama, vLLM…) |
| `MALCOLM_AI_URL`, `MALCOLM_AI_KEY`, `MALCOLM_AI_MODEL`, `MALCOLM_AI_MODE` | Malcolm AI / Omni-Lattice endpoint |
| `IMAGE_PROVIDER`, `IMAGE_BASE_URL`, `IMAGE_API_KEY`, `IMAGE_MODEL`, `IMAGE_SIZE`, `IMAGE_CACHE_DIR` | Optional dish images for AI recipes |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_CHEF_DE_PARTIE`, `STRIPE_PRICE_HEAD_CHEF`, `STRIPE_PRICE_GASTRONOMIQUE`, `STRIPE_PRICE_MAGAZINE` + `…_ANNUAL` | Stripe billing (monthly £4.99 / £7.99 / £11.99 / £3.49; annual £49 / £79 / £119 / £34.90) |
| `FREE_SEARCHES`, `PRICE_MONTHLY_LABEL`, `PRICE_FAMILY_LABEL` | Plan display placeholders |

Never commit `.env`. Only `.env.example` (no real values) ships in this package.

## Connecting Malcolm AI / Omni-Lattice
Set `AI_PROVIDER=malcolm` and `MALCOLM_AI_URL` to your endpoint.
* `MALCOLM_AI_MODE=openai` (default): the endpoint must accept an OpenAI-style chat completion
  `POST {model, messages, response_format:{type:"json_object"}}` and return `{choices:[{message:{content:"<json>"}}]}`.
* `MALCOLM_AI_MODE=lattice` (alias `recipes`): POST the structured query to `{MALCOLM_AI_URL}/v1/recipes` (the live Malcolm worker).
* `MALCOLM_AI_MODE=native`: we POST `{task:"recipes", model, system, query:{include,exclude,dish,maxMinutes,difficulty,servings,diets,cuisine,kidsMode,count}}`
  and expect `{recipes:[...]}` directly.

Either way the JSON must match the schema in `src/ai.js` (`ResponseSchema`). Invalid output is retried twice with
the validation error fed back; if it still fails (or the endpoint is down / times out after `AI_TIMEOUT_MS`), users get
curated library results automatically. Every AI recipe passes the safety filter and has allergens re-derived from
its ingredients (AI claims are never trusted alone). `MALCOLM_AI_KEY` is sent as `Authorization: Bearer`.

## Dish images
Library recipes use the bundled professional photos in `public/img` (WebP + JPEG, lazy-loaded, AI-generated stock).
For AI recipes, set `IMAGE_PROVIDER=openai` and an OpenAI-compatible `/images/generations` endpoint. Images are
generated on demand via `/api/dish-image?title=…`, cached in `IMAGE_CACHE_DIR`, and fall back to the closest curated photo.

## Stripe setup (use TEST mode first)
1. Create four Products in Stripe, each with two recurring GBP Prices (monthly / annual): Chef de Partie £4.99 / £49,
   Head Chef £7.99 / £79, Gastronomique £11.99 / £119, AIchef.food Magazine add-on £3.49 / £34.90. Copy the `price_…` IDs into
   `STRIPE_PRICE_CHEF_DE_PARTIE`, `STRIPE_PRICE_HEAD_CHEF`, `STRIPE_PRICE_GASTRONOMIQUE`, `STRIPE_PRICE_MAGAZINE` and the
   matching `…_ANNUAL` variables (`STRIPE_PRICE_CHEF_DE_PARTIE_ANNUAL`, `STRIPE_PRICE_HEAD_CHEF_ANNUAL`, `STRIPE_PRICE_GASTRONOMIQUE_ANNUAL`, `STRIPE_PRICE_MAGAZINE_ANNUAL`);
   put your `sk_test_…` key in `STRIPE_SECRET_KEY`. (Legacy `STRIPE_PRICE_MONTHLY`/`STRIPE_PRICE_FAMILY` still work as fallbacks.)
2. Enable the **Customer Portal** (Settings → Billing → Customer portal) so users can cancel/update cards.
3. Add a webhook endpoint `https://YOUR_DOMAIN/api/billing/webhook` with events `checkout.session.completed`,
   `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`. Put its signing secret
   in `STRIPE_WEBHOOK_SECRET`. Locally: `stripe listen --forward-to localhost:3000/api/billing/webhook`.
4. Test with card `4242 4242 4242 4242`, then switch to live keys.
Gating: Free = 3 searches, 3 results; paid = unlimited, 5 results, favourites and history.

## Security
bcrypt (bcryptjs, cost 12) password hashes; JWT in HttpOnly SameSite cookie; double-submit CSRF token on all
mutating API calls; helmet with strict CSP (no inline scripts, no third-party scripts); express-rate-limit (global,
auth, search, image); zod validation on all input; Stripe webhook signature verification + idempotency; parameterised SQL.

## Deploy
The app is a long-running Node server with a SQLite file, so it needs a host that runs Node and has a persistent disk.
* **Render**: New Web Service → Node, build `npm install`, start `npm start`; add a Disk mounted at `/data`, set `DB_PATH=/data/luxprime.db`.
* **Railway**: deploy from repo or Dockerfile; add a Volume at `/data`; set env vars.
* **Fly.io**: `fly launch` (uses Dockerfile), `fly volumes create data`, mount at `/data`, `fly secrets set …`.
* **VPS** (Ubuntu): Node 20 + `pm2 start src/server.js`, behind Nginx/Caddy with HTTPS; or `docker build -t luxprime . && docker run -p 3000:3000 -v luxdata:/data --env-file .env luxprime`.
* **Cloudflare**: Cloudflare **Pages alone cannot run this Node/Express server or SQLite**. Use Cloudflare for DNS/CDN/proxy in
  front of one of the hosts above (or port to Workers + D1, which is a rewrite).
Set `NODE_ENV=production` (secure cookies) and `APP_URL` to the HTTPS domain.

## Before going live (checklist)
* Terms & Privacy pages are **placeholders — have them reviewed by a UK solicitor** (consumer cancellation rights, UK GDPR, ICO registration).
* Trade mark clearance for "Lux Prime" (a similar mark, LUXXPRIME, exists).
* Allergen and nutrition data are guidance/estimates; keep the disclaimers.
* Images in `public/img` are AI-generated; replace with commissioned photography if you need strong IP protection.

## Ratings, favourites and the "Chef of Kings" ranking

**Data (D1 migration `0008_community.sql`, additive):** `recipes` (stable id → full recipe JSON + image key, first writer wins),
`ratings` (one row per member per recipe, 1–5, editable), `recipe_events` (view / cook / share / pdf, deduped per actor·recipe·kind·UTC day),
`user_prefs` (synced diet, servings, cuisines, difficulty, time, kids mode, recent searches). Existing `favourites` rows are kept and back-filled into `recipes`.

**Stable IDs:** library recipes keep their slug; AI recipes are `ai-` + a 64-bit FNV-1a hash of the normalised title and sorted ingredient names,
so the same dish always gets the same id and a client can't attach a rating to tampered content (the server recomputes the hash); Escoffier entries are `esc-<no>`, built server-side.

**Displayed rating:** plain arithmetic mean of all stars, shown to 3 decimal places, plus the count.

**Ranking score** (`src/community.js → scoreRecipes`, constants in `K`):

* Each rating has a trust weight *w*: 1 normally; 0.25 for admin/tester accounts; 0.5 for the member who first saved the recipe; 0.3 for accounts younger than 3 days.
  If a recipe receives ≥ 5 ratings from new accounts within 24 h, those ratings get *w* = 0 (spike filter). One rating per account (primary key); max 40 rating changes per member per hour, plus per-IP rate limits.
* **Bayesian average** `B = (C·m + Σ w·r) / (C + Σ w)` with prior weight `C = 5` and `m` = global weighted mean (3.5 if no data).
* **Consistency** `1 − 0.04·σ` where σ is the weighted standard deviation of the stars.
* **Engagement** `E = 0.20·ln(1+distinct raters) + 0.15·ln(1+hearts) + 0.25·ln(1+“I made this”) + 0.10·ln(1+shares+PDFs) + 0.05·ln(1+views)`.
* **Recency** `ρ = 0.5^(days since last activity / 60)`.
* **Score** `= B·(1 − 0.04σ) + E·(0.4 + 0.6ρ)`; ties broken by rating count. A recipe needs ratings from ≥ 2 distinct trusted members to be ranked.
  The top 10 is cached for 60 s per isolate and shown on the homepage; ranked recipes get a “Featured #n” badge everywhere.

**Malcolm context (additive):** each search passes the current top 5 (title, cuisine, average, count) as optional inspiration and the member's 5 latest hearted titles; the request always wins.

**Cuisine fusion:** the app sends `cuisines: [...]` (up to 8); with two or more, Malcolm is told to create genuine fusion dishes and label the cuisine “A–B fusion”.

## Email (verification, magazine, household invites)
All outbound site email goes through one helper, `src/mailer.js` (Resend HTTPS API, works in Node and Workers).
- **From:** `"Malcolm · AIchef.food" <malcolm@aichef.food>` by default; override with `MAIL_FROM` (falls back to the legacy `MAGAZINE_FROM`). **Reply-To:** `malcolm@aichef.food` (`MAIL_REPLY_TO`).
- **Inactive until the `RESEND_API_KEY` secret is set.** Until then sign-ups show "verification pending" and the site works normally.
- **Before setting the key, verify the `aichef.food` domain in Resend** (Resend → Domains → add `aichef.food`) and add the DNS records it gives you at the DNS host: the SPF `TXT` (and the MX record on the `send` subdomain), the DKIM `TXT` (`resend._domainkey`), and a DMARC `TXT` at `_dmarc.aichef.food` (start with `v=DMARC1; p=none; rua=mailto:malcolm@aichef.food`). Resend rejects mail from unverified domains (HTTP 403).
- **Email verification:** sign-up emails a single-use link (`/account.html?verify=…`, valid 24h). Only the SHA-256 of the token is stored (`email_tokens`, migration `0009`). Migration 0009 marks every existing account verified and sends nothing. Unverified members can use the site, but their ratings carry no weight in rankings, and they can't receive the magazine by email or send/accept household invites.
- Tests strip `RESEND_API_KEY` from the environment (`test/helpers/no-mail.js`), so they never reach Resend.
