import type { Env, PageRow, WebsiteRow } from "./types";
import { decryptSecret, safeHtmlText, stripUnsafeArticleHtml, uuid } from "./security";

const enc = (value: string) => new TextEncoder().encode(value);

async function geminiRequest(env: Env, model: string, prompt: string, options: Record<string, unknown> = {}) {
  if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not configured");
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], ...options })
  });
  const data = await response.json() as any;
  if (!response.ok) throw new Error(`Gemini ${model} failed (${response.status}): ${data.error?.message ?? "unknown error"}`);
  const candidate = data.candidates?.[0];
  const text = candidate?.content?.parts?.map((part: any) => part.text ?? "").join("\n").trim() ?? "";
  return { data, candidate, text };
}

function parseJson(text: string): any {
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("AI response did not contain a JSON object");
  return JSON.parse(cleaned.slice(start, end + 1));
}

function groundedSources(data: any): Array<{ url: string; title: string; domain: string }> {
  const chunks = data?.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
  const values: Array<{ url: string; title: string; domain: string }> = [];
  const seen = new Set<string>();
  for (const chunk of chunks) {
    const web = chunk?.web;
    const raw = web?.uri;
    if (!raw) continue;
    try {
      const url = new URL(raw);
      if (url.protocol !== "https:" && url.protocol !== "http:") continue;
      const domain = url.hostname.replace(/^www\./, "").toLowerCase();
      if (seen.has(domain)) continue;
      seen.add(domain);
      values.push({ url: url.toString(), title: String(web.title ?? domain), domain });
    } catch { /* ignore malformed search chunk */ }
  }
  return values;
}

export async function researchTopic(env: Env, contentType: string, language: string) {
  const model = env.GEMINI_TEXT_MODEL || "gemini-3.8-flash";
  const prompt = `You are the research desk for a specialist publisher. Find one timely, genuinely newsworthy topic in the category "${contentType}". Prefer developments from the last 48 hours; do not invent a trend. Search the web. Return JSON only: {"topic":"...","why_now":"...","key_facts":["..."],"queries":["..."]}. Use ${language} for the topic wording. If no credible current development is found, set topic to an evergreen explainer and explicitly state that in why_now.`;
  const result = await geminiRequest(env, model, prompt, {
    tools: [{ googleSearch: {} }],
    generationConfig: { responseMimeType: "application/json", temperature: 0.25 }
  });
  const research = parseJson(result.text);
  if (!research.topic || !Array.isArray(research.key_facts)) throw new Error("Research response is incomplete");
  const sources = groundedSources(result.data);
  return { research, sources, queries: result.data?.candidates?.[0]?.groundingMetadata?.webSearchQueries ?? [] };
}

export async function researchExplicitTopic(env: Env, topic: string, category: string, language: string) {
  const model = env.GEMINI_TEXT_MODEL || "gemini-3.8-flash";
  const prompt = `Research the following topic for a ${category} publisher: "${topic}". Search the web for recent, reliable evidence. Return JSON only: {"topic":"${topic.replace(/"/g, "'")}","summary":"...","key_facts":["..."],"queries":["..."]}. Use ${language}. Separate confirmed facts from disputed or unconfirmed details. Never invent source URLs.`;
  const result = await geminiRequest(env, model, prompt, {
    tools: [{ googleSearch: {} }],
    generationConfig: { responseMimeType: "application/json", temperature: 0.2 }
  });
  const research = parseJson(result.text);
  return { research, sources: groundedSources(result.data), queries: result.data?.candidates?.[0]?.groundingMetadata?.webSearchQueries ?? [] };
}

