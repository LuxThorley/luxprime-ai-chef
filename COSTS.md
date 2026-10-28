# Malcolm AI Chef assistant — running costs

**Confirmed cost: £0.00/month** (checked 27 Oct 2026, read-only, Cloudflare account subscriptions: Workers on the Free plan, no Workers Paid add-on).

| Component | Service | Cost |
|---|---|---|
| Widget, cook-along, timers, plans, shopping lists, knowledge index, site guide | Static assets + Worker code on the existing `luxprime-ai-chef` Worker | £0 (Workers Free: 100k requests/day) |
| Voice (speech recognition + read-aloud) | Browser Web Speech API, runs on the member's device | £0 |
| Chat model | Workers AI `@cf/meta/llama-3.1-8b-instruct-fast`, free allocation (10,000 neurons/day) | £0. Code cap: 600 AI chats/day (`asst-ai:chat`) |
| Fridge photo scan | Workers AI `@cf/llava-hf/llava-1.5-7b-hf`, same free allocation | £0. Code cap: 40 scans/day (`asst-ai:vision`) |
| Member memory, escalations | Existing KV namespace (`IMAGES`, keys `asst:mem:*`, `asst:esc:*`) | £0 (KV Free: 100k reads, 1k writes/day) |
| Rate limits | Existing D1 `rate_limits` table | £0 |
| Offline fallback | Recipe library + knowledge index, bundled | £0 |

On the Workers Free plan, going over the free allowance makes the AI call fail rather than bill you, and Malcolm drops back to the library. Nothing paid is enabled.

**Optional Malcolm sync** (`ASSISTANT_SYNC=malcolm`, off by default): this sends chat to `malcolmai-live` `/v1/chat`, whose provider chain uses Gemini and Groq keys. It only stays £0 if those keys are on free tiers. Check that before you turn it on.

## Optional paid upgrades (not enabled; rough GBP)
| Upgrade | Rough cost |
|---|---|
| Workers Paid (higher limits, larger AI allowance) | ~£4/month base, plus ~£0.009 per 1k neurons over the allowance |
| Natural premium voice (e.g. ElevenLabs or Azure TTS) | ~£5–£20/month at small scale |
| Larger vision model or higher scan volume | ~£2–£10/month |
| Transactional email to Oliver for escalations (Resend Pro) | £0 up to 3k emails/month on the free tier; ~£16/month Pro |

## Malcolm assistant upgrades (feature/malcolm-assistant-upgrades, Oct 2026) — still £0

| Item | What it uses | Cost / cap |
|---|---|---|
| Tools (search, save, scale, UK14 allergens, shopping list) | D1 reads/writes on the member's own rows (`shopping_items`, `favourites`) | £0 — D1 free tier (5M rows read / 100k written per day); list capped at 100 items/member |
| New recipe from chat | Malcolm `/v1/recipes` via the existing search path (`doSearch`), counts against the plan's search allowance | £0 (Gemini/Groq free tiers inside Malcolm); 10/member/day from chat |
| Images in chat | Existing dish-image path (Malcolm image engine → Workers AI FLUX schnell ≈ 60 neurons/image) | £0; lazy (only on tap), 6/member/day from chat **plus** the existing per-tier `DAILY_CAPS` |
| Longer replies | Malcolm `maxTokens` 1200 (Gemini free tier); Workers AI fallback capped at 700 output tokens | llama-3.1-8b fp8-fast ≈ 4,119 neurons/M in + 34,868/M out ⇒ ~30 neurons per long fallback reply |
| Fallback cap | `ASSISTANT_WAI_DAILY` = 200 Workers AI fallback replies/day ≈ 6,000 of the 10,000 free neurons/day | over the cap → offline library reply (never billed) |
| Streaming | SSE from the Worker; no extra service | £0 |
| Staging worker `luxprime-ai-chef-staging` | separate D1 `luxprime-ai-chef-staging-db`, KV `aichef-staging-images` | £0 (free tier); delete when done |

Workers AI pricing checked 28 Oct 2026 at developers.cloudflare.com/workers-ai/platform/pricing (10,000 free neurons/day, resets 00:00 UTC).
