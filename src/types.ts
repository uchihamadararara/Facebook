export interface Env {
  DB: D1Database;
  PUBLISH_QUEUE: Queue;
  ASSETS: Fetcher;
  JARVIS_ADMIN_KEY: string;
  DATA_ENCRYPTION_KEY: string;
  GEMINI_API_KEY?: string;
  GEMINI_TEXT_MODEL?: string;
  GEMINI_IMAGE_MODEL?: string;
  META_GRAPH_VERSION?: string;
  BLOGGER_CLIENT_ID?: string;
  BLOGGER_CLIENT_SECRET?: string;
  GOOGLE_OAUTH_REDIRECT_URI?: string;
  PUBLIC_BASE_URL?: string;
  CORS_ORIGINS?: string;
  ENVIRONMENT: string;
  META_TRY_PIN_COMMENT?: string;
  MIN_SOURCE_DOMAINS?: string;
}
export type QueueMessage = { id: string };
export type PageRow = {
  id: string; page_name: string; page_id: string; token_ciphertext: string;
  content_type: string; language: string; daily_limit: number; min_gap_minutes: number;
  active_from: string; active_until: string; timezone: string; image_mode: string;
  is_active: number; automation_enabled: number; auto_publish: number;
};
export type WebsiteRow = {
  id: string; name: string; platform: string; blog_id: string; blog_url: string;
  refresh_token_ciphertext: string | null; language: string; timezone: string; is_active: number;
};
