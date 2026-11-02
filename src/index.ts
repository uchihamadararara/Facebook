import type { Env, PageRow, QueueMessage, WebsiteRow } from "./types";
import {
  asBool, body, decryptSecret, encryptSecret, json, safeError, safeHtmlText,
  stripUnsafeArticleHtml, unauthorized, uuid, validateTime
} from "./security";
import { dispatchDueJobs, planDailyJobs, statusAfterPause } from "./scheduler";
import { addLocalDays, localDateAt, localTimeToUtcIso, validateTimezone } from "./timezone";
import {
  createArticleImage, createFacebookLinkComment, factCheckArticle, generateArticle,
  publishBlogger, publishFacebook, researchExplicitTopic, researchTopic,
  tryPinFacebookComment, verifyBlogger, verifyFacebookPage, syncAdsterraNetwork, syncDueAdReports
} from "./integrations";

const ACTIVE_JOB_STATUSES = ["scheduled", "queued", "processing", "awaiting_approval"];
const ADMIN_PATH = /^\/api\//;

function allowedOrigin(req: Request, env: Env): string | null {
  const origin = req.headers.get("origin");
  if (!origin) return null;
  const own = new URL(req.url).origin;
  const allowed = (env.CORS_ORIGINS || "").split(",").map(x => x.trim()).filter(Boolean);
  if (origin === own || allowed.includes(origin)) return origin;
  return null;
}
function corsHeaders(req: Request, env: Env): HeadersInit {
  const headers: Record<string, string> = {
    "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "authorization,content-type",
    "access-control-max-age": "86400",
    "vary": "Origin"
  };
  const origin = allowedOrigin(req, env);
  if (origin) headers["access-control-allow-origin"] = origin;
  return headers;
}
function withCors(response: Response, req: Request, env: Env): Response {
  const headers = new Headers(response.headers);
  Object.entries(corsHeaders(req, env)).forEach(([key, value]) => headers.set(key, value));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function audit(env: Env, jobId: string | null, pageId: string | null, websiteId: string | null, action: string, result: string, detail?: string) {
  await env.DB.prepare(`INSERT INTO publishing_history(id,job_id,page_id,website_id,action,result,detail) VALUES(?,?,?,?,?,?,?)`)
    .bind(uuid(), jobId, pageId, websiteId, action, result, detail ?? null).run();
}
async function event(env: Env, jobId: string, level: string, stage: string, progress: number, message: string, status?: string) {
  await env.DB.prepare(`INSERT INTO job_events(id,job_id,level,stage,progress,message) VALUES(?,?,?,?,?,?)`)
    .bind(uuid(), jobId, level, stage, progress, message.slice(0, 1200)).run();
  await env.DB.prepare(`UPDATE publishing_jobs SET stage=?,progress=?,${status ? "status=?," : ""}updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .bind(...(status ? [stage, progress, status, jobId] : [stage, progress, jobId])).run();
}
async function step(env: Env, jobId: string, key: string, label: string, status: "running" | "completed" | "failed" | "skipped", detail?: string) {
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO job_steps(id,job_id,step_key,label,status,detail,started_at,ended_at)
    VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(job_id,step_key) DO UPDATE SET status=excluded.status,detail=excluded.detail,
      started_at=CASE WHEN excluded.status='running' THEN excluded.started_at ELSE job_steps.started_at END,
      ended_at=CASE WHEN excluded.status IN ('completed','failed','skipped') THEN excluded.ended_at ELSE NULL END`)
    .bind(uuid(), jobId, key, label, status, detail ?? null, status === "running" ? now : null, status === "running" ? null : now).run();
}
async function isGloballyEnabled(env: Env): Promise<boolean> {
  const row = await env.DB.prepare("SELECT global_enabled FROM system_control WHERE id=1").first<any>();
  return Number(row?.global_enabled ?? 1) === 1;
}
class JobPausedError extends Error {
  constructor() { super("Job paused by operator"); this.name = "JobPausedError"; }
}

async function ensureJobContinuing(env: Env, jobId: string): Promise<void> {
  const [control, job] = await Promise.all([
    env.DB.prepare("SELECT global_enabled FROM system_control WHERE id=1").first<any>(),
    env.DB.prepare(`SELECT j.status,j.trigger_source,p.is_active AS page_active,p.automation_enabled,w.is_active AS website_active
      FROM publishing_jobs j LEFT JOIN facebook_pages p ON p.id=j.page_id LEFT JOIN websites w ON w.id=j.website_id WHERE j.id=?`).bind(jobId).first<any>()
  ]);
  if (!job || ["cancelled", "failed", "completed"].includes(String(job.status))) {
    throw new Error(`Job is no longer active (${String(job?.status || "missing")})`);
  }
  const disabled = Number(control?.global_enabled ?? 1) !== 1 || String(job.status) === "paused" ||
    Number(job.page_active ?? 0) !== 1 || Number(job.website_active ?? 0) !== 1 ||
    (String(job.trigger_source) === "automatic" && Number(job.automation_enabled ?? 0) !== 1);
  if (disabled) {
    await env.DB.prepare("UPDATE publishing_jobs SET paused_from_status=COALESCE(paused_from_status,CASE WHEN status='processing' THEN 'queued' ELSE status END),status='paused',stage='paused',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('queued','processing')").bind(jobId).run();
    throw new JobPausedError();
  }
}

async function htmlWithAds(env: Env, websiteId: string, articleHtml: string, image?: { url: string; credit: string } | null): Promise<string> {
  let html = stripUnsafeArticleHtml(articleHtml);
  if (image?.url) {
    const credit = image.credit.replace(/[<>]/g, "");
    html = `<figure class="jarvis-hero-image"><img src="${image.url}" alt="Article image" loading="eager" style="width:100%;height:auto;border-radius:8px"/><figcaption>${credit}</figcaption></figure>\n${html}`;
  }
  const units = await env.DB.prepare(`
    SELECT u.unit_name,u.format,u.placement,u.code_ciphertext,n.network_name
    FROM ad_units u JOIN ad_networks n ON n.id=u.network_id
    WHERE n.website_id=? AND n.is_active=1 AND u.is_active=1
    ORDER BY u.created_at
  `).bind(websiteId).all<any>();
  const placements: Record<string, string[]> = {};
  for (const unit of units.results) {
    const code = await decryptSecret(String(unit.code_ciphertext), env);
    if (["top", "middle", "bottom"].includes(String(unit.placement))) {
      (placements[String(unit.placement)] ||= []).push(`<!-- Jarvis ad ${String(unit.network_name)} / ${String(unit.unit_name)} -->\n${code}`);
    }
  }
  const midMarker = "<!-- JARVIS_AD_MID -->";
  if (!html.includes(midMarker)) {
    const firstHeadingEnd = html.search(/<h2\b[^>]*>[\s\S]*?<\/h2>/i);
    if (firstHeadingEnd >= 0) {
      const heading = html.match(/<h2\b[^>]*>[\s\S]*?<\/h2>/i);
      if (heading) html = html.replace(heading[0], `${heading[0]}\n${midMarker}`);
    }
  }
  html = `<!-- JARVIS_AD_TOP -->\n${html}\n<!-- JARVIS_AD_BOTTOM -->`;
  for (const [placement, marker] of [["top", "<!-- JARVIS_AD_TOP -->"], ["middle", midMarker], ["bottom", "<!-- JARVIS_AD_BOTTOM -->"]] as const) {
    const snippets = placements[placement];
    if (snippets?.length) html = html.replace(marker, `${snippets.join("\n")}\n${marker}`);
  }
  return html;
}

async function createJob(env: Env, pageId: string, topic: string | null, trigger: "manual" | "automatic" | "manual_draft", type: string, scheduledAt: string, autoPublish: number) {
  const page = await env.DB.prepare("SELECT * FROM facebook_pages WHERE id=?").bind(pageId).first<PageRow>();
  if (!page || Number(page.is_active) !== 1) throw new Error("Facebook Page is missing or disabled");
  const mapping = await env.DB.prepare(`SELECT website_id FROM page_website_mappings WHERE facebook_page_id=?`).bind(pageId).first<any>();
  if (!mapping?.website_id) throw new Error("Connect this Facebook Page to its Blogger website first");
  const site = await env.DB.prepare("SELECT * FROM websites WHERE id=?").bind(mapping.website_id).first<WebsiteRow>();
  if (!site || Number(site.is_active) !== 1) throw new Error("Mapped Blogger website is missing or disabled");
  const id = uuid();
  const idem = `${trigger}:${id}`;
  const status = new Date(scheduledAt).getTime() > Date.now() ? "scheduled" : "queued";
  await env.DB.prepare(`INSERT INTO publishing_jobs
    (id,page_id,website_id,job_type,topic,trigger_source,auto_publish,scheduled_at,timezone,status,stage,progress,idempotency_key)
    VALUES(?,?,?,?,?,?,?,?,?,?,?, ?,?)`)
    .bind(id, pageId, String(mapping.website_id), type, topic, trigger, autoPublish, scheduledAt, page.timezone || "Asia/Kolkata", status, status === "queued" ? "queued" : "waiting", status === "queued" ? 2 : 0, idem).run();
  await event(env, id, "info", status === "queued" ? "queued" : "scheduled", status === "queued" ? 2 : 0,
    trigger === "manual" ? "You started this job manually." : trigger === "manual_draft" ? "Draft creation started." : "Automatic publishing slot created.", status);
  if (status === "queued") await env.PUBLISH_QUEUE.send({ id });
  return { id, status, page, website: site };
}

function parseDomains(sources: Array<{ url: string; title: string; domain: string }>) {
  return [...new Set(sources.map(s => s.domain).filter(Boolean))];
}

function titleTokens(value: string): Set<string> {
  return new Set(value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/).filter(word => word.length > 2));
}
function titleSimilarity(a: string, b: string): number {
  const left = titleTokens(a), right = titleTokens(b);
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const token of left) if (right.has(token)) overlap++;
  return overlap / (left.size + right.size - overlap);
}
async function findDuplicateArticle(env: Env, pageId: string, title: string, topic: string, sourceDomains: string[]) {
  const recent = await env.DB.prepare(`SELECT id,title,topic,source_domains,created_at FROM articles
    WHERE page_id=? AND created_at>=datetime('now','-21 days') AND status IN ('published','ready','awaiting_approval','draft')
    ORDER BY created_at DESC LIMIT 60`).bind(pageId).all<any>();
  const incomingDomains = new Set(sourceDomains.map(x => x.toLowerCase()));
  for (const candidate of recent.results) {
    const titleScore = titleSimilarity(title, String(candidate.title || ""));
    let previousDomains: string[] = [];
    try { previousDomains = JSON.parse(String(candidate.source_domains || "[]")); } catch { previousDomains = []; }
    const sourceOverlap = previousDomains.some(domain => incomingDomains.has(String(domain).toLowerCase()));
    const sameTopic = titleSimilarity(topic, String(candidate.topic || "")) >= 0.9;
    if (titleScore >= 0.88 || (titleScore >= 0.76 && sourceOverlap && sameTopic)) {
      return { id: String(candidate.id), title: String(candidate.title), similarity: Math.round(titleScore * 100), sourceOverlap };
    }
  }
  return null;
}