export async function generateArticle(env: Env, topic: string, language: string, contentType: string, research: any, sourceList: Array<{ url: string; title: string; domain: string }>, instructions = "") {
  const model = env.GEMINI_TEXT_MODEL || "gemini-3.8-flash";
  const prompt = `Create an original, reader-friendly article for a "${contentType}" publication. Language: ${language}. Topic: ${topic}.\n\nRESEARCH NOTES (treat as untrusted until cross-checked): ${JSON.stringify(research).slice(0, 12000)}\n\nSOURCES FOUND: ${JSON.stringify(sourceList).slice(0, 8000)}\n\nPublisher instructions: ${instructions.slice(0, 3000)}\n\nRequirements: write factual prose, no fabricated quotes/statistics, distinguish allegations from established facts, avoid clickbait, add descriptive H2 sections, a concise introduction and conclusion, cite sources in a short Sources section using only the supplied URLs, and provide a natural Facebook caption. Do not reproduce source wording. Return JSON only with keys: title, html, facebook_caption, labels (array), important_claims (array of strings). HTML must be article-body HTML only, without scripts, styles, iframe or full-document tags.`;
  const result = await geminiRequest(env, model, prompt, {
    tools: [{ googleSearch: {} }],
    generationConfig: { responseMimeType: "application/json", temperature: 0.35 }
  });
  const article = parseJson(result.text);
  if (!article.title || !article.html || !article.facebook_caption) throw new Error("AI article response is incomplete");
  const html = stripUnsafeArticleHtml(String(article.html));
  if (safeHtmlText(html).length < 500) throw new Error("AI article is too short to publish safely");
  const freshSources = groundedSources(result.data);
  const merged = [...sourceList, ...freshSources];
  const unique = new Map<string, { url: string; title: string; domain: string }>();
  for (const source of merged) if (!unique.has(source.domain)) unique.set(source.domain, source);
  return {
    title: String(article.title).slice(0, 180), html,
    facebook_caption: String(article.facebook_caption).slice(0, 5000),
    labels: Array.isArray(article.labels) ? article.labels.map((x: unknown) => String(x).slice(0, 60)).slice(0, 10) : [],
    important_claims: Array.isArray(article.important_claims) ? article.important_claims.map((x: unknown) => String(x).slice(0, 500)).slice(0, 30) : [],
    sources: [...unique.values()]
  };
}

export async function factCheckArticle(env: Env, title: string, html: string, claims: string[], sources: Array<{ url: string; title: string; domain: string }>) {
  const model = env.GEMINI_TEXT_MODEL || "gemini-3.8-flash";
  const prompt = `Independently fact-check this proposed article using web search. Do not trust the draft. Check each factual claim against current sources, flag contradictions and outdated details. Return JSON only: {"verdict":"pass"|"review","confidence":0-100,"claims":[{"claim":"...","status":"supported"|"contradicted"|"unclear","evidence":"brief explanation"}],"reason":"..."}. A pass requires that the important factual claims are supported by reliable, independent sources. If evidence is thin, choose review.\nTITLE: ${title}\nARTICLE: ${safeHtmlText(html).slice(0, 14000)}\nCLAIMS: ${JSON.stringify(claims).slice(0, 6000)}\nINITIAL SOURCES: ${JSON.stringify(sources).slice(0, 6000)}`;
  const result = await geminiRequest(env, model, prompt, {
    tools: [{ googleSearch: {} }],
    generationConfig: { responseMimeType: "application/json", temperature: 0.1 }
  });
  const parsed = parseJson(result.text);
  const checkedSources = groundedSources(result.data);
  const merged = new Map<string, { url: string; title: string; domain: string }>();
  for (const source of [...sources, ...checkedSources]) if (!merged.has(source.domain)) merged.set(source.domain, source);
  const minDomains = Math.max(2, Number(env.MIN_SOURCE_DOMAINS || 2));
  const confidence = Math.max(0, Math.min(100, Number(parsed.confidence || 0)));
  const supportedClaims = Array.isArray(parsed.claims) ? parsed.claims.filter((c: any) => c.status === "supported").length : 0;
  const totalClaims = Array.isArray(parsed.claims) ? parsed.claims.length : 0;
  const deterministicPass = merged.size >= minDomains && totalClaims > 0 && supportedClaims === totalClaims && confidence >= 80 && parsed.verdict === "pass";
  return {
    approved: deterministicPass,
    confidence,
    reason: String(parsed.reason ?? "Automated fact-check did not provide a publishable verdict").slice(0, 1200),
    claims: Array.isArray(parsed.claims) ? parsed.claims.slice(0, 30) : [],
    sources: [...merged.values()]
  };
}

