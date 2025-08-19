// src/utils/time.ts
/** Write a Date as local-ISO (YYYY-MM-DDTHH:mm:ss.sss, no Z) */
export function toLocalISO(d: Date): string {
  const t = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return t.toISOString().replace('Z', '');
}

/** Parse an ISO string; treat both 'Z' and local-ISO; return Date or null */
export function parseISO(maybe?: string | null): Date | null {
  if (!maybe) return null;
  const d = new Date(maybe);
  return Number.isFinite(+d) ? d : null;
}

/** Add hours to a Date */
export function addHours(d: Date, h: number): Date {
  return new Date(d.getTime() + h * 3_600_000);
}

/** Local calendar key YYYY-MM-DD (uses local time, not UTC) */
export function ymdLocal(d: Date): string {
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const mm = m < 10 ? `0${m}` : `${m}`;
  const dd = day < 10 ? `0${day}` : `${day}`;
  return `${y}-${mm}-${dd}`;
}

/** Are two instants on the same local calendar day? */
export function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear()
      && a.getMonth() === b.getMonth()
      && a.getDate() === b.getDate();
}

/** Coerce a Date's YEAR to the demo anchor year if it drifted */
export function snapYear(d: Date | null, anchorYear: number): Date | null {
  if (!d) return d;
  if (d.getFullYear() !== anchorYear) {
    const nd = new Date(d);
    nd.setFullYear(anchorYear);
    return nd;
  }
  return d;
}

/** Convenience: parse then snap year */
export function parseSnap(maybe: string | undefined, anchorYear: number): Date | null {
  return snapYear(parseISO(maybe), anchorYear);
}