async function runPipeline(job: any, env: Env, page: PageRow, site: WebsiteRow) {
  await ensureJobContinuing(env, job.id);
  let topic = String(job.topic ?? "").trim();
  let research: any;
  let sources: Array<{ url: string; title: string; domain: string }> = [];
  if (topic) {
    await step(env, job.id, "research", "Researching the topic and checking current sources", "running", topic);
    await event(env, job.id, "info", "researching", 12, `Researching: ${topic}`);
    const result = await researchExplicitTopic(env, topic, page.content_type, page.language);
    research = result.research;
    sources = result.sources;
    await ensureJobContinuing(env, job.id);
  } else {
    await step(env, job.id, "topic_discovery", "Finding a relevant current topic", "running");
    await event(env, job.id, "info", "topic_discovery", 8, `Finding a current topic in ${page.content_type}.`);
    const result = await researchTopic(env, page.content_type, page.language);
    research = result.research;
    topic = String(research.topic);
    sources = result.sources;
    await ensureJobContinuing(env, job.id);
    await step(env, job.id, "topic_discovery", "Finding a relevant current topic", "completed", topic);
    await step(env, job.id, "research", "Researching the topic and checking current sources", "completed", `${sources.length} distinct source domains discovered`);
  }
  if (!topic) throw new Error("Research could not identify a usable topic");
  if (job.topic) await step(env, job.id, "research", "Researching the topic and checking current sources", "completed", `${sources.length} distinct source domains discovered`);

  await ensureJobContinuing(env, job.id);
  await step(env, job.id, "write_article", "Writing the article and Facebook caption", "running");
  await event(env, job.id, "info", "writing", 28, "Drafting the article, headings, labels and Facebook caption.");
  const profile = await env.DB.prepare("SELECT instructions,tone FROM content_profiles WHERE page_id=?").bind(page.id).first<any>();
  const article = await generateArticle(env, topic, page.language, page.content_type, research, sources, profile?.instructions ?? "");
  await ensureJobContinuing(env, job.id);
  await step(env, job.id, "write_article", "Writing the article and Facebook caption", "completed", `${article.title} (${safeHtmlText(article.html).length} characters)`);
  await step(env, job.id, "fact_check", "Cross-checking the article against independent sources", "running");
  await event(env, job.id, "info", "fact_checking", 44, "Cross-checking important claims and source consistency.");
  const checked = await factCheckArticle(env, article.title, article.html, article.important_claims, article.sources);
  await ensureJobContinuing(env, job.id);
  const sourceUrls = checked.sources.map(s => s.url);
  const domains = parseDomains(checked.sources);
  await step(env, job.id, "duplicate_check", "Checking whether this story has already been published on this Page", "running");
  await event(env, job.id, "info", "duplicate_check", 59, "Comparing title, topic and source overlap with recent Page articles.");
  const duplicate = await findDuplicateArticle(env, page.id, article.title, topic, domains);
  await step(env, job.id, "duplicate_check", "Checking whether this story has already been published on this Page", duplicate ? "failed" : "completed",
    duplicate ? `Possible duplicate of ${duplicate.title} (${duplicate.similarity}% title similarity).` : "No close match found in the last 21 days.");

  await step(env, job.id, "fact_check", "Cross-checking the article against independent sources", checked.approved ? "completed" : "failed",
    `${checked.confidence}% confidence; ${domains.length} independent domains. ${checked.reason}`);
  await event(env, job.id, checked.approved ? "info" : "warning", "fact_checking", 57,
    checked.approved ? `Automated checks passed with ${domains.length} independent source domains.` : `Needs review: ${checked.reason}`);

  let image: { key: string | null; url: string; credit: string } | null = null;
  let imageFailed = false;
  await ensureJobContinuing(env, job.id);
  await step(env, job.id, "image", "Finding a reusable image or generating an original one", "running");
  await event(env, job.id, "info", "image_processing", 62, `Preparing an image (${page.image_mode || "both"}).`);
  try {
    image = await createArticleImage(env, topic, article.title, page.image_mode || "both");
    await ensureJobContinuing(env, job.id);
    await step(env, job.id, "image", "Finding a reusable image or generating an original one", image ? "completed" : "skipped",
      image?.credit ?? "No image was returned; article will be text-only.");
  } catch (error) {
    imageFailed = true;
    await step(env, job.id, "image", "Finding a reusable image or generating an original one", "failed", safeError(error));
    await event(env, job.id, "warning", "image_processing", 65, `Image step failed. Continuing without an image: ${safeError(error)}`);
  }
  await ensureJobContinuing(env, job.id);
  const bodyHtml = await htmlWithAds(env, site.id, article.html, image);
  const articleId = uuid();
  const imageNeedsReview = !image || imageFailed;
  const needsApproval = !checked.approved || !!duplicate || imageNeedsReview || Number(job.auto_publish) !== 1 || job.job_type === "draft_only";
  await env.DB.prepare(`INSERT INTO articles
    (id,page_id,website_id,topic,title,body_html,facebook_caption,labels_json,image_r2_key,image_url,image_credit,
     source_urls,source_domains,verification_score,fact_check_status,status)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(articleId, page.id, site.id, topic, article.title, bodyHtml, article.facebook_caption,
      JSON.stringify(article.labels), image?.key ?? null, image?.url ?? null, image?.credit ?? null,
      JSON.stringify(sourceUrls), JSON.stringify(domains), checked.confidence,
      checked.approved ? "approved" : "needs_review", needsApproval ? "awaiting_approval" : "ready")
    .run();
  await env.DB.prepare("UPDATE publishing_jobs SET article_id=? WHERE id=?").bind(articleId, job.id).run();

  if (needsApproval) {
    const reason = duplicate ? `Possible duplicate detected. Similar recent article: ${duplicate.title} (${duplicate.similarity}% title similarity). Review before publishing.` : imageNeedsReview ? "Image preparation did not produce a usable image. Review the article and add/select an image before publishing." : checked.approved ? "AI preparation is complete. This Page is set to require manual approval." : `Human review is required. ${checked.reason}`;
    await event(env, job.id, "warning", duplicate ? "duplicate_review" : "awaiting_approval", 68, reason, "awaiting_approval");
    await audit(env, job.id, page.id, site.id, duplicate ? "possible_duplicate" : "article_prepared", "awaiting_approval", articleId);
    return;
  }
  await ensureJobContinuing(env, job.id);
  await publishArticle(job.id, articleId, env, page, site);
}

async function publishArticle(jobId: string, articleId: string, env: Env, page: PageRow, site: WebsiteRow) {
  await ensureJobContinuing(env, jobId);
  const article = await env.DB.prepare("SELECT * FROM articles WHERE id=?").bind(articleId).first<any>();
  if (!article) throw new Error("Article draft could not be found");
  if (article.status === "published") {
    await event(env, jobId, "success", "completed", 100, "This article was already published. Duplicate publishing was prevented.", "completed");
    return;
  }
  if (article.fact_check_status !== "approved") throw new Error("Article has not passed the automated checks or manual approval");
  let bloggerId = article.blogger_post_id as string | null;
  let bloggerUrl = article.blogger_url as string | null;
  if (!bloggerId || !bloggerUrl) {
    await step(env, jobId, "blogger_publish", "Publishing the article to Blogger", "running");
    await event(env, jobId, "info", "publishing_blogger", 74, `Publishing to ${site.name}.`);
    const labels = JSON.parse(String(article.labels_json || "[]")) as string[];
    const blogger = await publishBlogger(env, site, { id: articleId, title: article.title, html: article.body_html, labels });
    bloggerId = blogger.id;
    bloggerUrl = blogger.url;
    await env.DB.prepare("UPDATE articles SET blogger_post_id=?,blogger_url=? WHERE id=?").bind(bloggerId, bloggerUrl, articleId).run();
    await ensureJobContinuing(env, jobId);
    await step(env, jobId, "blogger_publish", "Publishing the article to Blogger", "completed", bloggerUrl);
  } else {
    await step(env, jobId, "blogger_publish", "Publishing the article to Blogger", "completed", `Recovered existing Blogger post ${bloggerId}`);
  }
  await ensureJobContinuing(env, jobId);
  let facebookId = article.facebook_post_id as string | null;
  if (!facebookId) {
    await step(env, jobId, "facebook_publish", "Publishing the Facebook Page post", "running");
    await event(env, jobId, "info", "publishing_facebook", 85, `Publishing to Facebook Page ${page.page_name}.`);
    const caption = String(article.facebook_caption || article.title);
    const fb = await publishFacebook(env, page, caption, bloggerUrl);
    facebookId = fb.id;
    await env.DB.prepare("UPDATE articles SET facebook_post_id=? WHERE id=?").bind(facebookId, articleId).run();
    await ensureJobContinuing(env, jobId);
    await step(env, jobId, "facebook_publish", "Publishing the Facebook Page post", "completed", `Facebook post ${facebookId}`);
  } else {
    await step(env, jobId, "facebook_publish", "Publishing the Facebook Page post", "completed", `Recovered existing Facebook post ${facebookId}`);
  }
  await ensureJobContinuing(env, jobId);
  let commentId = article.facebook_comment_id as string | null;
  if (!commentId) {
    await step(env, jobId, "link_comment", "Adding the Blogger link as a Facebook comment", "running");
    await event(env, jobId, "info", "link_comment", 94, "Adding the Blogger article link as the first Page comment.");
    const comment = await createFacebookLinkComment(env, page, facebookId, bloggerUrl);
    commentId = comment.id;
    await env.DB.prepare("UPDATE articles SET facebook_comment_id=? WHERE id=?").bind(commentId, articleId).run();
    await ensureJobContinuing(env, jobId);
    await step(env, jobId, "link_comment", "Adding the Blogger link as a Facebook comment", "completed", `Comment ${commentId}`);
    const pinned = await tryPinFacebookComment(env, page, commentId);
    await event(env, jobId, pinned.pinned ? "success" : "warning", "comment_pin", 97,
      pinned.pinned ? "Meta accepted the comment pin request." : `Comment created; pin status: ${pinned.reason}`);
  } else {
    await step(env, jobId, "link_comment", "Adding the Blogger link as a Facebook comment", "completed", `Recovered existing comment ${commentId}`);
  }
  await env.DB.prepare("UPDATE articles SET status='published',published_at=CURRENT_TIMESTAMP WHERE id=?").bind(articleId).run();
  await event(env, jobId, "success", "completed", 100, `Published successfully. Blogger: ${bloggerUrl}`, "completed");
  await audit(env, jobId, page.id, site.id, "publish", "success", bloggerUrl);
}

async function processJob(id: string, env: Env) {
  const job = await env.DB.prepare("SELECT * FROM publishing_jobs WHERE id=?").bind(id).first<any>();
  if (!job || !["queued", "processing"].includes(String(job.status))) return;
  if (!(await isGloballyEnabled(env))) {
    await event(env, id, "warning", "paused", Number(job.progress || 0), "Automation is globally paused. Job is waiting to resume.", "paused");
    return;
  }
  const page = await env.DB.prepare("SELECT * FROM facebook_pages WHERE id=? AND is_active=1").bind(job.page_id).first<PageRow>();
  const site = await env.DB.prepare("SELECT * FROM websites WHERE id=? AND is_active=1").bind(job.website_id).first<WebsiteRow>();
  if (!page || !site) {
    await event(env, id, "error", "blocked", 0, "The Facebook Page or Blogger website is disabled or missing.", "failed");
    return;
  }
  await env.DB.prepare("UPDATE publishing_jobs SET status='processing',paused_from_status=NULL,attempts=attempts+1,updated_at=CURRENT_TIMESTAMP WHERE id=?")
    .bind(id).run();
  try {
    if (job.article_id) {
      const existingArticle = await env.DB.prepare("SELECT status,fact_check_status FROM articles WHERE id=?").bind(job.article_id).first<any>();
      if (existingArticle?.status === "published") {
        await event(env, id, "success", "completed", 100, "This job's article is already published. Duplicate work was skipped.", "completed");
      } else if (existingArticle?.status === "ready" && existingArticle?.fact_check_status === "approved") {
        await publishArticle(id, job.article_id, env, page, site);
      } else if (job.job_type === "publish_existing") {
        await publishArticle(id, job.article_id, env, page, site);
      } else {
        await runPipeline(job, env, page, site);
      }
    } else if (job.job_type === "publish_existing") {
      throw new Error("Existing-article job has no article ID");
    } else {
      await runPipeline(job, env, page, site);
    }
  } catch (error) {
    if (error instanceof JobPausedError) {
      await event(env, id, "warning", "paused", Number(job.progress || 0), "Paused at a safe checkpoint. Resume will continue from the saved article/provider checkpoints.", "paused");
      return;
    }
    const message = safeError(error);
    const latest = await env.DB.prepare("SELECT attempts FROM publishing_jobs WHERE id=?").bind(id).first<any>();
    const attempts = Number(latest?.attempts ?? 1);
    await step(env, id, String(job.stage || "worker"), "Processing", "failed", message).catch(() => undefined);
    if (attempts >= 5) {
      await event(env, id, "error", "failed", Number(job.progress || 0), message, "failed");
    } else {
      await env.DB.prepare("UPDATE publishing_jobs SET status='queued',paused_from_status=NULL,stage='retry_wait',last_error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(message, id).run();
      await event(env, id, "warning", "retry_wait", Number(job.progress || 0), `Temporary error. Queue retry ${attempts}/5: ${message}`, "queued");
    }
    await audit(env, id, page.id, site.id, "publish", attempts >= 5 ? "failed" : "retry_scheduled", message);
    throw error;
  }
}

async function verifyTokenStatuses(env: Env) {
  const pages = await env.DB.prepare(`SELECT * FROM facebook_pages WHERE is_active=1 AND (last_token_check IS NULL OR last_token_check < datetime('now','-1 day')) LIMIT 20`).all<PageRow>();
  for (const page of pages.results) {
    try {
      await verifyFacebookPage(env, page);
      await env.DB.prepare("UPDATE facebook_pages SET token_status='valid',last_token_check=CURRENT_TIMESTAMP WHERE id=?").bind(page.id).run();
    } catch (error) {
      await env.DB.prepare("UPDATE facebook_pages SET token_status='invalid',last_token_check=CURRENT_TIMESTAMP WHERE id=?").bind(page.id).run();
      await audit(env, null, page.id, null, "facebook_token_check", "failed", safeError(error));
    }
  }
}

function validateAdCode(code: string, allowedDomains: string[]) {
  if (code.length > 100_000) throw new Error("Ad code exceeds 100 KB");
  if (/javascript\s*:/i.test(code) || /\son[a-z]+\s*=/i.test(code)) throw new Error("Ad code contains an unsafe URL or inline event handler");
  const refs = [...code.matchAll(/(?:src|href)\s*=\s*['"]([^'"]+)['"]/gi)].map(m => m[1]);
  if (!refs.length) throw new Error("Ad code must load from an HTTPS provider URL; inline-only code is not accepted");
  for (const ref of refs) {
    const url = new URL(ref.startsWith("//") ? `https:${ref}` : ref);
    if (url.protocol !== "https:") throw new Error("Ad resource URLs must use HTTPS");
    const host = url.hostname.toLowerCase();
    if (!allowedDomains.some(domain => host === domain || host.endsWith(`.${domain}`))) {
      throw new Error(`Ad host ${host} is not in this network's allowed domains`);
    }
  }
}