function licenseIsReusable(shortName: string, url: string): boolean {
  const value = `${shortName} ${url}`.toLowerCase();
  if (/\b(nc|non.?commercial|nd|no.?derivatives)\b/.test(value)) return false;
  return /public domain|cc0|creative commons zero|creativecommons\.org\/licenses\/(by|by-sa)\//i.test(value) || /cc by(?:-sa)?\s*[1234.]/i.test(shortName);
}

async function searchCommonsImage(query: string) {
  const api = new URL("https://commons.wikimedia.org/w/api.php");
  api.search = new URLSearchParams({
    action: "query", format: "json", generator: "search", gsrsearch: `filetype:bitmap ${query}`,
    gsrlimit: "12", prop: "imageinfo", iiprop: "url|extmetadata", iiurlwidth: "1600", origin: "*"
  }).toString();
  const response = await fetch(api.toString(), { headers: { "accept": "application/json", "user-agent": "JarvisCloudAutomation/2.0 (licensed image lookup)" } });
  if (!response.ok) throw new Error(`Wikimedia Commons search failed: ${response.status}`);
  const data = await response.json() as any;
  const pages = Object.values(data?.query?.pages ?? {}) as any[];
  for (const page of pages) {
    const info = page?.imageinfo?.[0];
    if (!info?.thumburl || !info?.descriptionurl) continue;
    const meta = info.extmetadata ?? {};
    const license = String(meta.LicenseShortName?.value ?? "");
    const licenseUrl = String(meta.LicenseUrl?.value ?? "");
    if (!licenseIsReusable(license, licenseUrl)) continue;
    const mime = String(info.mime ?? "");
    if (!/^image\/(jpeg|png|webp)$/i.test(mime)) continue;
    const strip = (v: unknown) => String(v ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 240);
    return {
      url: String(info.thumburl), landingUrl: String(info.descriptionurl), mime,
      title: String(page.title ?? "Wikimedia Commons image"), license,
      artist: strip(meta.Artist?.value), credit: strip(meta.AttributionRequired?.value || meta.Artist?.value), licenseUrl
    };
  }
  return null;
}

/**
 * R2-free image handling. Reusable Wikimedia Commons images are embedded by
 * their public thumbnail URL with attribution. Binary AI image generation is
 * deliberately not attempted until a supported upload destination is configured:
 * Blogger API v3 accepts image URLs in post HTML but does not expose a binary
 * media-upload endpoint. Never put base64 data into Blogger article HTML.
 */
export async function createArticleImage(env: Env, topic: string, title: string, imageMode: string) {
  if (imageMode === "ai_only") {
    throw new Error("AI image bytes need a public image host. R2 is disabled; configure an image-host upload provider before using AI-only images.");
  }
  try {
    const found = await searchCommonsImage(`${title} ${topic}`);
    if (found) {
      return {
        key: null,
        url: found.url,
        credit: `${found.title} by ${found.artist || "Unknown author"}, ${found.license} (${found.licenseUrl}). Source: ${found.landingUrl}`
      };
    }
  } catch (error) {
    if (imageMode === "commons_only") throw error;
  }
  if (imageMode === "commons_only") return null;
  throw new Error("No reusable Wikimedia Commons image was found. AI image hosting is not configured; article is held for review.");
}

