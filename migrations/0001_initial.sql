PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS system_control (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  global_enabled INTEGER NOT NULL DEFAULT 1,
  pause_reason TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO system_control(id, global_enabled) VALUES(1, 1);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS facebook_pages (
  id TEXT PRIMARY KEY,
  page_name TEXT NOT NULL,
  page_id TEXT NOT NULL UNIQUE,
  token_ciphertext TEXT NOT NULL,
  content_type TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'en',
  daily_limit INTEGER NOT NULL DEFAULT 3 CHECK(daily_limit BETWEEN 0 AND 50),
  min_gap_minutes INTEGER NOT NULL DEFAULT 90 CHECK(min_gap_minutes >= 15),
  active_from TEXT NOT NULL DEFAULT '08:00',
  active_until TEXT NOT NULL DEFAULT '22:00',
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  image_mode TEXT NOT NULL DEFAULT 'both',
  is_active INTEGER NOT NULL DEFAULT 1,
  automation_enabled INTEGER NOT NULL DEFAULT 0,
  auto_publish INTEGER NOT NULL DEFAULT 1,
  token_status TEXT NOT NULL DEFAULT 'unverified',
  last_token_check TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS websites (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'blogger',
  blog_id TEXT NOT NULL,
  blog_url TEXT NOT NULL,
  refresh_token_ciphertext TEXT,
  language TEXT NOT NULL DEFAULT 'en',
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  is_active INTEGER NOT NULL DEFAULT 1,
  connection_status TEXT NOT NULL DEFAULT 'not_connected',
  last_connection_check TEXT,
  theme_patch_generated_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(platform, blog_id)
);

CREATE TABLE IF NOT EXISTS page_website_mappings (
  id TEXT PRIMARY KEY,
  facebook_page_id TEXT NOT NULL UNIQUE REFERENCES facebook_pages(id) ON DELETE CASCADE,
  website_id TEXT NOT NULL UNIQUE REFERENCES websites(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS content_profiles (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL UNIQUE REFERENCES facebook_pages(id) ON DELETE CASCADE,
  content_type TEXT NOT NULL,
  language TEXT NOT NULL,
  tone TEXT NOT NULL DEFAULT 'informative',
  instructions TEXT NOT NULL DEFAULT '',
  image_mode TEXT NOT NULL DEFAULT 'both',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ad_networks (
  id TEXT PRIMARY KEY,
  website_id TEXT NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  network_name TEXT NOT NULL,
  allowed_domains TEXT NOT NULL DEFAULT '[]',
  reporting_provider TEXT NOT NULL DEFAULT 'none',
  api_token_ciphertext TEXT,
  report_config TEXT NOT NULL DEFAULT '{}',
  last_stats_sync TEXT,
  stats_sync_status TEXT NOT NULL DEFAULT 'not_configured',
  stats_error TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ad_revenue_daily (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES ad_networks(id) ON DELETE CASCADE,
  website_id TEXT NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  report_date TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  ctr REAL NOT NULL DEFAULT 0,
  cpm REAL NOT NULL DEFAULT 0,
  revenue REAL NOT NULL DEFAULT 0,
  dimension_key TEXT NOT NULL DEFAULT 'total',
  raw_json TEXT NOT NULL DEFAULT '{}',
  fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(network_id, report_date, dimension_key)
);

CREATE TABLE IF NOT EXISTS ad_units (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES ad_networks(id) ON DELETE CASCADE,
  unit_name TEXT NOT NULL,
  format TEXT NOT NULL,
  code_ciphertext TEXT NOT NULL,
  placement TEXT NOT NULL CHECK(placement IN ('head','top','middle','bottom','footer')),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS articles (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES facebook_pages(id),
  website_id TEXT NOT NULL REFERENCES websites(id),
  topic TEXT NOT NULL,
  title TEXT NOT NULL,
  body_html TEXT NOT NULL,
  facebook_caption TEXT NOT NULL DEFAULT '',
  labels_json TEXT NOT NULL DEFAULT '[]',
  image_r2_key TEXT,
  image_url TEXT,
  image_credit TEXT,
  source_urls TEXT NOT NULL DEFAULT '[]',
  source_domains TEXT NOT NULL DEFAULT '[]',
  verification_score INTEGER NOT NULL DEFAULT 0,
  fact_check_status TEXT NOT NULL DEFAULT 'needs_review',
  blogger_post_id TEXT,
  blogger_url TEXT,
  facebook_post_id TEXT,
  facebook_comment_id TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  published_at TEXT
);

CREATE TABLE IF NOT EXISTS publishing_jobs (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES facebook_pages(id),
  website_id TEXT NOT NULL REFERENCES websites(id),
  article_id TEXT REFERENCES articles(id),
  job_type TEXT NOT NULL DEFAULT 'article_publish',
  topic TEXT,
  trigger_source TEXT NOT NULL DEFAULT 'automatic',
  auto_publish INTEGER NOT NULL DEFAULT 1,
  scheduled_at TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  status TEXT NOT NULL DEFAULT 'scheduled',
  paused_from_status TEXT,
  stage TEXT NOT NULL DEFAULT 'waiting',
  progress INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS job_steps (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES publishing_jobs(id) ON DELETE CASCADE,
  step_key TEXT NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  detail TEXT,
  started_at TEXT,
  ended_at TEXT,
  UNIQUE(job_id, step_key)
);

CREATE TABLE IF NOT EXISTS job_events (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES publishing_jobs(id) ON DELETE CASCADE,
  level TEXT NOT NULL DEFAULT 'info',
  stage TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS page_schedule_days (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES facebook_pages(id) ON DELETE CASCADE,
  local_date TEXT NOT NULL,
  slots_created INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(page_id, local_date)
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  website_id TEXT NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS publishing_history (
  id TEXT PRIMARY KEY,
  job_id TEXT,
  page_id TEXT,
  website_id TEXT,
  action TEXT NOT NULL,
  result TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_jobs_due ON publishing_jobs(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_jobs_page ON publishing_jobs(page_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_site ON publishing_jobs(website_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_page_date ON articles(page_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ad_network_site ON ad_networks(website_id);
CREATE INDEX IF NOT EXISTS idx_ad_revenue_site_date ON ad_revenue_daily(website_id,report_date DESC);
CREATE INDEX IF NOT EXISTS idx_ad_revenue_network_date ON ad_revenue_daily(network_id,report_date DESC);
CREATE INDEX IF NOT EXISTS idx_job_events_job ON job_events(job_id, created_at DESC);