async function createGoogleOAuthUrl(env: Env, websiteId: string) {
  if (!env.BLOGGER_CLIENT_ID) throw new Error("BLOGGER_CLIENT_ID is not configured");
  const redirect = env.GOOGLE_OAUTH_REDIRECT_URI || `${(env.PUBLIC_BASE_URL || "").replace(/\/$/, "")}/oauth/google/callback`;
  if (!redirect.startsWith("https://")) throw new Error("Set GOOGLE_OAUTH_REDIRECT_URI to the HTTPS Worker callback URL");
  const state = uuid();
  const expires = new Date(Date.now() + 10 * 60_000).toISOString();
  await env.DB.prepare("INSERT INTO oauth_states(state,website_id,expires_at) VALUES(?,?,?)").bind(state, websiteId, expires).run();
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: env.BLOGGER_CLIENT_ID, redirect_uri: redirect, response_type: "code",
    scope: "https://www.googleapis.com/auth/blogger", access_type: "offline", prompt: "consent",
    include_granted_scopes: "true", state
  }).toString();
  return url.toString();
}

async function handleGoogleOAuthCallback(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const state = url.searchParams.get("state") || "";
  const code = url.searchParams.get("code") || "";
  const row = await env.DB.prepare("SELECT * FROM oauth_states WHERE state=? AND expires_at>? ").bind(state, new Date().toISOString()).first<any>();
  if (!row || !code) return new Response("Google Blogger connection could not be verified. Return to Jarvis and start the connection again.", { status: 400 });
  await env.DB.prepare("DELETE FROM oauth_states WHERE state=?").bind(state).run();
  if (!env.BLOGGER_CLIENT_ID || !env.BLOGGER_CLIENT_SECRET) return new Response("Google OAuth credentials are missing on the backend.", { status: 500 });
  const redirect = env.GOOGLE_OAUTH_REDIRECT_URI || `${(env.PUBLIC_BASE_URL || "").replace(/\/$/, "")}/oauth/google/callback`;
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: env.BLOGGER_CLIENT_ID, client_secret: env.BLOGGER_CLIENT_SECRET, redirect_uri: redirect, grant_type: "authorization_code" })
  });
  const tokens = await tokenResponse.json() as any;
  if (!tokenResponse.ok || !tokens.refresh_token) return new Response("Google did not return a refresh token. Reconnect and approve the Blogger access request.", { status: 400 });
  const encrypted = await encryptSecret(String(tokens.refresh_token), env);
  await env.DB.prepare("UPDATE websites SET refresh_token_ciphertext=?,connection_status='connected',last_connection_check=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?")
    .bind(encrypted, row.website_id).run();
  return new Response(`<!doctype html><meta name="viewport" content="width=device-width"><body style="font:16px system-ui;background:#10141d;color:white;padding:32px"><h2>Jarvis connected to Blogger</h2><p>Return to the Jarvis Automation screen. You can now verify this website and schedule posts.</p></body>`, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }
  });
}