async function bloggerAccessToken(env: Env, refreshToken: string) {
  if (!env.BLOGGER_CLIENT_ID || !env.BLOGGER_CLIENT_SECRET) throw new Error("Blogger OAuth client ID and secret are not configured");
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.BLOGGER_CLIENT_ID, client_secret: env.BLOGGER_CLIENT_SECRET, refresh_token: refreshToken, grant_type: "refresh_token" })
  });
  const data = await response.json() as any;
  if (!response.ok || !data.access_token) throw new Error(`Blogger token refresh failed: ${data.error_description ?? data.error ?? response.status}`);
  return String(data.access_token);
}
async function bloggerRequest(env: Env, website: WebsiteRow, method: string, endpoint: string, payload?: unknown) {
  if (!website.refresh_token_ciphertext) throw new Error("Blogger is not connected for this website");
  const refresh = await decryptSecret(website.refresh_token_ciphertext, env);
  const access = await bloggerAccessToken(env, refresh);
  const response = await fetch(endpoint, {
    method, headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) })
  });
  const data = await response.json() as any;
  if (!response.ok) throw new Error(`Blogger API failed (${response.status}): ${data.error?.message ?? "unknown error"}`);
  return data;
}

export async function verifyBlogger(env: Env, website: WebsiteRow) {
  const data = await bloggerRequest(env, website, "GET", `https://www.googleapis.com/blogger/v3/blogs/${encodeURIComponent(website.blog_id)}`);
  return { id: String(data.id), name: String(data.name ?? website.name), url: String(data.url ?? website.blog_url) };
}

async function existingBloggerPost(env: Env, website: WebsiteRow, label: string) {
  try {
    const url = `https://www.googleapis.com/blogger/v3/blogs/${encodeURIComponent(website.blog_id)}/posts?labels=${encodeURIComponent(label)}&maxResults=5`;
    const data = await bloggerRequest(env, website, "GET", url);
    return data.items?.find((x: any) => (x.labels ?? []).includes(label)) ?? null;
  } catch { return null; }
}
export async function publishBlogger(env: Env, website: WebsiteRow, article: { id: string; title: string; html: string; labels: string[] }) {
  const marker = `jarvis-${article.id.replace(/-/g, "").slice(0, 24)}`;
  const existing = await existingBloggerPost(env, website, marker);
  if (existing?.id && existing?.url) return { id: String(existing.id), url: String(existing.url), recovered: true };
  const labels = [...new Set([...(article.labels || []).slice(0, 8), marker])];
  const data = await bloggerRequest(env, website, "POST", `https://www.googleapis.com/blogger/v3/blogs/${encodeURIComponent(website.blog_id)}/posts/`, {
    kind: "blogger#post", blog: { id: website.blog_id }, title: article.title, content: article.html, labels
  });
  if (!data.id || !data.url) throw new Error("Blogger response did not include post ID and URL");
  return { id: String(data.id), url: String(data.url), recovered: false };
}

