// src/agents/scheduler.ts
import type { WorkOrder, OpsTask, SchedulerPolicy } from '../types';

/** ---------- Local time helpers ---------- */
function isoLocal(d: Date): string {
  const t = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return t.toISOString().replace('Z', '');
}
function addHours(d: Date, hrs: number) {
  return new Date(d.getTime() + hrs * 3_600_000);
}
function setHMS(d: Date, h: number, m = 0, s = 0, ms = 0) {
  const x = new Date(d);
  x.setHours(h, m, s, ms);
  return x;
}
function cloneArr<T>(arr: T[]): T[] {
  return arr.map(x => ({ ...(x as any) }));
}

/** ---------- Policy shape used locally ---------- */
type PolicyExt = SchedulerPolicy & {
  businessHours?: [number, number];
  windowStartISO?: string;
  windowEndISO?: string; // end-exclusive
};

function insideWindow(d: Date, startISO?: string, endISO?: string) {
  if (!startISO && !endISO) return true;
  const t = +d;
  if (startISO && t < +new Date(startISO)) return false;
  if (endISO && t >= +new Date(endISO)) return false;
  return true;
}

function clampStartPreservingDuration(start: Date, durationH: number, open = 9, close = 17) {
  const dayOpen = setHMS(start, open);
  const dayClose = setHMS(start, close);
  const latestStart = addHours(dayClose, -durationH);

  let s = start < dayOpen ? dayOpen : start;
  if (s > latestStart) {
    const nextDay = new Date(start);
    nextDay.setDate(nextDay.getDate() + 1);
    s = setHMS(nextDay, open);
  }
  const e = addHours(s, durationH);
  return { s, e };
}

/** ---------- PUBLIC: proposeSchedule (unchanged API) ---------- */
export function proposeSchedule(
  workordersIn: WorkOrder[],
  opsTasksIn: OpsTask[],
  policy?: SchedulerPolicy
) {
  const pol = (policy ?? {}) as PolicyExt;
  const [open, close] = pol.businessHours ?? [9, 17];

  const workorders = cloneArr(workordersIn);
  const opsTasks   = cloneArr(opsTasksIn);

  const rationale: string[] = [];
  const movedIds: string[] = [];
  const scheduledIds: string[] = [];
  const unscheduledIds: string[] = [];

  const adjust = (item: any) => {
    if (!item.start || !item.end) {
      // Unscheduled items remain unscheduled
      unscheduledIds.push(item.id);
      return;
    }
    const start = new Date(item.start);
    const end   = new Date(item.end);
    if (isNaN(+start) || isNaN(+end)) {
      unscheduledIds.push(item.id);
      return;
    }

    // If outside window, rebase to windowStart @ open (if provided)
    let s = start;
    if (!insideWindow(s, pol.windowStartISO, pol.windowEndISO) && pol.windowStartISO) {
      s = setHMS(new Date(pol.windowStartISO), open);
    }

    const durationH = Math.max(0.25, (+end - +start) / 3_600_000);
    const before = isoLocal(start) + ' → ' + isoLocal(end);
    const { s: s2, e: e2 } = clampStartPreservingDuration(s, durationH, open, close);
    const after = isoLocal(s2) + ' → ' + isoLocal(e2);

    if (before !== after) movedIds.push(item.id);
    item.start = isoLocal(s2);
    item.end   = isoLocal(e2);
    if ((item as any).status === 'Open') (item as any).status = 'Scheduled';
    scheduledIds.push(item.id);
  };

  workorders.forEach(adjust);
  opsTasks.forEach(adjust);

  const moved = movedIds.length;
  const scheduled = scheduledIds.length;
  const unscheduled = unscheduledIds.length;

  rationale.push(
    `Applied business hours ${open}:00–${close}:00 local.`,
    ...(pol.windowStartISO && pol.windowEndISO
      ? [`Rebased items into the window ${pol.windowStartISO} – ${pol.windowEndISO} (end‑exclusive).`]
      : [])
  );

  return {
    workorders,
    opsTasks,
    moved,
    scheduled,
    unscheduled,
    movedIds,
    scheduledIds,
    unscheduledIds,
    rationale,
  };
}

/** ---------- PUBLIC: computeClashes (used by context.ts) ----------
 * Returns exact overlaps between WOs and Ops tasks on the same vehicle.
 */
export function computeClashes(
  workorders: WorkOrder[],
  opsTasks: OpsTask[]
): {
  total: number;
  clashes: Array<{
    vehicleId: string;
    woId: string;
    opsId: string;
    woStart: string;
    woEnd: string;
    opsStart: string;
    opsEnd: string;
  }>;
} {
  const out: Array<{
    vehicleId: string;
    woId: string;
    opsId: string;
    woStart: string;
    woEnd: string;
    opsStart: string;
    opsEnd: string;
  }> = [];

  const byVehOps = new Map<string, OpsTask[]>();
  for (const t of opsTasks) {
    if (!t.start || !t.end) continue;
    if (!byVehOps.has(t.vehicleId)) byVehOps.set(t.vehicleId, []);
    byVehOps.get(t.vehicleId)!.push(t);
  }

  for (const w of workorders) {
    if (!w.start || !w.end) continue;
    const opsList = byVehOps.get(w.vehicleId);
    if (!opsList || !opsList.length) continue;

    const wStart = new Date(w.start);
    const wEnd   = new Date(w.end);
    if (isNaN(+wStart) || isNaN(+wEnd)) continue;

    for (const t of opsList) {
      const oStart = new Date(t.start!);
      const oEnd   = new Date(t.end!);
      if (isNaN(+oStart) || isNaN(+oEnd)) continue;

      // overlap if intervals intersect: max(start) < min(end)
      const latestStart = Math.max(+wStart, +oStart);
      const earliestEnd = Math.min(+wEnd, +oEnd);
      if (latestStart < earliestEnd) {
        out.push({
          vehicleId: w.vehicleId,
          woId: w.id,
          opsId: (t as any).id ?? '',
          woStart: w.start!,
          woEnd: w.end!,
          opsStart: t.start!,
          opsEnd: t.end!,
        });
      }
    }
  }

  return { total: out.length, clashes: out };
}