async function createThemePatch(env: Env, websiteId: string, template: string) {
  if (template.length > 2_000_000) throw new Error("Blogger theme XML exceeds 2 MB");
  if (!/<head\b[^>]*>/i.test(template) || !/<\/head>/i.test(template) || !/<body\b[^>]*>/i.test(template) || !/<\/body>/i.test(template)) {
    throw new Error("The uploaded file does not look like a Blogger XML theme (head/body elements missing)");
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(template)) throw new Error("DOCTYPE and entity declarations are not accepted in a Blogger template");
  const rows = await env.DB.prepare(`SELECT u.placement,u.unit_name,u.code_ciphertext,n.network_name FROM ad_units u
    JOIN ad_networks n ON n.id=u.network_id WHERE n.website_id=? AND n.is_active=1 AND u.is_active=1 ORDER BY u.created_at`).bind(websiteId).all<any>();
  const snippets: Record<string, string[]> = { head: [], top: [], middle: [], bottom: [], footer: [] };
  for (const row of rows.results) {
    const code = await decryptSecret(row.code_ciphertext, env);
    snippets[String(row.placement)].push(`<!-- Jarvis ${String(row.network_name)} / ${String(row.unit_name)} -->\n${code}`);
  }
  // Template changes are generated for operator review/import. Blogger API v3 has no theme-update method.
  let patched = template;
  if (snippets.head.length) patched = patched.replace(/<\/head>/i, `${snippets.head.join("\n")}\n</head>`);
  if (snippets.top.length) patched = patched.replace(/<body\b[^>]*>/i, match => `${match}\n${snippets.top.join("\n")}`);
  if (snippets.middle.length) {
    const bodyTag = /<data:post\.body\s*\/>/i;
    if (!bodyTag.test(patched)) throw new Error("Could not find Blogger's data:post.body marker. Choose a different theme or insert the middle placement manually.");
    patched = patched.replace(bodyTag, `${snippets.middle.join("\n")}\n<data:post.body/>`);
  }
  if (snippets.bottom.length || snippets.footer.length) patched = patched.replace(/<\/body>/i, `${[...snippets.bottom, ...snippets.footer].join("\n")}\n</body>`);
  await env.DB.prepare("UPDATE websites SET theme_patch_generated_at=CURRENT_TIMESTAMP WHERE id=?").bind(websiteId).run();
  return { patched_template: patched, placements: Object.fromEntries(Object.entries(snippets).map(([key, values]) => [key, values.length])), requires_manual_import: true };
}

