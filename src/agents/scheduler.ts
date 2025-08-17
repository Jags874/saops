// src/agents/scheduler.ts
import type { WorkOrder, OpsTask, SchedulerPolicy, Priority, WoType, Skill } from '../types';
import { getResourceSnapshot } from '../data/resourceStore';
import { demoNow } from '../utils/demoClock';


// A very small, deterministic scheduler that:
// - Orders WOs by type/priority and due-ness
// - Schedules within policy windows (defaults to evenings if avoidOps)
// - Avoids ops tasks if avoidOps=true
// - Respects per-day skill capacity from resourceStore availability
// - Returns a preview with moved/scheduled/unscheduled lists and rationale

type Interval = { start: Date; end: Date };
type PlanResult = {
  workorders: WorkOrder[];
  moved: number;
  scheduled: number;
  unscheduled: number;
  movedIds: string[];
  scheduledIds: string[];
  unscheduledIds: string[];
  rationale: string[];
};

const BY_PRIORITY: Priority[] = ['Critical', 'High', 'Medium', 'Low'];
const BY_TYPE: WoType[] = ['Corrective', 'Preventive'];

function iso(d: Date) { return d.toISOString(); }
function addHours(d: Date, h: number) { const x = new Date(d); x.setHours(x.getHours() + h); return x; }
function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() &&
         a.getMonth() === b.getMonth() &&
         a.getDate() === b.getDate();
}
function clamp(n: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, n)); }

function parseOpsIntervals(ops: OpsTask[]): Map<string, Interval[]> {
  const map = new Map<string, Interval[]>();
  for (const t of ops) {
    const k = t.vehicleId;
    const list = map.get(k) ?? [];
    list.push({ start: new Date(t.start), end: new Date(t.end) });
    map.set(k, list);
  }
  return map;
}

function overlap(a: Interval, b: Interval) {
  return a.start < b.end && b.start < a.end;
}

function hasOverlap(block: Interval, blocks: Interval[]) {
  for (const b of blocks) {
    if (overlap(block, b)) return true;
  }
  return false;
}

function dayWindow(date: Date, startHour: number, endHour: number): Interval {
  const s = new Date(date); s.setHours(startHour, 0, 0, 0);
  const e = new Date(date); e.setHours(endHour, 0, 0, 0);
  return { start: s, end: e };
}

function hoursIn(block: Interval) {
  return (block.end.getTime() - block.start.getTime()) / 36e5;
}