function graphBase(env: Env) {
  const version = env.META_GRAPH_VERSION || "v26.0";
  if (!/^v\d+\.0$/.test(version)) throw new Error("META_GRAPH_VERSION must look like v26.0");
  return `https://graph.facebook.com/${version}`;
}
async function graphCall(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const data = await response.json() as any;
  if (!response.ok || data.error) {
    const message = data.error?.message ?? `HTTP ${response.status}`;
    const code = data.error?.code ? ` [${data.error.code}]` : "";
    throw new Error(`Meta Graph API: ${message}${code}`);
  }
  return data;
}
export async function verifyFacebookPage(env: Env, page: PageRow) {
  const token = await decryptSecret(page.token_ciphertext, env);
  const url = new URL(`${graphBase(env)}/${encodeURIComponent(page.page_id)}`);
  url.searchParams.set("fields", "id,name");
  url.searchParams.set("access_token", token);
  const data = await graphCall(url.toString());
  if (String(data.id) !== String(page.page_id)) throw new Error("Meta token does not resolve to the expected Page ID");
  return { id: String(data.id), name: String(data.name ?? page.page_name) };
}
async function findExistingFacebookPost(env: Env, page: PageRow, message: string) {
  const token = await decryptSecret(page.token_ciphertext, env);
  const url = new URL(`${graphBase(env)}/${encodeURIComponent(page.page_id)}/feed`);
  url.searchParams.set("fields", "id,message,permalink_url");
  url.searchParams.set("limit", "10");
  url.searchParams.set("access_token", token);
  const data = await graphCall(url.toString());
  return (data.data ?? []).find((p: any) => String(p.message ?? "").trim() === message.trim()) ?? null;
}
export async function publishFacebook(env: Env, page: PageRow, message: string, link: string) {
  const token = await decryptSecret(page.token_ciphertext, env);
  const recovered = await findExistingFacebookPost(env, page, message).catch(() => null);
  if (recovered?.id) return { id: String(recovered.id), recovered: true };
  const response = await graphCall(`${graphBase(env)}/${encodeURIComponent(page.page_id)}/feed`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ message, link, access_token: token })
  });
  if (!response.id) throw new Error("Meta did not return the Page post ID");
  return { id: String(response.id), recovered: false };
}
export async function createFacebookLinkComment(env: Env, page: PageRow, postId: string, url: string) {
  const token = await decryptSecret(page.token_ciphertext, env);
  const listUrl = new URL(`${graphBase(env)}/${encodeURIComponent(postId)}/comments`);
  listUrl.searchParams.set("fields", "id,message");
  listUrl.searchParams.set("limit", "100");
  listUrl.searchParams.set("access_token", token);
  const existing = await graphCall(listUrl.toString()).catch(() => null);
  const found = (existing?.data ?? []).find((comment: any) => String(comment.message ?? "").trim() === url.trim());
  if (found?.id) return { id: String(found.id), recovered: true };
  const result = await graphCall(`${graphBase(env)}/${encodeURIComponent(postId)}/comments`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ message: url, access_token: token })
  });
  if (!result.id) throw new Error("Meta did not return the link comment ID");
  return { id: String(result.id), recovered: false };
}
export async function tryPinFacebookComment(env: Env, page: PageRow, commentId: string) {
  if (env.META_TRY_PIN_COMMENT !== "true") return { attempted: false, pinned: false, reason: "Disabled until confirmed for this Meta app and Page" };
  const token = await decryptSecret(page.token_ciphertext, env);
  try {
    await graphCall(`${graphBase(env)}/${encodeURIComponent(commentId)}`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ is_pinned: "true", access_token: token })
    });
    return { attempted: true, pinned: true, reason: "Meta accepted pin request" };
  } catch (error) {
    return { attempted: true, pinned: false, reason: error instanceof Error ? error.message.slice(0, 300) : "Pin operation unavailable" };
  }
}


function isoDay(date: Date): string { return date.toISOString().slice(0, 10); }
function addUtcDays(date: Date, amount: number): Date { const copy = new Date(date); copy.setUTCDate(copy.getUTCDate() + amount); return copy; }

function unpackAdsterraRows(payload: any): any[] {
  if (Array.isArray(payload)) return payload;
  for (const key of ["data", "items", "stats", "statistics", "results"]) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return payload && typeof payload === "object" ? [payload] : [];
}