async function handle(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method.toUpperCase();

  if (method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req, env) });
  if (path === "/health" && method === "GET") return json({ ok: true, service: "jarvis-cloud-automation", version: "2.0.0", time: new Date().toISOString() });
  if (path === "/oauth/google/callback" && method === "GET") return handleGoogleOAuthCallback(req, env);

  if (path === "/" || path === "/automation" || path === "/automation/") {
    const assetUrl = new URL("/automation.html", req.url);
    return env.ASSETS.fetch(new Request(assetUrl, req));
  }
  if (path.startsWith("/assets/")) return env.ASSETS.fetch(req);
  if (unauthorized(req, env)) return json({ error: "unauthorized", message: "Use the Jarvis cloud admin key." }, 401);

  if (path === "/api/dashboard" && method === "GET") {
    const [control, pages, websites, jobs, pending, articles, networks] = await Promise.all([
      env.DB.prepare("SELECT global_enabled,pause_reason,updated_at FROM system_control WHERE id=1").first<any>(),
      env.DB.prepare(`SELECT p.id,p.page_name,p.page_id,p.content_type,p.language,p.daily_limit,p.min_gap_minutes,p.active_from,p.active_until,p.timezone,p.image_mode,p.is_active,p.automation_enabled,p.auto_publish,p.token_status,
        (SELECT MIN(j.scheduled_at) FROM publishing_jobs j WHERE j.page_id=p.id AND j.status='scheduled' AND j.scheduled_at>=strftime('%Y-%m-%dT%H:%M:%SZ','now')) AS next_slot,
        (SELECT j.status FROM publishing_jobs j WHERE j.page_id=p.id ORDER BY j.created_at DESC LIMIT 1) AS latest_job_status,
        (SELECT j.stage FROM publishing_jobs j WHERE j.page_id=p.id ORDER BY j.created_at DESC LIMIT 1) AS latest_job_stage,
        (SELECT j.progress FROM publishing_jobs j WHERE j.page_id=p.id ORDER BY j.created_at DESC LIMIT 1) AS latest_job_progress,
        (SELECT j.updated_at FROM publishing_jobs j WHERE j.page_id=p.id ORDER BY j.created_at DESC LIMIT 1) AS latest_job_updated,
        m.website_id,w.name AS website_name,w.blog_url,w.is_active AS website_active,w.connection_status
        FROM facebook_pages p LEFT JOIN page_website_mappings m ON m.facebook_page_id=p.id LEFT JOIN websites w ON w.id=m.website_id ORDER BY p.created_at DESC`).all<any>(),
      env.DB.prepare("SELECT id,name,blog_id,blog_url,language,timezone,is_active,connection_status,last_connection_check,theme_patch_generated_at FROM websites ORDER BY created_at DESC").all<any>(),
      env.DB.prepare(`SELECT COUNT(*) AS n FROM publishing_jobs WHERE status IN ('scheduled','queued','processing')`).first<any>(),
      env.DB.prepare("SELECT COUNT(*) AS n FROM publishing_jobs WHERE status='awaiting_approval'").first<any>(),
      env.DB.prepare("SELECT COUNT(*) AS n FROM articles").first<any>(),
      env.DB.prepare("SELECT COUNT(*) AS n FROM ad_networks WHERE is_active=1").first<any>()
    ]);
    return json({
      globalEnabled: Number(control?.global_enabled ?? 1) === 1, pauseReason: control?.pause_reason ?? null,
      pages: pages.results, websites: websites.results,
      counts: { pages: pages.results.length, websites: websites.results.length, activeJobs: Number(jobs?.n ?? 0), awaitingApproval: Number(pending?.n ?? 0), articles: Number(articles?.n ?? 0), adNetworks: Number(networks?.n ?? 0) }
    });
  }
  if (path === "/api/status" && method === "GET") {
    const rows = await env.DB.prepare(`SELECT j.id,j.page_id,p.page_name,j.website_id,w.name AS website_name,j.article_id,j.job_type,j.trigger_source,j.scheduled_at,j.timezone,j.status,j.stage,j.progress,j.last_error,j.updated_at
      FROM publishing_jobs j LEFT JOIN facebook_pages p ON p.id=j.page_id LEFT JOIN websites w ON w.id=j.website_id
      WHERE j.status IN ('scheduled','queued','processing','awaiting_approval','failed','duplicate_skipped') ORDER BY j.updated_at DESC LIMIT 100`).all<any>();
    return json({ globalEnabled: await isGloballyEnabled(env), activeTasks: rows.results });
  }

  if (path === "/api/pages" && method === "GET") {
    const rows = await env.DB.prepare(`SELECT id,page_name,page_id,content_type,language,daily_limit,min_gap_minutes,active_from,active_until,timezone,image_mode,is_active,automation_enabled,auto_publish,token_status,last_token_check,created_at FROM facebook_pages ORDER BY created_at DESC`).all();
    return json(rows.results);
  }
  if (path === "/api/pages" && method === "POST") {
    const b = await body<any>(req);
    for (const key of ["page_name", "page_id", "page_token", "content_type"]) if (!b[key]) return json({ error: `${key} is required` }, 400);
    const pageToken = String(b.page_token);
    if (pageToken.length < 20 || pageToken.length > 10_000) return json({ error: "Page token length is invalid" }, 400);
    const id = uuid();
    const cipher = await encryptSecret(pageToken, env);
    const timezone = validateTimezone(b.timezone || "Asia/Kolkata");
    const daily = Math.max(0, Math.min(50, Number(b.daily_limit ?? 3)));
    const gap = Math.max(15, Math.min(1440, Number(b.min_gap_minutes ?? 90)));
    const activeFrom = validateTime(b.active_from ?? "08:00", "active_from");
    const activeUntil = validateTime(b.active_until ?? "22:00", "active_until");
    if (activeUntil <= activeFrom) return json({ error: "active_until must be later than active_from" }, 400);
    const imageMode = String(b.image_mode ?? "both");
    if (!["both", "commons_only"].includes(imageMode)) return json({ error: "image_mode must be both or commons_only in this R2-free build" }, 400);
    await env.DB.prepare(`INSERT INTO facebook_pages
      (id,page_name,page_id,token_ciphertext,content_type,language,daily_limit,min_gap_minutes,active_from,active_until,timezone,image_mode,is_active,automation_enabled,auto_publish)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, String(b.page_name).slice(0, 120), String(b.page_id), cipher, String(b.content_type).slice(0, 120), String(b.language ?? "en"), daily, gap, activeFrom, activeUntil, timezone, imageMode, asBool(b.is_active) ?? 1, asBool(b.automation_enabled) ?? 0, asBool(b.auto_publish) ?? 1).run();
    await env.DB.prepare("INSERT INTO content_profiles(id,page_id,content_type,language,image_mode,instructions) VALUES(?,?,?,?,?,?)")
      .bind(uuid(), id, String(b.content_type), String(b.language ?? "en"), imageMode, String(b.instructions ?? "").slice(0, 3000)).run();
    return json({ id, created: true, note: "Page saved. Run Verify connection before enabling auto publishing." }, 201);
  }
  const pageMatch = path.match(/^\/api\/pages\/([^/]+)$/);
  if (pageMatch && method === "PATCH") {
    const id = pageMatch[1];
    const before = await env.DB.prepare("SELECT is_active,automation_enabled,active_from,active_until FROM facebook_pages WHERE id=?").bind(id).first<any>();
    if (!before) return json({ error: "Facebook Page not found" }, 404);
    const b = await body<any>(req);
    const allowed: Record<string, string> = {
      page_name: "page_name", content_type: "content_type", language: "language", daily_limit: "daily_limit",
      min_gap_minutes: "min_gap_minutes", active_from: "active_from", active_until: "active_until", timezone: "timezone",
      image_mode: "image_mode", is_active: "is_active", automation_enabled: "automation_enabled", auto_publish: "auto_publish"
    };
    const sets: string[] = [], values: any[] = [];
    for (const [key, column] of Object.entries(allowed)) {
      if (b[key] === undefined) continue;
      let value: any = b[key];
      if (["is_active", "automation_enabled", "auto_publish"].includes(key)) value = asBool(value);
      if (value === undefined) return json({ error: `${key} must be boolean` }, 400);
      if (key === "timezone") value = validateTimezone(value);
      if (key === "active_from" || key === "active_until") value = validateTime(value, key);
      if (key === "image_mode" && !["both", "commons_only"].includes(String(value))) return json({ error: "Invalid image_mode for R2-free build" }, 400);
      if (key === "daily_limit") {
        const number = Number(value);
        if (!Number.isFinite(number)) return json({ error: "daily_limit must be a number" }, 400);
        value = Math.max(0, Math.min(50, Math.floor(number)));
      }
      if (key === "min_gap_minutes") {
        const number = Number(value);
        if (!Number.isFinite(number)) return json({ error: "min_gap_minutes must be a number" }, 400);
        value = Math.max(15, Math.min(1440, Math.floor(number)));
      }
      sets.push(`${column}=?`); values.push(value);
    }
    const proposedFrom = b.active_from === undefined ? String(before.active_from) : validateTime(b.active_from, "active_from");
    const proposedUntil = b.active_until === undefined ? String(before.active_until) : validateTime(b.active_until, "active_until");
    if (proposedUntil <= proposedFrom) return json({ error: "active_until must be later than active_from" }, 400);
    if (b.page_token) { sets.push("token_ciphertext=?"); values.push(await encryptSecret(String(b.page_token), env)); }
    if (!sets.length) return json({ error: "No supported fields supplied" }, 400);
    sets.push("updated_at=CURRENT_TIMESTAMP"); values.push(id);
    const result = await env.DB.prepare(`UPDATE facebook_pages SET ${sets.join(",")} WHERE id=?`).bind(...values).run();
    const nextActive = b.is_active === undefined ? Number(before.is_active) === 1 : asBool(b.is_active) === 1;
    const nextAutomation = b.automation_enabled === undefined ? Number(before.automation_enabled) === 1 : asBool(b.automation_enabled) === 1;
    const schedulingChanged = ["daily_limit", "min_gap_minutes", "active_from", "active_until", "timezone"].some(key => b[key] !== undefined);
    if (!nextActive || !nextAutomation || schedulingChanged) {
      const autoOnly = nextActive;
      const scope = autoOnly ? " AND trigger_source='automatic'" : "";
      await env.DB.prepare(`UPDATE publishing_jobs SET status='cancelled',stage='cancelled',last_error='Cancelled because Page automation/settings changed',updated_at=CURRENT_TIMESTAMP WHERE page_id=? AND status='scheduled'${scope}`).bind(id).run();
      await env.DB.prepare(`UPDATE publishing_jobs SET paused_from_status=COALESCE(paused_from_status,'queued'),status='paused',stage='paused',updated_at=CURRENT_TIMESTAMP WHERE page_id=? AND status IN ('queued','processing')${scope}`).bind(id).run();
      await env.DB.prepare("DELETE FROM page_schedule_days WHERE page_id=?").bind(id).run();
    } else if (nextActive && nextAutomation &&
      (Number(before.is_active) !== 1 || Number(before.automation_enabled) !== 1)) {
      await env.DB.prepare("DELETE FROM page_schedule_days WHERE page_id=?").bind(id).run();
    }
    return json({ updated: result.meta.changes > 0, page_active: nextActive, automation_enabled: nextAutomation });
  }
  if (pageMatch && method === "DELETE") {
    const result = await env.DB.prepare("DELETE FROM facebook_pages WHERE id=?").bind(pageMatch[1]).run();
    return json({ deleted: result.meta.changes > 0 });
  }
  const pageVerify = path.match(/^\/api\/pages\/([^/]+)\/verify$/);
  if (pageVerify && method === "POST") {
    const page = await env.DB.prepare("SELECT * FROM facebook_pages WHERE id=?").bind(pageVerify[1]).first<PageRow>();
    if (!page) return json({ error: "Page not found" }, 404);
    const verified = await verifyFacebookPage(env, page);
    await env.DB.prepare("UPDATE facebook_pages SET page_name=?,token_status='valid',last_token_check=CURRENT_TIMESTAMP WHERE id=?")
      .bind(verified.name, page.id).run();
    return json({ verified: true, page: verified });
  }

  if (path === "/api/websites" && method === "GET") {
    const rows = await env.DB.prepare(`SELECT id,name,platform,blog_id,blog_url,language,timezone,is_active,connection_status,last_connection_check,theme_patch_generated_at,created_at FROM websites ORDER BY created_at DESC`).all();
    return json(rows.results);
  }
  if (path === "/api/websites" && method === "POST") {
    const b = await body<any>(req);
    for (const key of ["name", "blog_id", "blog_url"]) if (!b[key]) return json({ error: `${key} is required` }, 400);
    const id = uuid();
    const blogUrl = new URL(String(b.blog_url));
    if (blogUrl.protocol !== "https:") return json({ error: "blog_url must use HTTPS" }, 400);
    const refreshCipher = b.blogger_refresh_token ? await encryptSecret(String(b.blogger_refresh_token), env) : null;
    const timezone = validateTimezone(b.timezone || "Asia/Kolkata");
    await env.DB.prepare(`INSERT INTO websites(id,name,blog_id,blog_url,refresh_token_ciphertext,language,timezone,connection_status)
      VALUES(?,?,?,?,?,?,?,?)`)
      .bind(id, String(b.name).slice(0, 120), String(b.blog_id), blogUrl.toString(), refreshCipher, String(b.language ?? "en"), timezone, refreshCipher ? "connected" : "not_connected").run();
    return json({ id, created: true, oauth_required: !refreshCipher }, 201);
  }
  const siteMatch = path.match(/^\/api\/websites\/([^/]+)$/);
  if (siteMatch && method === "PATCH") {
    const before = await env.DB.prepare("SELECT is_active FROM websites WHERE id=?").bind(siteMatch[1]).first<any>();
    if (!before) return json({ error: "Website not found" }, 404);
    const b = await body<any>(req), sets: string[] = [], values: any[] = [];
    for (const key of ["name", "blog_url", "language", "is_active", "timezone"]) {
      if (b[key] === undefined) continue;
      let value: any = b[key];
      if (key === "is_active") value = asBool(value);
      if (key === "timezone") value = validateTimezone(value);
      if (key === "blog_url") { const parsed = new URL(String(value)); if (parsed.protocol !== "https:") return json({ error: "blog_url must use HTTPS" }, 400); value = parsed.toString(); }
      sets.push(`${key}=?`); values.push(value);
    }
    if (b.blogger_refresh_token) { sets.push("refresh_token_ciphertext=?"); values.push(await encryptSecret(String(b.blogger_refresh_token), env)); sets.push("connection_status='connected'"); }
    if (!sets.length) return json({ error: "No supported fields supplied" }, 400);
    sets.push("updated_at=CURRENT_TIMESTAMP"); values.push(siteMatch[1]);
    const result = await env.DB.prepare(`UPDATE websites SET ${sets.join(",")} WHERE id=?`).bind(...values).run();
    const nextActive = b.is_active === undefined ? Number(before.is_active) === 1 : asBool(b.is_active) === 1;
    if (!nextActive) {
      await env.DB.prepare("UPDATE publishing_jobs SET status='cancelled',stage='cancelled',last_error='Cancelled because Blogger website was disabled',updated_at=CURRENT_TIMESTAMP WHERE website_id=? AND status='scheduled'").bind(siteMatch[1]).run();
      await env.DB.prepare("UPDATE publishing_jobs SET paused_from_status=COALESCE(paused_from_status,'queued'),status='paused',stage='paused',updated_at=CURRENT_TIMESTAMP WHERE website_id=? AND status IN ('queued','processing')").bind(siteMatch[1]).run();
    } else if (b.is_active !== undefined) {
      await env.DB.prepare("DELETE FROM page_schedule_days WHERE page_id IN (SELECT facebook_page_id FROM page_website_mappings WHERE website_id=?)").bind(siteMatch[1]).run();
    }
    return json({ updated: result.meta.changes > 0, website_active: nextActive });
  }
  if (siteMatch && method === "DELETE") {
    const result = await env.DB.prepare("DELETE FROM websites WHERE id=?").bind(siteMatch[1]).run();
    return json({ deleted: result.meta.changes > 0 });
  }
  const bloggerVerify = path.match(/^\/api\/websites\/([^/]+)\/verify$/);
  if (bloggerVerify && method === "POST") {
    const site = await env.DB.prepare("SELECT * FROM websites WHERE id=?").bind(bloggerVerify[1]).first<WebsiteRow>();
    if (!site) return json({ error: "Website not found" }, 404);
    const verified = await verifyBlogger(env, site);
    await env.DB.prepare("UPDATE websites SET connection_status='connected',last_connection_check=CURRENT_TIMESTAMP WHERE id=?").bind(site.id).run();
    return json({ verified: true, website: verified });
  }
  const bloggerOAuth = path.match(/^\/api\/websites\/([^/]+)\/oauth-url$/);
  if (bloggerOAuth && method === "POST") {
    const exists = await env.DB.prepare("SELECT id FROM websites WHERE id=?").bind(bloggerOAuth[1]).first<any>();
    if (!exists) return json({ error: "Website not found" }, 404);
    const authorization_url = await createGoogleOAuthUrl(env, bloggerOAuth[1]);
    return json({ authorization_url });
  }

  if (path === "/api/connectors/facebook/guide" && method === "GET") {
    return json({
      provider: "Meta Facebook Pages", graphVersion: env.META_GRAPH_VERSION || "v26.0",
      steps: ["Create or select a Meta Developer App and connect it to the correct Business Portfolio.", "Create a Business System User and assign the app and each Facebook Page asset to that user.", "Generate a Page access token for the assigned Page.", "Request only the permissions needed: pages_show_list, pages_read_engagement, pages_manage_posts and pages_manage_engagement. Meta review or business verification may be required for production access.", "Paste the Page ID and Page access token into Jarvis, then use Verify connection."],
      note: "Do not assume a System User token never expires. Jarvis checks the Page token and stores the validation timestamp. Token issuance and app review are controlled by Meta, not by Jarvis."
    });
  }

  if (path === "/api/mappings" && method === "GET") {
    const rows = await env.DB.prepare(`SELECT m.id,m.facebook_page_id,p.page_name,m.website_id,w.name AS website_name,w.blog_url FROM page_website_mappings m JOIN facebook_pages p ON p.id=m.facebook_page_id JOIN websites w ON w.id=m.website_id ORDER BY p.page_name`).all();
    return json(rows.results);
  }
  if (path === "/api/mappings" && method === "POST") {
    const b = await body<any>(req);
    if (!b.facebook_page_id || !b.website_id) return json({ error: "facebook_page_id and website_id are required" }, 400);
    const id = uuid();
    await env.DB.prepare("INSERT INTO page_website_mappings(id,facebook_page_id,website_id) VALUES(?,?,?)").bind(id, b.facebook_page_id, b.website_id).run();
    return json({ id, created: true }, 201);
  }
  const mappingMatch = path.match(/^\/api\/mappings\/([^/]+)$/);
  if (mappingMatch && method === "DELETE") {
    const result = await env.DB.prepare("DELETE FROM page_website_mappings WHERE id=?").bind(mappingMatch[1]).run();
    return json({ deleted: result.meta.changes > 0 });
  }

  if (path === "/api/ads/networks" && method === "GET") {
    const rows = await env.DB.prepare(`SELECT n.id,n.website_id,n.network_name,n.allowed_domains,n.reporting_provider,n.report_config,n.last_stats_sync,n.stats_sync_status,n.stats_error,n.is_active,COUNT(u.id) AS units FROM ad_networks n LEFT JOIN ad_units u ON u.network_id=n.id GROUP BY n.id ORDER BY n.created_at DESC`).all<any>();
    return json(rows.results.map(x => ({ ...x, allowed_domains: JSON.parse(x.allowed_domains || "[]"), report_config: JSON.parse(x.report_config || "{}") })));
  }
  if (path === "/api/ads/networks" && method === "POST") {
    const b = await body<any>(req);
    if (!b.website_id || !b.network_name) return json({ error: "website_id and network_name are required" }, 400);
    const domains = Array.isArray(b.allowed_domains) ? b.allowed_domains.map((x: unknown) => String(x).toLowerCase().replace(/^\*\./, "")).filter(Boolean) : [];
    if (domains.some((d: string) => !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(d))) return json({ error: "Invalid allowed domain" }, 400);
    const id = uuid();
    await env.DB.prepare("INSERT INTO ad_networks(id,website_id,network_name,allowed_domains) VALUES(?,?,?,?)")
      .bind(id, b.website_id, String(b.network_name).slice(0, 120), JSON.stringify(domains)).run();
    return json({ id, created: true }, 201);
  }
  const networkReportingMatch = path.match(/^\/api\/ads\/networks\/([^/]+)\/reporting$/);
  if (networkReportingMatch && method === "POST") {
    const b = await body<any>(req);
    const provider = String(b.provider || "none");
    if (!["none", "adsterra", "manual"].includes(provider)) return json({ error: "provider must be none, adsterra, or manual" }, 400);
    if (provider === "adsterra") {
      if (!b.api_token || String(b.api_token).length < 12 || String(b.api_token).length > 5000) return json({ error: "A valid Adsterra Publisher API token is required" }, 400);
      if (!/^\d+$/.test(String(b.domain_id || ""))) return json({ error: "A numeric Adsterra domain ID is required" }, 400);
    }
    const tokenCipher = provider === "adsterra" ? await encryptSecret(String(b.api_token), env) : null;
    const config = provider === "adsterra" ? { domain_id: String(b.domain_id), placement_id: b.placement_id ? String(b.placement_id) : "" } : {};
    const result = await env.DB.prepare(`UPDATE ad_networks SET reporting_provider=?,api_token_ciphertext=?,report_config=?,last_stats_sync=NULL,stats_sync_status=?,stats_error=NULL WHERE id=?`)
      .bind(provider, tokenCipher, JSON.stringify(config), provider === "none" ? "not_configured" : "pending", networkReportingMatch[1]).run();
    if (!result.meta.changes) return json({ error: "Ad network not found" }, 404);
    return json({ configured: true, provider });
  }
  const networkSyncMatch = path.match(/^\/api\/ads\/networks\/([^/]+)\/sync$/);
  if (networkSyncMatch && method === "POST") {
    try {
      const result = await syncAdsterraNetwork(env, networkSyncMatch[1], 30);
      return json(result);
    } catch (error) {
      const detail = safeError(error).slice(0, 500);
      await env.DB.prepare("UPDATE ad_networks SET stats_sync_status='error',stats_error=?,last_stats_sync=CURRENT_TIMESTAMP WHERE id=?").bind(detail, networkSyncMatch[1]).run();
      return json({ error: detail }, 502);
    }
  }
  if (path === "/api/ads/revenue" && method === "GET") {
    const websiteId = url.searchParams.get("website_id");
    const from = url.searchParams.get("from") || new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
    const to = url.searchParams.get("to") || new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) return json({ error: "from/to must be valid YYYY-MM-DD dates" }, 400);
    if ((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86400000 > 92) return json({ error: "Report range cannot exceed 93 days" }, 400);
    const filter = websiteId ? "AND r.website_id=?" : "";
    const binds = websiteId ? [from, to, websiteId] : [from, to];
    const [networkRows, dailyRows] = await Promise.all([
      env.DB.prepare(`SELECT r.network_id,n.network_name,r.website_id,w.name AS website_name,r.currency,SUM(r.impressions) AS impressions,SUM(r.clicks) AS clicks,CASE WHEN SUM(r.impressions)>0 THEN SUM(r.clicks)*100.0/SUM(r.impressions) ELSE 0 END AS ctr,CASE WHEN SUM(r.impressions)>0 THEN SUM(r.revenue)*1000.0/SUM(r.impressions) ELSE 0 END AS cpm,SUM(r.revenue) AS revenue FROM ad_revenue_daily r JOIN ad_networks n ON n.id=r.network_id JOIN websites w ON w.id=r.website_id WHERE r.report_date BETWEEN ? AND ? ${filter} GROUP BY r.network_id,r.currency ORDER BY revenue DESC`).bind(...binds).all<any>(),
      env.DB.prepare(`SELECT r.report_date,r.currency,SUM(r.impressions) AS impressions,SUM(r.clicks) AS clicks,SUM(r.revenue) AS revenue FROM ad_revenue_daily r WHERE r.report_date BETWEEN ? AND ? ${filter} GROUP BY r.report_date,r.currency ORDER BY r.report_date`).bind(...binds).all<any>()
    ]);
    return json({ from, to, byNetwork: networkRows.results, daily: dailyRows.results });
  }
  if (path === "/api/ads/revenue/import" && method === "POST") {
    const b = await body<any>(req);
    if (!b.network_id || !Array.isArray(b.rows) || b.rows.length < 1 || b.rows.length > 1000) return json({ error: "network_id and 1-1000 daily rows are required" }, 400);
    const network = await env.DB.prepare("SELECT id,website_id FROM ad_networks WHERE id=?").bind(b.network_id).first<any>();
    if (!network) return json({ error: "Ad network not found" }, 404);
    let saved = 0;
    for (const row of b.rows) {
      const date = String(row.date || row.report_date || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const impressions = Math.max(0, Math.round(Number(row.impressions) || 0));
      const clicks = Math.max(0, Math.round(Number(row.clicks) || 0));
      const revenue = Math.max(0, Number(row.revenue) || 0);
      const ctr = Math.max(0, Number(row.ctr) || (impressions ? clicks * 100 / impressions : 0));
      const cpm = Math.max(0, Number(row.cpm) || (impressions ? revenue * 1000 / impressions : 0));
      await env.DB.prepare(`INSERT INTO ad_revenue_daily(id,network_id,website_id,report_date,currency,impressions,clicks,ctr,cpm,revenue,dimension_key,raw_json,fetched_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,'manual','{}',CURRENT_TIMESTAMP)
        ON CONFLICT(network_id,report_date,dimension_key) DO UPDATE SET currency=excluded.currency,impressions=excluded.impressions,clicks=excluded.clicks,ctr=excluded.ctr,cpm=excluded.cpm,revenue=excluded.revenue,fetched_at=CURRENT_TIMESTAMP`)
        .bind(uuid(), network.id, network.website_id, date, String(row.currency || "USD").slice(0, 8), impressions, clicks, ctr, cpm, revenue).run();
      saved++;
    }
    return json({ imported: saved });
  }
  const networkMatch = path.match(/^\/api\/ads\/networks\/([^/]+)$/);
  if (networkMatch && method === "PATCH") {
    const b = await body<any>(req), sets: string[] = [], values: any[] = [];
    if (b.network_name !== undefined) { sets.push("network_name=?"); values.push(String(b.network_name).slice(0, 120)); }
    if (b.is_active !== undefined) { const value = asBool(b.is_active); if (value === undefined) return json({ error: "is_active must be boolean" }, 400); sets.push("is_active=?"); values.push(value); }
    if (b.allowed_domains !== undefined) {
      const domains = Array.isArray(b.allowed_domains) ? b.allowed_domains.map((x: unknown) => String(x).toLowerCase().replace(/^\*\./, "")).filter(Boolean) : [];
      if (domains.some((d: string) => !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(d))) return json({ error: "Invalid allowed domain" }, 400);
      const units = await env.DB.prepare("SELECT code_ciphertext FROM ad_units WHERE network_id=?").bind(networkMatch[1]).all<any>();
      for (const unit of units.results) validateAdCode(await decryptSecret(String(unit.code_ciphertext), env), domains);
      sets.push("allowed_domains=?"); values.push(JSON.stringify(domains));
    }
    if (!sets.length) return json({ error: "No supported fields supplied" }, 400);
    values.push(networkMatch[1]);
    const result = await env.DB.prepare(`UPDATE ad_networks SET ${sets.join(",")} WHERE id=?`).bind(...values).run();
    return json({ updated: result.meta.changes > 0 });
  }
  if (networkMatch && method === "DELETE") {
    const result = await env.DB.prepare("DELETE FROM ad_networks WHERE id=?").bind(networkMatch[1]).run();
    return json({ deleted: result.meta.changes > 0 });
  }
  if (path === "/api/ads/units" && method === "GET") {
    const websiteId = url.searchParams.get("website_id");
    if (!websiteId) return json({ error: "website_id query parameter is required" }, 400);
    const rows = await env.DB.prepare(`SELECT u.id,u.unit_name,u.format,u.placement,u.is_active,n.network_name,n.id AS network_id FROM ad_units u JOIN ad_networks n ON n.id=u.network_id WHERE n.website_id=? ORDER BY u.created_at`).bind(websiteId).all();
    return json(rows.results);
  }
  if (path === "/api/ads/units" && method === "POST") {
    const b = await body<any>(req);
    for (const key of ["network_id", "unit_name", "format", "code", "placement"]) if (!b[key]) return json({ error: `${key} is required` }, 400);
    const network = await env.DB.prepare("SELECT allowed_domains FROM ad_networks WHERE id=?").bind(b.network_id).first<any>();
    if (!network) return json({ error: "Ad network not found" }, 404);
    const domains = JSON.parse(String(network.allowed_domains || "[]")) as string[];
    if (!domains.length) return json({ error: "Add trusted HTTPS domains to this ad network before saving code" }, 400);
    validateAdCode(String(b.code), domains);
    if (!["head", "top", "middle", "bottom", "footer"].includes(String(b.placement))) return json({ error: "Invalid placement" }, 400);
    const id = uuid(), cipher = await encryptSecret(String(b.code), env);
    await env.DB.prepare("INSERT INTO ad_units(id,network_id,unit_name,format,code_ciphertext,placement) VALUES(?,?,?,?,?,?)")
      .bind(id, b.network_id, String(b.unit_name).slice(0, 120), String(b.format).slice(0, 80), cipher, b.placement).run();
    return json({ id, created: true }, 201);
  }
  const adMatch = path.match(/^\/api\/ads\/units\/([^/]+)$/);
  if (adMatch && method === "PATCH") {
    const b = await body<any>(req), sets: string[] = [], values: any[] = [];
    for (const key of ["unit_name", "format", "placement"]) if (b[key] !== undefined) {
      const value = String(b[key]);
      if (key === "placement" && !["head", "top", "middle", "bottom", "footer"].includes(value)) return json({ error: "Invalid placement" }, 400);
      sets.push(`${key}=?`); values.push(value.slice(0, key === "unit_name" ? 120 : 80));
    }
    if (b.is_active !== undefined) { const value = asBool(b.is_active); if (value === undefined) return json({ error: "is_active must be boolean" }, 400); sets.push("is_active=?"); values.push(value); }
    if (b.code !== undefined) {
      const network = await env.DB.prepare("SELECT n.allowed_domains FROM ad_units u JOIN ad_networks n ON n.id=u.network_id WHERE u.id=?").bind(adMatch[1]).first<any>();
      if (!network) return json({ error: "Ad unit not found" }, 404);
      validateAdCode(String(b.code), JSON.parse(String(network.allowed_domains || "[]")));
      sets.push("code_ciphertext=?"); values.push(await encryptSecret(String(b.code), env));
    }
    if (!sets.length) return json({ error: "No supported fields supplied" }, 400);
    values.push(adMatch[1]);
    const result = await env.DB.prepare(`UPDATE ad_units SET ${sets.join(",")} WHERE id=?`).bind(...values).run();
    return json({ updated: result.meta.changes > 0 });
  }
  if (adMatch && method === "DELETE") {
    const result = await env.DB.prepare("DELETE FROM ad_units WHERE id=?").bind(adMatch[1]).run();
    return json({ deleted: result.meta.changes > 0 });
  }

  const themeKit = path.match(/^\/api\/websites\/([^/]+)\/theme-kit$/);
  if (themeKit && method === "GET") {
    const rows = await env.DB.prepare("SELECT placement,unit_name,format FROM ad_units u JOIN ad_networks n ON n.id=u.network_id WHERE n.website_id=? AND u.is_active=1 AND n.is_active=1 ORDER BY u.created_at").bind(themeKit[1]).all();
    return json({ placements: rows.results, limitation: "Blogger API v3 does not expose a supported theme/template update method. Jarvis can prepare and validate a modified XML file, but the owner must import it in Blogger Theme > Restore." });
  }
  const themePatch = path.match(/^\/api\/websites\/([^/]+)\/theme-patch$/);
  if (themePatch && method === "POST") {
    const raw = await req.text();
    if (raw.length > 2_100_000) return json({ error: "Template upload exceeds 2 MB" }, 413);
    let parsed: any;
    try { parsed = JSON.parse(raw); } catch { return json({ error: "JSON body required" }, 400); }
    if (!parsed.template_xml) return json({ error: "template_xml is required" }, 400);
    const result = await createThemePatch(env, themePatch[1], String(parsed.template_xml));
    return json(result);
  }

  if (path === "/api/jobs" && method === "GET") {
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") || 100)));
    const rows = await env.DB.prepare(`SELECT j.id,j.page_id,p.page_name,j.website_id,w.name AS website_name,j.article_id,j.job_type,j.topic,j.trigger_source,j.scheduled_at,j.timezone,j.status,j.stage,j.progress,j.attempts,j.last_error,j.created_at,j.updated_at
      FROM publishing_jobs j LEFT JOIN facebook_pages p ON p.id=j.page_id LEFT JOIN websites w ON w.id=j.website_id ORDER BY j.scheduled_at DESC LIMIT ?`).bind(limit).all();
    return json(rows.results);
  }
  if (path === "/api/jobs/publish-now" && method === "POST") {
    const b = await body<any>(req);
    if (!b.page_id) return json({ error: "page_id is required" }, 400);
    const created = await createJob(env, String(b.page_id), b.topic ? String(b.topic).slice(0, 500) : null, "manual", "article_publish", new Date().toISOString(), 1);
    return json({ job_id: created.id, status: created.status, message: "Manual publish job queued. Track its steps in Activity." }, 202);
  }
  if (path === "/api/jobs/draft" && method === "POST") {
    const b = await body<any>(req);
    if (!b.page_id) return json({ error: "page_id is required" }, 400);
    const created = await createJob(env, String(b.page_id), b.topic ? String(b.topic).slice(0, 500) : null, "manual_draft", "draft_only", new Date().toISOString(), 0);
    return json({ job_id: created.id, status: created.status }, 202);
  }
  if (path === "/api/jobs/random-today" && method === "POST") {
    const b = await body<any>(req);
    if (!b.page_id) return json({ error: "page_id is required" }, 400);
    const page = await env.DB.prepare("SELECT * FROM facebook_pages WHERE id=? AND is_active=1").bind(String(b.page_id)).first<PageRow>();
    if (!page) return json({ error: "Facebook Page is missing or disabled" }, 404);
    const mapping = await env.DB.prepare("SELECT website_id FROM page_website_mappings WHERE facebook_page_id=?").bind(page.id).first<any>();
    if (!mapping?.website_id) return json({ error: "Connect this Page to its Blogger website first" }, 400);
    const site = await env.DB.prepare("SELECT is_active FROM websites WHERE id=?").bind(mapping.website_id).first<any>();
    if (Number(site?.is_active) !== 1) return json({ error: "Mapped Blogger website is disabled" }, 409);
    const now = new Date(), tz = page.timezone || "Asia/Kolkata", localDate = localDateAt(now, tz);
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now).split(":");
    const nowMinute = Number(parts[0]) * 60 + Number(parts[1]);
    const [fromH, fromM] = page.active_from.split(":").map(Number);
    const [untilH, untilM] = page.active_until.split(":").map(Number);
    const from = fromH * 60 + fromM, until = untilH * 60 + untilM;
    const startMinute = Math.max(from, nowMinute + 5);
    if (until <= from || startMinute > until) return json({ error: "No publishing time remains in this Page's active window today. Use Publish now or schedule another day." }, 409);
    const cap = Math.max(0, Math.min(50, Number(page.daily_limit)));
    if (!cap) return json({ error: "This Page's daily post cap is set to zero" }, 409);
    const dayStart = localTimeToUtcIso(localDate, 0, tz), nextDay = localTimeToUtcIso(addLocalDays(localDate, 1), 0, tz);
    const existing = await env.DB.prepare(`SELECT scheduled_at FROM publishing_jobs WHERE page_id=? AND scheduled_at>=? AND scheduled_at<? AND status NOT IN ('cancelled','failed') AND trigger_source<>'manual_draft'`)
      .bind(page.id, dayStart, nextDay).all<any>();
    if (existing.results.length >= cap) return json({ error: `Daily limit reached (${existing.results.length}/${cap}). Existing posts are already planned or completed for today.` }, 409);
    const occupied = existing.results.map(row => {
      const d = new Date(String(row.scheduled_at));
      const p = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d).split(":");
      return Number(p[0]) * 60 + Number(p[1]);
    });
    const gap = Math.max(15, Number(page.min_gap_minutes));
    const candidates: number[] = [];
    for (let minute = startMinute; minute <= until; minute++) if (occupied.every(value => Math.abs(value - minute) >= gap)) candidates.push(minute);
    if (!candidates.length) return json({ error: "No random slot fits today's remaining time and minimum-gap settings." }, 409);
    const selected = candidates[Math.floor(Math.random() * candidates.length)];
    const scheduledAt = localTimeToUtcIso(localDate, selected, tz);
    const created = await createJob(env, page.id, b.topic ? String(b.topic).slice(0, 500) : null, "manual", "article_publish", scheduledAt, 1);
    return json({ job_id: created.id, status: created.status, scheduled_at: scheduledAt, timezone: tz, local_date: localDate, local_time: `${String(Math.floor(selected / 60)).padStart(2, "0")}:${String(selected % 60).padStart(2, "0")}` }, 201);
  }
  if (path === "/api/jobs/schedule" && method === "POST") {
    const b = await body<any>(req);
    if (!b.page_id || !b.scheduled_at) return json({ error: "page_id and scheduled_at are required" }, 400);
    const when = new Date(String(b.scheduled_at));
    if (!Number.isFinite(when.getTime()) || when.getTime() < Date.now() + 60_000) return json({ error: "scheduled_at must be at least one minute in the future and include a timezone" }, 400);
    const created = await createJob(env, String(b.page_id), b.topic ? String(b.topic).slice(0, 500) : null, "manual", "article_publish", when.toISOString(), 1);
    return json({ job_id: created.id, status: created.status, scheduled_at: when.toISOString() }, 201);
  }
  const jobMatch = path.match(/^\/api\/jobs\/([^/]+)$/);
  if (jobMatch && method === "GET") {
    const job = await env.DB.prepare("SELECT * FROM publishing_jobs WHERE id=?").bind(jobMatch[1]).first<any>();
    if (!job) return json({ error: "Job not found" }, 404);
    const [steps, events, article] = await Promise.all([
      env.DB.prepare("SELECT step_key,label,status,detail,started_at,ended_at FROM job_steps WHERE job_id=? ORDER BY rowid").bind(jobMatch[1]).all(),
      env.DB.prepare("SELECT level,stage,progress,message,created_at FROM job_events WHERE job_id=? ORDER BY created_at DESC LIMIT 100").bind(jobMatch[1]).all(),
      job.article_id ? env.DB.prepare("SELECT id,title,topic,body_html,facebook_caption,source_urls,source_domains,verification_score,fact_check_status,status,blogger_url,facebook_post_id FROM articles WHERE id=?").bind(job.article_id).first<any>() : null
    ]);
    return json({ job, steps: steps.results, events: events.results.reverse(), article });
  }
  const jobCancel = path.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
  if (jobCancel && method === "POST") {
    const result = await env.DB.prepare("UPDATE publishing_jobs SET status='cancelled',stage='cancelled',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('scheduled','queued','awaiting_approval')").bind(jobCancel[1]).run();
    if (result.meta.changes) await event(env, jobCancel[1], "warning", "cancelled", 0, "Job cancelled by the operator.", "cancelled");
    return json({ cancelled: result.meta.changes > 0 });
  }
  const jobPause = path.match(/^\/api\/jobs\/([^/]+)\/pause$/);
  if (jobPause && method === "POST") {
    const result = await env.DB.prepare("UPDATE publishing_jobs SET paused_from_status=CASE WHEN status='processing' THEN 'queued' ELSE status END,status='paused',stage='paused',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('scheduled','queued','processing')").bind(jobPause[1]).run();
    if (result.meta.changes) await event(env, jobPause[1], "warning", "paused", 0, "Paused by operator. An in-progress external call may finish before the next safe checkpoint.", "paused");
    return json({ paused: result.meta.changes > 0 });
  }
  const jobResume = path.match(/^\/api\/jobs\/([^/]+)\/resume$/);
  if (jobResume && method === "POST") {
    const job = await env.DB.prepare("SELECT paused_from_status,scheduled_at FROM publishing_jobs WHERE id=? AND status IN ('paused','failed')").bind(jobResume[1]).first<any>();
    if (!job) return json({ resumed: false });
    const restoredStatus = statusAfterPause(job.paused_from_status ?? null, String(job.scheduled_at));
    const restoreScheduled = restoredStatus === "scheduled";
    await env.DB.prepare(`UPDATE publishing_jobs SET status=?,stage=?,paused_from_status=NULL,last_error=NULL,attempts=0,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('paused','failed')`)
      .bind(restoreScheduled ? "scheduled" : "queued", restoreScheduled ? "waiting" : "queued", jobResume[1]).run();
    if (!restoreScheduled) await env.PUBLISH_QUEUE.send({ id: jobResume[1] });
    return json({ resumed: true, status: restoreScheduled ? "scheduled" : "queued" });
  }
  const approve = path.match(/^\/api\/jobs\/([^/]+)\/approve-publish$/);
  if (approve && method === "POST") {
    const job = await env.DB.prepare("SELECT * FROM publishing_jobs WHERE id=? AND status='awaiting_approval'").bind(approve[1]).first<any>();
    if (!job?.article_id) return json({ error: "No article awaiting approval for this job" }, 404);
    await env.DB.prepare("UPDATE articles SET fact_check_status='approved',status='ready' WHERE id=?").bind(job.article_id).run();
    await env.DB.prepare("UPDATE publishing_jobs SET job_type='publish_existing',auto_publish=1,status='queued',stage='queued',last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(job.id).run();
    await env.PUBLISH_QUEUE.send({ id: job.id });
    await event(env, job.id, "info", "queued", 70, "Operator approved this article for publication.", "queued");
    return json({ queued: true });
  }

  const articleMatch = path.match(/^\/api\/articles\/([^/]+)$/);
  if (articleMatch && method === "GET") {
    const article = await env.DB.prepare("SELECT id,page_id,website_id,topic,title,body_html,facebook_caption,labels_json,source_urls,source_domains,verification_score,fact_check_status,status,blogger_url,created_at,published_at FROM articles WHERE id=?").bind(articleMatch[1]).first<any>();
    return article ? json(article) : json({ error: "Article not found" }, 404);
  }
  if (articleMatch && method === "PATCH") {
    const b = await body<any>(req), sets: string[] = [], values: any[] = [];
    if (b.title !== undefined) { sets.push("title=?"); values.push(String(b.title).slice(0, 180)); }
    if (b.body_html !== undefined) { sets.push("body_html=?"); values.push(stripUnsafeArticleHtml(String(b.body_html))); }
    if (b.facebook_caption !== undefined) { sets.push("facebook_caption=?"); values.push(String(b.facebook_caption).slice(0, 5000)); }
    if (!sets.length) return json({ error: "No editable article fields supplied" }, 400);
    values.push(articleMatch[1]);
    const result = await env.DB.prepare(`UPDATE articles SET ${sets.join(",")} WHERE id=? AND status IN ('draft','awaiting_approval','ready')`).bind(...values).run();
    return json({ updated: result.meta.changes > 0 });
  }

  if (path === "/api/history" && method === "GET") {
    const rows = await env.DB.prepare("SELECT * FROM publishing_history ORDER BY created_at DESC LIMIT 200").all();
    return json(rows.results);
  }
  if (path === "/api/control/pause-all" && method === "POST") {
    const b = await body<any>(req).catch(() => ({}));
    await env.DB.prepare("UPDATE system_control SET global_enabled=0,pause_reason=?,updated_at=CURRENT_TIMESTAMP WHERE id=1").bind(String(b.reason ?? "Paused by operator").slice(0, 300)).run();
    await env.DB.prepare("UPDATE publishing_jobs SET paused_from_status=CASE WHEN status='processing' THEN 'queued' ELSE status END,status='paused',stage='paused',updated_at=CURRENT_TIMESTAMP WHERE status IN ('scheduled','queued','processing')").run();
    await audit(env, null, null, null, "global_pause", "success", "All queued and scheduled jobs paused");
    return json({ paused: true });
  }
  if (path === "/api/control/resume-all" && method === "POST") {
    await env.DB.prepare("UPDATE system_control SET global_enabled=1,pause_reason=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=1").run();
    const candidates = await env.DB.prepare(`SELECT j.id,j.paused_from_status,j.scheduled_at FROM publishing_jobs j
      JOIN facebook_pages p ON p.id=j.page_id JOIN websites w ON w.id=j.website_id
      LEFT JOIN articles a ON a.id=j.article_id
      WHERE j.status='paused' AND p.is_active=1 AND w.is_active=1
        AND (j.trigger_source<>'automatic' OR p.automation_enabled=1)
        AND (a.id IS NULL OR a.status IN ('ready','draft'))`).all<any>();
    let resumed = 0;
    for (const job of candidates.results) {
      const nextStatus = statusAfterPause(job.paused_from_status ?? null, String(job.scheduled_at));
      const keepScheduled = nextStatus === "scheduled";
      const changed = await env.DB.prepare(`UPDATE publishing_jobs SET status=?,stage=?,paused_from_status=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='paused'`)
        .bind(nextStatus, keepScheduled ? "waiting" : "queued", job.id).run();
      if (!changed.meta.changes) continue;
      resumed++;
      if (!keepScheduled) await env.PUBLISH_QUEUE.send({ id: job.id });
    }
    await audit(env, null, null, null, "global_resume", "success", `Resumed ${resumed} jobs; future scheduled jobs remain scheduled`);
    return json({ resumed: true, jobs: resumed });
  }
  if (path === "/api/control/plan-next-day" && method === "POST") {
    const created = await planDailyJobs(env);
    return json({ planned: created });
  }

  return json({ error: "not_found", path }, 404);
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return withCors(await handle(req, env, ctx), req, env);
    } catch (error) {
      const status = error instanceof Error && /UNIQUE constraint/i.test(error.message) ? 409 : 500;
      return withCors(json({ error: status === 409 ? "conflict" : "internal_error", detail: safeError(error) }, status), req, env);
    }
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil((async () => {
      await syncDueAdReports(env);
      await verifyTokenStatuses(env);
      if (!(await isGloballyEnabled(env))) return;
      await planDailyJobs(env);
      await dispatchDueJobs(env);
    })());
  },
  async queue(batch: MessageBatch<QueueMessage>, env: Env) {
    for (const message of batch.messages) {
      try {
        await processJob(message.body.id, env);
        const latest = await env.DB.prepare("SELECT status FROM publishing_jobs WHERE id=?").bind(message.body.id).first<any>();
        if (["awaiting_approval", "completed", "failed", "cancelled", "paused"].includes(String(latest?.status))) message.ack();
        else message.ack();
      } catch {
        const latest = await env.DB.prepare("SELECT attempts,status FROM publishing_jobs WHERE id=?").bind(message.body.id).first<any>();
        const attempts = Number(latest?.attempts ?? 1);
        if (attempts >= 5) {
          await env.DB.prepare("UPDATE publishing_jobs SET status='failed',stage='failed',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(message.body.id).run();
          message.ack();
        } else {
          message.retry({ delaySeconds: Math.min(1800, 30 * (2 ** Math.min(attempts, 6))) });
        }
      }
    }
  }
};
