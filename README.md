# Jarvis Cloud Automation v2

Cloudflare Worker backend + browser dashboard + Android Automation Control Center patch for Jarvis. The cloud service is intended to keep scheduling, AI preparation and publishing running even while the phone is offline.

## Included capabilities

### Independent publishing channels
- Add multiple Facebook Pages. Each Page has exactly one content category, language, timezone, posting window, daily cap, minimum gap and image mode.
- Map each Page to its own Blogger website. Database uniqueness rules enforce one Page ↔ one Blogger site.
- Store Page tokens and Blogger refresh tokens encrypted with AES-GCM in Cloudflare D1. Secret values are never returned by read APIs.
- Verify Facebook Page and Blogger connections, and re-check Facebook token validity on a daily schedule.

### Publishing choices
From the dashboard or Jarvis Android app, select a Facebook Page and choose:
- **Publish now:** start an immediate AI pipeline. The job is queued in Cloudflare and its status is visible in Activity.
- **Automatic today:** choose one random future time inside that Page's remaining local publishing window today. The dashboard shows the selected time and timezone.
- **Choose date & time:** schedule a specific future time.
- **Create draft for review:** generate the article and wait for operator approval.

Automatic daily scheduling plans randomized jobs for enabled Pages. It respects the Page timezone, local active window, daily cap, minimum spacing and existing non-draft posts. Cron dispatches due jobs every minute.

### AI preparation and visibility
- Discover a current topic or research a topic supplied by the operator using Gemini Search grounding.
- Generate an article, social caption, headings and labels.
- Run a second independent fact-check pass against search results. A configurable minimum number of distinct source domains is required.
- Detect likely repeats against the Page's recent publishing history.
- Search Wikimedia Commons for Public Domain, CC0, CC BY and CC BY-SA assets with attribution.
- R2 is not required. Reusable Wikimedia Commons images are embedded by their public thumbnail URL with attribution. Important: Blogger API v3 accepts image URLs in post HTML but does not provide a general binary media-upload endpoint. This build does not upload image bytes to Blogger. AI-generated image bytes are held for review until a public image-upload provider is configured.
- Store progress events and individual step states in D1. Activity shows the current AI stage, progress, prior steps, source links, draft preview, errors and publish state. The UI refreshes about every seven seconds while visible.
- A Page, website, individual job or the entire automation system can be switched off/on. Pause/cancel/resume/retry controls are available where appropriate. Resuming a paused future job preserves its original scheduled time instead of firing it early. In-flight third-party calls may complete before the next safe pause checkpoint.

### Facebook + Blogger publishing
- Refresh Blogger access tokens from each website's encrypted OAuth refresh token.
- Publish the article to its mapped Blogger website with labels and a stable Jarvis marker.
- Publish the Facebook Page post and then add the Blogger permalink as a comment.
- Optionally attempt comment pinning (`META_TRY_PIN_COMMENT=true`); this is best-effort and independently tracked.
- Provider-side lookup and stored IDs reduce duplicate publication after retry. Exactly-once delivery cannot be guaranteed across separate provider APIs if a response is lost after a provider accepts a write.

### Per-website ad manager
- Separate ad networks and multiple ad units per website.
- Per-unit names, formats, placements, activation switches and encrypted ad code.
- Require allowlisted HTTPS provider hostnames before saving ad snippets.
- Inject active article placements into generated article HTML. Generate a patched Blogger theme XML from an exported theme file for `head`, `top`, `middle`, `bottom` and `footer` placements.
- Revenue reporting supports Adsterra Publisher API and daily CSV import for Monetag or other networks where the account does not have a supported API connection. Reports are grouped by website and network.

## Account-owner steps that software cannot do for you

1. **Meta:** The Business owner must create the Business Portfolio/System User, assign the app and Page assets, generate a Page token and paste it into Jarvis. Jarvis can verify and monitor the supplied token, but it cannot create Meta-owned assets inside your account.
2. **Google:** The owner must create a Google OAuth client and approve Blogger access for each website.
3. **Blogger theme:** Blogger API v3 does not offer a supported theme/template update endpoint. Jarvis generates the modified XML; the owner reviews it and imports it through Blogger Theme > Restore.
4. **Ad network:** The owner supplies the official ad code and the corresponding provider hostnames, and reviews the provider terms. Monetag revenue can be imported from its report CSV when no account API access is available.
5. **Credentials and billing:** Provider API access, account permissions, Cloudflare quotas, Google billing/model entitlement and Meta app review are external account prerequisites.