function fmtDate(d: Date) {
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function skillSet(skills?: Skill[]) {
  const s = new Set<Skill>();
  (skills && skills.length ? skills : (['Mechanic'] as Skill[])).forEach(k => s.add(k));
  return s;
}

function sortWorkOrders(wos: WorkOrder[]): WorkOrder[] {
  return [...wos].sort((a, b) => {
    // Unscheduled first
    const aUns = !a.start || a.status === 'Open';
    const bUns = !b.start || b.status === 'Open';
    if (aUns !== bUns) return aUns ? -1 : 1;

    // Type (Corrective before Preventive)
    const t = BY_TYPE.indexOf(a.type) - BY_TYPE.indexOf(b.type);
    if (t !== 0) return t;

    // Priority
    const p = BY_PRIORITY.indexOf(a.priority) - BY_PRIORITY.indexOf(b.priority);
    if (p !== 0) return p;

    // Earlier created first (if available)
    const ad = a.created ? new Date(a.created).getTime() : 0;
    const bd = b.created ? new Date(b.created).getTime() : 0;
    return ad - bd;
  });
}

function getPolicyWindows(policy?: SchedulerPolicy): Array<{ startHour: number; endHour: number }> {
  if (policy?.windows && policy.windows.length) return policy.windows;
  // Default windows: if avoiding ops, use night hours; else business hours
  if (policy?.avoidOps) return [{ startHour: 19, endHour: 23 }];
  return [{ startHour: 8, endHour: 17 }];
}

function horizonDays(policy?: SchedulerPolicy) {
  return clamp(Number(policy?.horizonDays ?? 7), 1, 14);
}

function buildDailyCapacity(): Map<string, Map<Skill, number>> {
  // Build map: YYYY-MM-DD -> skill -> hours
  const { technicians, availability } = getResourceSnapshot();
  const techSkills = new Map<string, Skill[]>();
  for (const t of technicians) techSkills.set(t.id, (t.skills?.length ? t.skills : ['Mechanic']) as Skill[]);

  const cap = new Map<string, Map<Skill, number>>();
  for (const a of availability) {
    const ymd = a.date.slice(0, 10);
    const map = cap.get(ymd) ?? new Map<Skill, number>();
    const skills = techSkills.get(a.technicianId) ?? (['Mechanic'] as Skill[]);
    for (const s of skills) {
      map.set(s, (map.get(s) ?? 0) + Number(a.hours ?? 0));
    }
    cap.set(ymd, map);
  }
  return cap;
}

export function proposeSchedule(
  workorders: WorkOrder[],
  opsTasks: OpsTask[],
  policy?: SchedulerPolicy
): PlanResult {
  const now = demoNow();
  const H = horizonDays(policy);
  const windows = getPolicyWindows(policy);
  const avoidOps = !!policy?.avoidOps;

  // Capacity by day+skill
  const dailyCapacity = buildDailyCapacity();

  // Vehicle busy windows from ops
  const opsByVehicle = parseOpsIntervals(opsTasks);

  const original = new Map<string, WorkOrder>(workorders.map(w => [w.id, w]));
  const result: WorkOrder[] = workorders.map(w => ({ ...w })); // clone

  const scheduledIds: string[] = [];
  const movedIds: string[] = [];
  const unscheduledIds: string[] = [];
  const rationale: string[] = [];

  const candidates = sortWorkOrders(result).filter(w => w.status !== 'Closed');

  for (const w of candidates) {
    const required = skillSet(w.requiredSkills);
    const duration = Math.max(1, Math.round((w.hours ?? 2)));
    const vehicleOps = opsByVehicle.get(w.vehicleId) ?? [];

    let placed = false;

    // Try each day within horizon
    for (let d = 0; d < H && !placed; d++) {
      const day = new Date(now);
      day.setHours(0, 0, 0, 0);
      day.setDate(day.getDate() + d);
      const ymd = day.toISOString().slice(0, 10);

      // Check skill capacity for the day
      const cap = dailyCapacity.get(ymd) ?? new Map<Skill, number>();
      let skillOk = true;
      for (const s of required) {
        if ((cap.get(s) ?? 0) < duration) { skillOk = false; break; }
      }
      if (!skillOk) continue;

      // Try policy windows on this day
      for (const win of windows) {
        const block = dayWindow(day, win.startHour, win.endHour);
        if (hoursIn(block) < duration) continue;

        // If avoiding ops, ensure the block doesn’t overlap ops windows for this vehicle.
        // To keep it simple, we schedule the WO at window start for `duration` hours.
        const candidate: Interval = { start: block.start, end: addHours(block.start, duration) };

        if (avoidOps) {
          if (hasOverlap(candidate, vehicleOps)) continue;
        }

        // Place it
        w.start = iso(candidate.start);
        w.end = iso(candidate.end);
        w.status = 'Scheduled';

        // Decrement capacity
        for (const s of required) {
          cap.set(s, (cap.get(s) ?? 0) - duration);
        }
        dailyCapacity.set(ymd, cap);

        placed = true;
        break;
      }
    }

    const orig = original.get(w.id)!;
    if (placed) {
      scheduledIds.push(w.id);
      if (orig.start && (orig.start !== w.start || orig.end !== w.end)) movedIds.push(w.id);
    } else {
      unscheduledIds.push(w.id);
      // revert any partial changes for safety
      w.start = orig.start;
      w.end = orig.end;
      w.status = orig.status;
    }
  }

  // Build rationale bullets
  const sched = scheduledIds.length;
  const uns = unscheduledIds.length;
  const mov = movedIds.length;
  rationale.push(
    `Policy windows: ${windows.map(w => `${w.startHour}-${w.endHour}`).join(', ')}${avoidOps ? ' (avoid ops)' : ''}`,
    `Capacity source: technician availability by skill (daily hours).`,
    `Result: ${sched} scheduled, ${mov} moved, ${uns} could not be placed.`
  );
  if (uns > 0) {
    rationale.push(`Unscheduled examples: ${unscheduledIds.slice(0, 5).join(', ')}${uns > 5 ? '…' : ''}`);
  }

  return {
    workorders: result,
    moved: mov,
    scheduled: sched,
    unscheduled: uns,
    movedIds: movedIds,
    scheduledIds: scheduledIds,
    unscheduledIds: unscheduledIds,
    rationale
  };
}
