// src/agents/scheduler.ts
import type { WorkOrder, OpsTask, SchedulerPolicy } from '../types';

function clone<T>(x: T): T { return JSON.parse(JSON.stringify(x)); }
function setTime(d: Date, h: number, m = 0) { const x = new Date(d); x.setHours(h, m, 0, 0); return x; }
function hoursBetween(a: Date, b: Date) { return Math.max(0, (b.getTime() - a.getTime()) / 36e5); }
function toISO(d: Date) { return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString(); }
function sameDay(a: Date, b: Date) { return a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate(); }

type InternalPolicy = {
  businessHours?: [number, number];
  opsShiftDays?: number;
  avoidOpsOverlap?: boolean;
  forVehicle?: string;
};

function clampWOToBusinessHours(w: WorkOrder, [hStart, hEnd]: [number, number]) {
  if (!w.start || !w.end) return w;
  const s = new Date(w.start);
  const e = new Date(w.end);
  if (!sameDay(s, e)) return w;
  const sBH = setTime(s, hStart);
  const eBH = setTime(s, hEnd);
  if (s < sBH || e > eBH) {
    const dur = hoursBetween(s, e);
    const ns = s < sBH ? sBH : s;
    const ne = new Date(ns); ne.setHours(ns.getHours() + Math.min(dur, hEnd - hStart));
    w.start = toISO(ns);
    w.end = toISO(ne);
  }
  return w;
}

function shiftOpsToNightWithin(task: OpsTask, allowDays = 1): OpsTask {
  const s0 = new Date(task.start);
  const e0 = new Date(task.end);
  let target = setTime(s0, 20, 0);
  const deltaDays = (target.getTime() - s0.getTime()) / 86400000;
  if (Math.abs(deltaDays) > allowDays) {
    const near = new Date(s0); near.setDate(near.getDate() + (deltaDays > 0 ? allowDays : -allowDays));
    target = setTime(near, 20, 0);
  }
  const dur = Math.max(1, Math.round(hoursBetween(s0, e0)));
  const end = new Date(target); end.setHours(target.getHours() + dur);
  return { ...task, start: toISO(target), end: toISO(end) };
}

function removeOpsOverlaps(ops: OpsTask[]): { ops: OpsTask[]; fixes: number } {
  let fixes = 0;
  const byV = new Map<string, OpsTask[]>();
  for (const t of ops) {
    const arr = byV.get(t.vehicleId) ?? [];
    arr.push(t);
    byV.set(t.vehicleId, arr);
  }
  const out: OpsTask[] = [];
  for (const [, arr] of byV) {
    arr.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
    let lastEnd: Date | null = null;
    for (const t of arr) {
      let s = new Date(t.start);
      let e = new Date(t.end);
      if (lastEnd && s < lastEnd) {
        const dur = Math.max(1, Math.round(hoursBetween(s, e)));
        s = new Date(lastEnd);
        e = new Date(s); e.setHours(s.getHours() + dur);
        fixes++;
      }
      out.push({ ...t, start: toISO(s), end: toISO(e) });
      lastEnd = new Date(e);
    }
  }
  return { ops: out, fixes };
}

/** Exported for other packs */
export function computeClashes(
  workorders: WorkOrder[],
  opsTasks: OpsTask[]
): Array<{ vehicleId: string; workOrderId: string; opsId: string; overlapHours: number }> {
  const out: Array<{ vehicleId: string; workOrderId: string; opsId: string; overlapHours: number }> = [];
  const byVehOps = new Map<string, OpsTask[]>();
  for (const t of opsTasks) {
    const arr = byVehOps.get(t.vehicleId) ?? [];
    arr.push(t);
    byVehOps.set(t.vehicleId, arr);
  }
  for (const w of workorders) {
    if (!(w.status === 'Scheduled' || w.status === 'In Progress') || !w.start || !w.end) continue;
    const sW = new Date(w.start);
    const eW = new Date(w.end);
    const ops = byVehOps.get(w.vehicleId) ?? [];
    for (const o of ops) {
      const sO = new Date(o.start);
      const eO = new Date(o.end);
      const start = Math.max(sW.getTime(), sO.getTime());
      const end = Math.min(eW.getTime(), eO.getTime());
      const ov = Math.max(0, (end - start) / 36e5);
      if (ov > 0.01) out.push({ vehicleId: w.vehicleId, workOrderId: w.id, opsId: o.id, overlapHours: Math.round(ov * 10) / 10 });
    }
  }
  return out;
}

/**
 * Propose an updated schedule (policy-driven).
 */
export function proposeSchedule(
  workorders: WorkOrder[],
  opsTasks: OpsTask[],
  policy?: SchedulerPolicy
) {
  const pol = (policy as Partial<InternalPolicy>) || {};
  const W = clone(workorders);
  let O = clone(opsTasks);

  const rationale: string[] = [];
  const scopedWO = (w: WorkOrder) => !pol.forVehicle || w.vehicleId === pol.forVehicle;
  const scopedOp = (t: OpsTask)   => !pol.forVehicle || t.vehicleId === pol.forVehicle;

  if (typeof pol.opsShiftDays === 'number') {
    O = O.map(t => scopedOp(t) ? shiftOpsToNightWithin(t, pol.opsShiftDays!) : t);
    rationale.push(`Shifted ops to night window within ±${pol.opsShiftDays} day(s).`);
  }

  if (pol.avoidOpsOverlap) {
    const r = removeOpsOverlaps(O.filter(scopedOp));
    const byId = new Map(r.ops.map(t => [t.id, t]));
    O = O.map(t => byId.get(t.id) ?? t);
    rationale.push(`Resolved ${r.fixes} potential ops overlaps.`);
  }

  if (pol.businessHours) {
    const [hStart, hEnd] = pol.businessHours;
    for (const w of W) {
      if ((w.status === 'Scheduled' || w.status === 'In Progress') && w.start && w.end && scopedWO(w)) {
        clampWOToBusinessHours(w, [hStart, hEnd]);
      }
    }
    rationale.push(`Clamped maintenance into ${pol.businessHours[0]}:00–${pol.businessHours[1]}:00.`);
  }

  let moved = 0, scheduled = 0, unscheduled = 0;
  const movedIds: string[] = [];
  const scheduledIds: string[] = [];
  const unscheduledIds: string[] = [];

  for (const w of W) {
    if (w.status === 'Open' || !w.start) { unscheduled++; unscheduledIds.push(w.id); }
    else { scheduled++; }
  }
  if (pol.businessHours || typeof pol.opsShiftDays === 'number' || pol.avoidOpsOverlap || pol.forVehicle) {
    moved = scheduled;
    movedIds.push(...W.filter(w => w.status !== 'Open' && w.start).map(w => w.id).slice(0, 50));
  }

  return {
    workorders: W,
    opsTasks: O,
    rationale,
    moved,
    scheduled,
    unscheduled,
    movedIds,
    scheduledIds,
    unscheduledIds,
  };
}
