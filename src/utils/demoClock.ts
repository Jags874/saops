// src/utils/demoClock.ts
let cached: Date | null = null;

/** Midnight “today” for the demo. Sources (in priority order):
 *  1) URL query ?demo=YYYY-MM-DD (or ?date=...)
 *  2) VITE_DEMO_DATE in .env.local (YYYY-MM-DD)
 *  3) Real system date (midnight)
 */
export function demoNow(): Date {
  if (cached) return new Date(cached);

  let dStr: string | undefined =
    (typeof window !== 'undefined'
      ? new URL(window.location.href).searchParams.get('demo') ||
        new URL(window.location.href).searchParams.get('date')
      : undefined) ||
    (import.meta.env?.VITE_DEMO_DATE as string | undefined);

  if (dStr) {
    const d = new Date(`${dStr}T00:00:00`);
    if (!isNaN(d.getTime())) {
      cached = d;
      return new Date(cached);
    }
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  cached = today;
  return new Date(cached);
}

// Optional helpers if you need them elsewhere
export function startOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
export function addDays(d: Date, n: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
export function ymd(d: Date) {
  return d.toISOString().slice(0, 10);
}

/** Allow changing the demo date at runtime (optional) */
export function setDemoDate(isoYmd: string) {
  const d = new Date(`${isoYmd}T00:00:00`);
  if (!isNaN(d.getTime())) cached = d;
}