## Requirements

- Node.js 20+
- Cloudflare account with Workers, D1 and Queues enabled (R2 is not used)
- Google Cloud project with Blogger API v3 and an OAuth web client
- Meta Developer App, Business Portfolio, System User and Page assets
- Gemini API key with access to a text model and Nano Banana image generation

## Cloudflare setup

From this directory:

```bash
npm install
npx wrangler login
npx wrangler d1 create jarvis-db
npx wrangler queues create jarvis-publish
```

Copy the D1 `database_id` returned by Wrangler into `wrangler.toml`. Check the Queue names and bindings, then set Worker secrets:

```bash
npx wrangler secret put JARVIS_ADMIN_KEY
npx wrangler secret put DATA_ENCRYPTION_KEY
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put BLOGGER_CLIENT_ID
npx wrangler secret put BLOGGER_CLIENT_SECRET
npx wrangler secret put PUBLIC_BASE_URL
npx wrangler secret put GOOGLE_OAUTH_REDIRECT_URI
```

`JARVIS_ADMIN_KEY` and `DATA_ENCRYPTION_KEY` must each be long random values (at least 32 characters). Back up the encryption key securely: losing it means encrypted provider tokens/ad snippets cannot be decrypted. Never put these values in Android source, `wrangler.toml`, screenshots or public repositories.

`PUBLIC_BASE_URL` must be the HTTPS Worker origin, e.g. `https://jarvis-cloud-automation.<your-subdomain>.workers.dev`. Set `GOOGLE_OAUTH_REDIRECT_URI` to the exact callback URL `${PUBLIC_BASE_URL}/oauth/google/callback` and add that same URL to the Google OAuth client's authorized redirect URIs. Do not set a custom domain until its DNS and Worker route are ready.

Apply schema, check code and deploy:

```bash
npm run db:remote
npm run typecheck
npm test
npm run deploy
```

The `wrangler.toml` model defaults at this release are `gemini-3.8-flash` for text and `gemini-nano-banana-2.1` for images. Change them in Worker variables if your account/model access requires a different stable model.

Open `https://YOUR-WORKER.workers.dev/automation` to use the web dashboard. In the Jarvis Android app, open **Settings → Automation Control Center**, then enter the same HTTPS Worker URL and admin key.

## First setup sequence

1. Deploy the Worker and check `/health` returns `ok: true`.
2. Add one Blogger website in Jarvis and complete **Connect Google**, then run **Verify**.
3. Add one Facebook Page with the Meta System User Page token, then run **Verify connection**.
4. Map that Page to its matching Blogger website.
5. Create a draft first. Review the generated article, sources, image attribution and Facebook caption.
6. Test **Publish now** on a test Page/site and confirm Blogger, Facebook post and link comment.
7. Turn on Page automation only after the test looks correct. Start with one daily post and a limited active window.
8. Add ad network code only after verifying hostnames, placements, preview and theme XML. Review/import the XML manually in Blogger.

## API overview

All `/api/*` routes require `Authorization: Bearer <JARVIS_ADMIN_KEY>`.

- Dashboard, jobs, status and history: `/api/dashboard`, `/api/status`, `/api/jobs`, `/api/jobs/:id`, `/api/history`
- Pages: `/api/pages`, `/api/pages/:id`, `/api/pages/:id/verify`
- Websites/OAuth: `/api/websites`, `/api/websites/:id/oauth-url`, `/api/websites/:id/verify`
- Page/site mapping: `/api/mappings`
- Manual job options: `/api/jobs/publish-now`, `/api/jobs/random-today`, `/api/jobs/schedule`, `/api/jobs/draft`
- Job actions: `/api/jobs/:id/approve-publish`, `/pause`, `/resume`, `/cancel`
- Global controls: `/api/control/pause-all`, `/api/control/resume-all`
- Ads: `/api/ads/networks`, `/api/ads/units`, `/api/ads/revenue`, `/api/ads/revenue/import`
- Theme patch: `/api/websites/:id/theme-patch` accepts `{ "template_xml": "..." }` and returns patched XML for review/import.

## Validation scope

This bundle is source code, not a deployed service. Local static/type checks and schema checks can be run without real provider accounts. Live Meta, Google, Gemini and ad-network API testing, Cloudflare deployment, quota checks and APK compilation/signing require the owner's accounts, network and signing credentials. Do not switch on auto publishing until the end-to-end test is complete.
