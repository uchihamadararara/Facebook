interface D1Meta { changes: number; duration?: number; last_row_id?: number; rows_read?: number; rows_written?: number; }
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(colName?: string): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[]; success: boolean; meta: D1Meta }>;
  run(): Promise<{ success: boolean; meta: D1Meta }>;
}
interface D1Database { prepare(query: string): D1PreparedStatement; }
interface Queue<T = unknown> { send(message: T): Promise<void>; }
interface Fetcher { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>; }
interface MessageBatch<T = unknown> { messages: Array<{ body: T; ack(): void; retry(options?: { delaySeconds?: number }): void }>; }
interface ScheduledController { scheduledTime: number; cron: string; }
interface ExecutionContext { waitUntil(promise: Promise<unknown>): void; passThroughOnException(): void; }
