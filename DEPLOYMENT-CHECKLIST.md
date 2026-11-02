# Jarvis deployment and live-run checklist

## Cloudflare resources
- [ ] Create D1 database `jarvis-db` and replace the placeholder `database_id` in `wrangler.toml`.
- [ ] Create Queue `jarvis-publish`.
- [ ] Confirm Worker bindings: D1 `DB`, Queue producer/consumer `PUBLISH_QUEUE`, Static Assets `ASSETS`.
- [ ] Confirm the Cron Trigger runs once per minute.
- [ ] Set `PUBLIC_BASE_URL` to the final HTTPS `workers.dev` origin initially.

## Worker secrets
Set values using `wrangler secret put`, never in app source or `wrangler.toml`:
- [ ] `JARVIS_ADMIN_KEY` (random, at least 32 characters)
- [ ] `DATA_ENCRYPTION_KEY` (random, at least 32 characters; back up securely)
- [ ] `GEMINI_API_KEY`
- [ ] `BLOGGER_CLIENT_ID`
- [ ] `BLOGGER_CLIENT_SECRET`
- [ ] `PUBLIC_BASE_URL`
- [ ] `GOOGLE_OAUTH_REDIRECT_URI` (optional; defaults to `${PUBLIC_BASE_URL}/oauth/google/callback`)
- [ ] `CORS_ORIGINS` only if serving the API from an additional browser origin
- [ ] `META_TRY_PIN_COMMENT=true` only after deciding to attempt the optional pin action

## Google Blogger
- [ ] Enable Blogger API v3 in Google Cloud.
- [ ] Configure the OAuth consent screen and create an OAuth Web client.
- [ ] Add the exact Worker callback URL to authorized redirect URIs.
- [ ] Add each Blogger site in Jarvis, tap Connect Google and approve access.
- [ ] Verify every website before mapping it to a Page.

## Meta Facebook Pages
- [ ] Configure the Meta Developer App and Business Portfolio.
- [ ] Create a System User and assign the app plus each target Page asset.
- [ ] Generate Page access tokens with the permissions required by the approved app/use case.
- [ ] Add each Page in Jarvis and run Verify connection.
- [ ] Confirm token status is valid before enabling scheduled posting.
- [ ] Revisit the Meta dashboard if token monitoring reports invalid/expired access. Do not assume a token is permanent.

## Content and safety setup
- [ ] Configure each Page's single category, language and timezone.
- [ ] Set a low daily cap (1), minimum gap and short active window for first tests.
- [ ] Choose image mode: Wikimedia Commons only or Commons-first. AI image generation remains unavailable until a public image-upload provider is configured; do not select AI-only.
- [ ] Create a draft and review source URLs, fact-check status, article copy, caption and image attribution.
- [ ] Treat automated fact-checking as a quality gate, not a guarantee of truth.
- [ ] Confirm that each Page maps to its intended separate Blogger site.

## First live publishing test
- [ ] Verify Facebook and Blogger connections.
- [ ] Use Publish now on a test Page and watch each AI step in Activity.
- [ ] Confirm the Blogger article, image, labels and URL.
- [ ] Confirm the Facebook Page post and Blogger link comment.
- [ ] Review comment pin status separately. A pin failure should not be treated as a post failure.
- [ ] Test per-job Pause, Resume and Cancel; also test global Pause all / Resume all.
- [ ] Test Automatic today and inspect the local date/time and timezone displayed.
- [ ] Only then enable the automatic schedule on one production Page.

## Ads per website
- [ ] Add each network separately inside the correct website.
- [ ] Copy trusted hostnames from the network's official code. Use HTTPS hosts only.
- [ ] Add multiple units as needed, select placement, and preview the code before activating it.
- [ ] Export that Blogger site's XML theme, generate a Jarvis patch, inspect it, and import it in Blogger Theme > Restore.
- [ ] Do not copy ad codes between sites. Each ad network, unit and revenue row is tied to one website.
- [ ] Configure Adsterra API reporting where enabled, or import daily CSVs for Monetag/other providers.
- [ ] Confirm report currency/date and revenue totals against the provider dashboard.

## Operational notes
- Cloudflare Cron + Queues continue running when the phone is off. The Android screen is a control/monitoring client, not the execution host.
- The Activity screen refreshes while visible and stores job state/events in D1.
- Per-Page, per-site, per-job and global switches are independent; a pause prevents new work and stops in-flight work at safe checkpoints. An external provider call already in progress may complete before that checkpoint.
- Idempotency markers and provider lookups reduce duplicate writes but cannot guarantee exactly-once behavior if a remote provider accepts a request and the response is lost.
- Blogger API v3 has no supported theme/template update route in this integration. Jarvis generates XML; the owner imports it manually.
- Ad code is third-party executable content. Only paste code from providers you trust, and check provider/site policy before enabling it.
- Deployment, provider permissions, live API verification and release APK build/signing must be completed using the owner's accounts and local environment.


## R2-free image behavior
- R2 is intentionally removed from the Worker bindings.
- Wikimedia Commons reusable thumbnail URLs may be embedded directly with attribution.
- Blogger API v3 does not provide a general binary image upload endpoint; this build does not claim to upload binary images to Blogger.
- AI image output requires a separate public image host/upload provider and is not enabled in this R2-free package.
