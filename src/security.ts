import type { Env } from "./types";

export function json(data: unknown, status = 200, extra: HeadersInit = {}): Response {
  const headers = new Headers(extra);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  return new Response(JSON.stringify(data), { status, headers });
}

function constantTimeEqual(a: string, b: string): boolean {
  const aa = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  let diff = aa.length ^ bb.length;
  const length = Math.max(aa.length, bb.length);
  for (let i = 0; i < length; i++) diff |= (aa[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

export function unauthorized(req: Request, env: Env): boolean {
  const supplied = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  return !env.JARVIS_ADMIN_KEY || supplied.length < 32 || !constantTimeEqual(supplied, env.JARVIS_ADMIN_KEY);
}

export function uuid(): string { return crypto.randomUUID(); }

function b64(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}
function unb64(value: string): Uint8Array {
  const raw = atob(value);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}
async function cryptoKey(secret: string): Promise<CryptoKey> {
  if (!secret || secret.length < 32) throw new Error("DATA_ENCRYPTION_KEY must contain at least 32 characters");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function encryptSecret(value: string, env: Env): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await cryptoKey(env.DATA_ENCRYPTION_KEY), new TextEncoder().encode(value));
  return `v1.${b64(iv)}.${b64(new Uint8Array(data))}`;
}
export async function decryptSecret(value: string, env: Env): Promise<string> {
  const [version, iv, cipher] = value.split(".");
  if (version !== "v1" || !iv || !cipher) throw new Error("Encrypted secret format is unsupported");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) as unknown as BufferSource }, await cryptoKey(env.DATA_ENCRYPTION_KEY), unb64(cipher) as unknown as BufferSource);
  return new TextDecoder().decode(plain);
}

export async function body<T>(req: Request): Promise<T> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > 250_000) throw new Error("Request body exceeds 250 KB");
  const raw = await req.text();
  if (raw.length > 250_000) throw new Error("Request body exceeds 250 KB");
  const value = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON object required");
  return value as T;
}
export function safeError(error: unknown): string {
  const text = error instanceof Error ? error.message : "Unexpected failure";
  return text.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 500);
}
export function asBool(value: unknown): number | undefined {
  if (value === true || value === 1 || value === "1" || value === "true") return 1;
  if (value === false || value === 0 || value === "0" || value === "false") return 0;
  return undefined;
}
export function validateTime(value: unknown, field: string): string {
  const time = String(value ?? "");
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error(`${field} must use HH:MM (24-hour) format`);
  return time;
}
export function safeUrl(value: unknown, field: string): string {
  const url = new URL(String(value));
  if (url.protocol !== "https:") throw new Error(`${field} must be an HTTPS URL`);
  return url.toString();
}
export function stripUnsafeArticleHtml(input: string): string {
  let html = input.slice(0, 180_000);
  html = html.replace(/<\s*(script|iframe|object|embed|form|input|button|textarea|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "");
  html = html.replace(/<\s*(script|iframe|object|embed|form|input|button|textarea|style)[^>]*\/?>/gi, "");
  html = html.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  html = html.replace(/(?:href|src)\s*=\s*(["'])\s*javascript:[\s\S]*?\1/gi, "");
  return html;
}
export function safeHtmlText(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}
