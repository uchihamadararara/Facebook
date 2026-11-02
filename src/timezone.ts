function partsAt(date: Date, timezone: string): Record<string, string> {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  }).formatToParts(date);
  return Object.fromEntries(parts.filter(p => p.type !== "literal").map(p => [p.type, p.value]));
}
export function localDateAt(date: Date, timezone: string): string {
  const p = partsAt(date, timezone);
  return `${p.year}-${p.month}-${p.day}`;
}
export function addLocalDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const value = new Date(Date.UTC(y, m - 1, d + days));
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(value.getUTCDate()).padStart(2, "0")}`;
}
export function localTimeToUtcIso(localDate: string, minuteOfDay: number, timezone: string): string {
  const [year, month, day] = localDate.split("-").map(Number);
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  let candidate = targetAsUtc;
  for (let i = 0; i < 3; i++) {
    const p = partsAt(new Date(candidate), timezone);
    const represented = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
    const delta = targetAsUtc - represented;
    candidate += delta;
    if (delta === 0) break;
  }
  return new Date(candidate).toISOString();
}
export function validateTimezone(value: unknown): string {
  const tz = String(value || "Asia/Kolkata");
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date()); }
  catch { throw new Error(`Unknown timezone: ${tz}`); }
  return tz;
}