export async function syncAdsterraNetwork(env: Env, networkId: string, daysBack = 7) {
  const network = await env.DB.prepare(`SELECT n.*,w.id AS linked_website_id FROM ad_networks n JOIN websites w ON w.id=n.website_id WHERE n.id=?`).bind(networkId).first<any>();
  if (!network) throw new Error("Ad network not found");
  if (String(network.reporting_provider) !== "adsterra") throw new Error("This network is not configured for Adsterra Publisher API reporting");
  if (!network.api_token_ciphertext) throw new Error("Add an Adsterra Publisher API token first");
  const config = JSON.parse(String(network.report_config || "{}"));
  const domainId = String(config.domain_id || "");
  if (!/^\d+$/.test(domainId)) throw new Error("Configure a valid numeric Adsterra domain ID");
  const finish = new Date();
  const start = addUtcDays(finish, -Math.max(1, Math.min(30, daysBack)));
  const query = new URLSearchParams({ domain: domainId, start_date: isoDay(start), finish_date: isoDay(finish) });
  query.append("group_by[]", "date");
  if (config.placement_id && /^\d+$/.test(String(config.placement_id))) query.set("placement", String(config.placement_id));
  const token = await decryptSecret(String(network.api_token_ciphertext), env);
  const response = await fetch(`https://api3.adsterratools.com/publisher/stats.json?${query.toString()}`, {
    headers: { accept: "application/json", "X-API-Key": token }
  });
  const rawText = await response.text();
  let payload: any;
  try { payload = JSON.parse(rawText); } catch { throw new Error("Adsterra API returned a non-JSON response"); }
  if (!response.ok) {
    const detail = typeof payload?.error === "string" ? payload.error : JSON.stringify(payload?.error || payload).slice(0, 250);
    throw new Error(`Adsterra API failed (${response.status}): ${detail}`);
  }
  const rows = unpackAdsterraRows(payload);
  let saved = 0;
  for (const row of rows) {
    const reportDate = String(row.date ?? row.day ?? row.report_date ?? row.date_start ?? isoDay(finish)).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) continue;
    const impressions = Math.max(0, Math.round(Number(row.impressions ?? row.views ?? 0) || 0));
    const clicks = Math.max(0, Math.round(Number(row.clicks ?? row.click ?? 0) || 0));
    const ctr = Math.max(0, Number(row.ctr ?? (impressions ? (clicks / impressions) * 100 : 0)) || 0);
    const cpm = Math.max(0, Number(row.cpm ?? row.ecpm ?? 0) || 0);
    const revenue = Math.max(0, Number(row.revenue ?? row.earnings ?? row.total_revenue ?? 0) || 0);
    const dimensionKey = String(row.placement_id ?? row.placement ?? "total").slice(0, 120);
    await env.DB.prepare(`INSERT INTO ad_revenue_daily
      (id,network_id,website_id,report_date,currency,impressions,clicks,ctr,cpm,revenue,dimension_key,raw_json,fetched_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(network_id,report_date,dimension_key) DO UPDATE SET
       impressions=excluded.impressions,clicks=excluded.clicks,ctr=excluded.ctr,cpm=excluded.cpm,
       revenue=excluded.revenue,raw_json=excluded.raw_json,fetched_at=CURRENT_TIMESTAMP`)
      .bind(uuid(), networkId, network.website_id, reportDate, String(row.currency ?? "USD").slice(0, 8), impressions, clicks, ctr, cpm, revenue, dimensionKey, JSON.stringify(row).slice(0, 5000)).run();
    saved++;
  }
  await env.DB.prepare("UPDATE ad_networks SET last_stats_sync=CURRENT_TIMESTAMP,stats_sync_status='success',stats_error=NULL WHERE id=?").bind(networkId).run();
  return { network_id: networkId, provider: "adsterra", rows_saved: saved, from: isoDay(start), to: isoDay(finish) };
}

export async function syncDueAdReports(env: Env) {
  const networks = await env.DB.prepare(`SELECT id FROM ad_networks
    WHERE is_active=1 AND reporting_provider='adsterra'
      AND (last_stats_sync IS NULL OR last_stats_sync < datetime('now','-1 hour'))
    ORDER BY last_stats_sync LIMIT 10`).all<{ id: string }>();
  const results: Array<{ id: string; ok: boolean; detail: string }> = [];
  for (const network of networks.results) {
    try {
      const result = await syncAdsterraNetwork(env, network.id, 3);
      results.push({ id: network.id, ok: true, detail: `${result.rows_saved} report rows synced` });
    } catch (error) {
      const detail = error instanceof Error ? error.message.slice(0, 500) : "Unknown stats sync error";
      await env.DB.prepare("UPDATE ad_networks SET last_stats_sync=CURRENT_TIMESTAMP,stats_sync_status='error',stats_error=? WHERE id=?").bind(detail, network.id).run();
      results.push({ id: network.id, ok: false, detail });
    }
  }
  return results;
}
