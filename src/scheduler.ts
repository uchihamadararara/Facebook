import type { Env } from "./types";
import { uuid } from "./security";
import { addLocalDays, localDateAt, localTimeToUtcIso } from "./timezone";

const minuteOf = (value: string) => {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
};
const randomInt = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;

export function statusAfterPause(pausedFromStatus: string | null, scheduledAt: string, now = new Date()): "scheduled" | "queued" {
  return pausedFromStatus === "scheduled" && new Date(scheduledAt).getTime() > now.getTime() ? "scheduled" : "queued";
}

export function makeSlots(count: number, from: number, until: number, minGap: number, occupied: number[] = []): number[] {
  if (!count || until < from) return [];
  const available: number[] = [];
  for (let minute = from; minute <= until; minute++) {
    if (occupied.every(existing => Math.abs(existing - minute) >= minGap)) available.push(minute);
  }
  const slots: number[] = [];
  // Randomized greedy selection from viable local-time minutes, also respecting existing manual jobs.
  while (slots.length < count && available.length) {
    const index = randomInt(0, available.length - 1);
    const chosen = available[index];
    slots.push(chosen);
    for (let i = available.length - 1; i >= 0; i--) {
      if (Math.abs(available[i] - chosen) < minGap) available.splice(i, 1);
    }
  }
  return slots.sort((a, b) => a - b);
}

export async function planDailyJobs(env: Env, now = new Date()): Promise<number> {
  const control = await env.DB.prepare("SELECT global_enabled FROM system_control WHERE id=1").first<any>();
  if (Number(control?.global_enabled ?? 1) !== 1) return 0;
  const result = await env.DB.prepare(`
    SELECT p.id AS page_id,p.daily_limit,p.min_gap_minutes,p.active_from,p.active_until,p.timezone,p.is_active,
           p.automation_enabled,p.auto_publish,p.page_name,m.website_id,w.is_active AS website_active
    FROM facebook_pages p
    JOIN page_website_mappings m ON m.facebook_page_id=p.id
    JOIN websites w ON w.id=m.website_id
    WHERE p.is_active=1 AND p.automation_enabled=1 AND w.is_active=1
  `).all<any>();
  let total = 0;
  for (const page of result.results) {
    const tz = String(page.timezone || "Asia/Kolkata");
    const today = localDateAt(now, tz);
    const tomorrow = addLocalDays(today, 1);
    const [hourText, minuteText] = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).format(now).split(":");
    const nowMinute = Number(hourText) * 60 + Number(minuteText);
    const cap = Math.max(0, Math.min(50, Number(page.daily_limit)));
    const from = minuteOf(String(page.active_from));
    const until = minuteOf(String(page.active_until));
    const minGap = Math.max(15, Number(page.min_gap_minutes));
    if (!cap || until <= from) continue;

    for (const localDate of [today, tomorrow]) {
      const inserted = await env.DB.prepare(`INSERT OR IGNORE INTO page_schedule_days(id,page_id,local_date,slots_created) VALUES(?,?,?,0)`)
        .bind(uuid(), page.page_id, localDate).run();
      if (!inserted.meta.changes) continue;
      const startMinute = localDate === today ? Math.max(from, nowMinute + 3) : from;
      if (startMinute > until) continue;
      const dayStart = localTimeToUtcIso(localDate, 0, tz);
      const nextDay = localTimeToUtcIso(addLocalDays(localDate, 1), 0, tz);
      const existing = await env.DB.prepare(`SELECT scheduled_at FROM publishing_jobs
        WHERE page_id=? AND scheduled_at>=? AND scheduled_at<?
          AND status NOT IN ('cancelled','failed') AND trigger_source<>'manual_draft'`)
        .bind(page.page_id, dayStart, nextDay).all<any>();
      const remaining = Math.max(0, cap - existing.results.length);
      if (!remaining) {
        await env.DB.prepare("UPDATE page_schedule_days SET slots_created=0 WHERE page_id=? AND local_date=?")
          .bind(page.page_id, localDate).run();
        continue;
      }
      const occupied = existing.results.map(row => {
        const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
          .format(new Date(String(row.scheduled_at))).split(":");
        return Number(parts[0]) * 60 + Number(parts[1]);
      });
      const slots = makeSlots(remaining, startMinute, until, minGap, occupied);
      let created = 0;
      for (const minute of slots) {
        const scheduled = localTimeToUtcIso(localDate, minute, tz);
        const id = uuid();
        const idem = `auto:${page.page_id}:${localDate}:${minute}`;
        const row = await env.DB.prepare(`
          INSERT OR IGNORE INTO publishing_jobs
            (id,page_id,website_id,job_type,trigger_source,auto_publish,scheduled_at,timezone,status,stage,progress,idempotency_key)
          VALUES(?,?,?,'article_publish','automatic',?,?,?,'scheduled','waiting',0,?)
        `).bind(id, page.page_id, page.website_id, Number(page.auto_publish), scheduled, tz, idem).run();
        created += row.meta.changes ? 1 : 0;
      }
      await env.DB.prepare("UPDATE page_schedule_days SET slots_created=? WHERE page_id=? AND local_date=?")
        .bind(created, page.page_id, localDate).run();
      total += created;
    }
  }
  return total;
}

export async function dispatchDueJobs(env: Env, now = new Date()): Promise<number> {
  const control = await env.DB.prepare("SELECT global_enabled FROM system_control WHERE id=1").first<any>();
  if (Number(control?.global_enabled ?? 1) !== 1) return 0;
  const due = await env.DB.prepare(`
    SELECT j.id FROM publishing_jobs j
    JOIN facebook_pages p ON p.id=j.page_id
    JOIN websites w ON w.id=j.website_id
    WHERE j.status='scheduled' AND j.scheduled_at<=? AND p.is_active=1 AND w.is_active=1
    ORDER BY j.scheduled_at LIMIT 50
  `).bind(now.toISOString()).all<{ id: string }>();
  let sent = 0;
  for (const row of due.results) {
    const claimed = await env.DB.prepare(`UPDATE publishing_jobs SET status='queued',stage='queued',progress=2,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='scheduled'`)
      .bind(row.id).run();
    if (!claimed.meta.changes) continue;
    try {
      await env.PUBLISH_QUEUE.send({ id: row.id });
      sent++;
    } catch (error) {
      await env.DB.prepare(`UPDATE publishing_jobs SET status='scheduled',last_error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .bind(error instanceof Error ? error.message.slice(0, 300) : "Queue send failed", row.id).run();
    }
  }
  return sent;
}
