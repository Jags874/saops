// src/agents/scheduler.ts
// Greedy, human-friendly scheduler used by the Scheduler Agent.
// - Understands both availability shapes: { date, hours } or { start, end }
// - Uses technician skills (Mechanic / AutoElec)
// - Avoids vehicle ops-tasks overlap when placing maintenance
// - Returns rationale + moved/scheduled/unscheduled IDs

import type {
  WorkOrder,
  OpsTask,
  Skill,
  Technician,
  SchedulerPolicy,
} from '../types';
import { getResourceSnapshot } from '../data/resourceStore';
import { getDemoWeekStart } from '../data/adapter';

// ------------------------ helpers ------------------------

const DAY_MS = 86_400_000;

const ymdLocal = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`;

function localMidnightFromUTCAnchor(iso: string) {
  const u = new Date(iso);
  return new Date(
    u.getUTCFullYear(),
    u.getUTCMonth(),
    u.getUTCDate(),
    0,
    0,
    0,
    0
  );
}

function hours(s: Date, e: Date) {
  return Math.max(0, (e.getTime() - s.getTime()) / 3_600_000);
}

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date) {
  return aEnd > bStart && aStart < bEnd;
}

function requiredSkillsFor(w: any): Skill[] {
  if (Array.isArray(w?.requiredSkills) && w.requiredSkills.length)
    return w.requiredSkills as Skill[];
  // heuristic fallback by subsystem
  if (String(w?.subsystem || '').toLowerCase().includes('elect'))
    return ['AutoElec'];
  return ['Mechanic'];
}

function durationHoursFor(w: any) {
  if (typeof w?.hours === 'number' && isFinite(w.hours) && w.hours > 0)
    return w.hours as number;
  const s = w?.start ? new Date(w.start) : null;
  const e = w?.end ? new Date(w.end) : null;
  if (s && e && isFinite(s.getTime()) && isFinite(e.getTime())) return hours(s, e);
  return 2; // default slot
}

// ----------------- availability / capacity -----------------

// Accepts either legacy availability ({ date, hours, technicianId })
// or interval availability ({ start, end, technicianId })
type AvailabilitySlot = {
  technicianId: string;
  date?: string;
  hours?: number;
  start?: string;
  end?: string;
};

function buildTechSkillsMap(techs: Technician[]): Map<string, Skill[]> {
  const map = new Map<string, Skill[]>();
  for (const t of techs ?? []) {
    const skills = (t.skills && t.skills.length ? t.skills : ['Mechanic']) as Skill[];
    map.set(t.id, skills);
  }
  return map;
}

// Build capacity per day per skill: Map<YYYY-MM-DD, Map<Skill, number>>
export function buildDailyCapacity(
  availability: AvailabilitySlot[],
  technicians: Technician[]
): Map<string, Map<Skill, number>> {
  const techSkills = buildTechSkillsMap(technicians);
  const cap = new Map<string, Map<Skill, number>>();

  for (const a of availability ?? []) {
    // Day key
    const dayKey =
      a.date ? a.date.slice(0, 10) : a.start ? ymdLocal(new Date(a.start)) : undefined;
    if (!dayKey) continue;

    // Hours
    let hrs = 0;
    if (typeof a.hours === 'number') {
      hrs = a.hours;
    } else if (a.start && a.end) {
      const s = new Date(a.start);
      const e = new Date(a.end);
      if (isFinite(s.getTime()) && isFinite(e.getTime())) {
        hrs = Math.max(0, (e.getTime() - s.getTime()) / 3_600_000);
      }
    }

    const perDay = cap.get(dayKey) ?? new Map<Skill, number>();
    const skills = techSkills.get(a.technicianId) ?? (['Mechanic'] as Skill[]);
    for (const sk of skills) {
      perDay.set(sk, (perDay.get(sk) ?? 0) + hrs);
    }
    cap.set(dayKey, perDay);
  }

  return cap;
}

// ------------- ops occupancy (vehicle/day intervals) -------------

type Interval = { s: Date; e: Date };

function buildOpsBusyByVehicleDay(ops: OpsTask[]) {
  // Map<vehicleId, Map<YYYY-MM-DD, Interval[]>>
  const out = new Map<string, Map<string, Interval[]>>();
  for (const t of ops ?? []) {
    if (!t.start || !t.end || !t.vehicleId) continue;
    const s = new Date(t.start);
    const e = new Date(t.end);
    if (!isFinite(s.getTime()) || !isFinite(e.getTime())) continue;

    const day = ymdLocal(new Date(s));
    const byDay = out.get(t.vehicleId) ?? new Map<string, Interval[]>();
    const arr = byDay.get(day) ?? [];
    arr.push({ s, e });
    byDay.set(day, arr);
    out.set(t.vehicleId, byDay);
  }
  return out;
}

// Find first placement window on a given day that doesn't overlap ops intervals
// and returns [start, end] or null.
function placeOnDayNoOverlap(
  dayStart: Date,
  vehicleOps: Interval[] | undefined,
  wantedHours: number
): { s: Date; e: Date } | null {
  // Candidate start times (local working hours)
  const candidates = [
    { h: 9, m: 0 },
    { h: 11, m: 0 },
    { h: 13, m: 0 },
    { h: 15, m: 0 },
    { h: 17, m: 0 }, // if needed
  ];

  for (const { h, m } of candidates) {
    const s = new Date(dayStart);
    s.setHours(h, m, 0, 0);
    const e = new Date(s);
    e.setHours(s.getHours() + Math.ceil(wantedHours));
    const overlapsOps =
      (vehicleOps ?? []).some((iv) => overlaps(s, e, iv.s, iv.e));
    if (!overlapsOps) return { s, e };
  }
  return null;
}

// ------------------------ main API ------------------------

export function proposeSchedule(
  workorders: WorkOrder[],
  opsTasks: OpsTask[],
  policy?: SchedulerPolicy
): {
  workorders: WorkOrder[];
  moved: number;
  scheduled: number;
  unscheduled: number;
  movedIds: string[];
  scheduledIds: string[];
  unscheduledIds: string[];
  rationale: string[];
} {
  const rationale: string[] = [];
  const movedIds: string[] = [];
  const scheduledIds: string[] = [];
  const unscheduledIds: string[] = [];

  // Snapshot resources
  const { technicians, availability } = getResourceSnapshot();
  const cap = buildDailyCapacity(availability as any, technicians as any);

  // Ops occupancy per vehicle/day
  const opsBusy = buildOpsBusyByVehicleDay(opsTasks);

  // Anchor week (local midnight)
  const week0 = localMidnightFromUTCAnchor(getDemoWeekStart());
  const weekDays = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(week0);
    d.setDate(d.getDate() + i);
    return d;
  });

  // Policy helpers (simple switches)
// Policy flag (accepts string or object; fully optional)
const preferAfterOps = (() => {
  const p: any = policy;
  if (!p) return false;
  if (typeof p === 'string') return p === 'prefer_after_ops';
  if (p && typeof p === 'object') {
    if (p.kind === 'prefer_after_ops') return true;
    if (typeof p.preferAfterOps === 'boolean') return p.preferAfterOps;
  }
  return false;
})();


  // Work on a copy
  const out = workorders.map((w) => ({ ...w }));

  // First, try to "nudge" scheduled items that overlap ops to a clear slot
  for (const w of out) {
    if (w.status !== 'Scheduled' || !w.start || !w.end) continue;
    const s = new Date(w.start);
    const e = new Date(w.end);
    if (!isFinite(s.getTime()) || !isFinite(e.getTime())) continue;

    const dayKey = ymdLocal(new Date(s));
    const vehOps = opsBusy.get(w.vehicleId)?.get(dayKey) ?? [];
    if (vehOps.some((iv) => overlaps(s, e, iv.s, iv.e))) {
      const placed = placeOnDayNoOverlap(new Date(dayKey + 'T00:00:00'), vehOps, durationHoursFor(w));
      if (placed) {
        w.start = placed.s.toISOString();
        w.end = placed.e.toISOString();
        movedIds.push(w.id);
      }
    }
  }

  // Then schedule unscheduled / open items
  for (const w of out) {
    const isSched = w.status === 'Scheduled' && w.start && w.end;
    if (isSched) continue;
    if (w.status === 'Closed') continue;

    const reqSkills = requiredSkillsFor(w);
    const needHrs = durationHoursFor(w);

    let placedWO: { s: Date; e: Date } | null = null;
    let placedDayKey: string | null = null;

    // Try each day of the demo week
    for (const d of weekDays) {
      const dayKey = ymdLocal(d);
      const capMap = cap.get(dayKey);
      if (!capMap) continue;

      // Check capacity for all required skills
      const ok =
        reqSkills.every((sk) => (capMap.get(sk) ?? 0) >= needHrs) ||
        false;
      if (!ok) continue;

      // Try to place avoiding ops overlap
      const vehOps = opsBusy.get(w.vehicleId)?.get(dayKey) ?? [];
      const slot = placeOnDayNoOverlap(d, vehOps, needHrs);
      if (!slot) continue;

      placedWO = slot;
      placedDayKey = dayKey;
      break;
    }

    if (placedWO && placedDayKey) {
      w.status = 'Scheduled';
      w.start = placedWO.s.toISOString();
      w.end = placedWO.e.toISOString();
      scheduledIds.push(w.id);

      // consume capacity
      const capMap = cap.get(placedDayKey)!;
      for (const sk of reqSkills) {
        capMap.set(sk, (capMap.get(sk) ?? 0) - needHrs);
      }
    } else {
      unscheduledIds.push(w.id);
    }
  }

  // Rationale summary
  rationale.push(
    `Capacity window: ${ymdLocal(weekDays[0])} → ${ymdLocal(weekDays.at(-1)!)}`
  );
  rationale.push(
    `Policy: ${preferAfterOps ? 'prefer-after-ops' : 'balanced'}`
  );
  if (scheduledIds.length)
    rationale.push(`Scheduled ${scheduledIds.length} open tasks into free windows.`);
  if (movedIds.length)
    rationale.push(`Moved ${movedIds.length} scheduled tasks that clashed with ops.`);
  if (unscheduledIds.length)
    rationale.push(`Could not place ${unscheduledIds.length} due to capacity/conflicts.`);

  return {
    workorders: out as WorkOrder[],
    moved: movedIds.length,
    scheduled: scheduledIds.length,
    unscheduled: unscheduledIds.length,
    movedIds,
    scheduledIds,
    unscheduledIds,
    rationale,
  };
}
