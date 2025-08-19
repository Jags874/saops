// src/data/mutatePlan.ts
import { WEEK_START } from './adapter';
import type { WorkOrder, OpsTask, Priority, Skill } from '../types';
import { applyMutations as applyResourceMutations } from './resourceStore';

// Loose mutation shape from the agent
export type PlanMutation = { op: string; [k: string]: any };

/* ================= helpers ================= */

function clone<T>(x: T): T { return JSON.parse(JSON.stringify(x)); }

function toLocalISO(d: Date): string {
  // store as local-ISO so rendered wall-clock matches intent
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString();
}

function addHours(date: Date, h: number): Date {
  const d = new Date(date); d.setHours(d.getHours() + h); return d;
}

function durationHours(start?: string, end?: string, fallback = 2): number {
  if (!start || !end) return fallback;
  const s = new Date(start), e = new Date(end);
  if (isNaN(+s) || isNaN(+e)) return fallback;
  return Math.max(0.25, (e.getTime() - s.getTime()) / 36e5);
}

function overlaps(aS: Date, aE: Date, bS: Date, bE: Date): boolean {
  return aS < bE && bS < aE;
}

function businessWindow(dayStart: Date, hours: [number, number] = [8, 17]): [Date, Date] {
  const [h1, h2] = hours;
  const s = new Date(dayStart); s.setHours(h1, 0, 0, 0);
  const e = new Date(dayStart); e.setHours(h2, 0, 0, 0);
  return [s, e];
}

function nextWoId(existing: WorkOrder[]): string {
  let max = 0;
  for (const w of existing) {
    const m = /^WO-(\d+)$/.exec(w.id);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `WO-${String(max + 1).padStart(3, '0')}`;
}

/** earliest slot within WEEK_START..+7d that avoids OPS/WO conflicts and fits business hours */
function findEarliestSlot(
  vehicleId: string,
  hoursNeeded: number,
  workorders: WorkOrder[],
  opsTasks: OpsTask[],
  businessHours: [number, number] = [8, 17]
): { start: string; end: string } {
  const day0 = new Date(WEEK_START);
  for (let d = 0; d < 7; d++) {
    const dayStart = new Date(day0);
    dayStart.setDate(day0.getDate() + d);
    const [winS, winE] = businessWindow(dayStart, businessHours);

    const blocks: Array<[Date, Date]> = [];
    for (const t of opsTasks) {
      if (t.vehicleId !== vehicleId) continue;
      const s = new Date(t.start), e = new Date(t.end);
      if (!(isNaN(+s) || isNaN(+e))) blocks.push([s, e]);
    }
    for (const w of workorders) {
      if (w.vehicleId !== vehicleId) continue;
      if (w.status === 'Closed' || !w.start || !w.end) continue;
      const s = new Date(w.start), e = new Date(w.end);
      if (!(isNaN(+s) || isNaN(+e))) blocks.push([s, e]);
    }
    blocks.sort((a, b) => a[0].getTime() - b[0].getTime());

    let cursor = new Date(winS);
    const neededMs = hoursNeeded * 36e5;

    for (let i = 0; i <= blocks.length; i++) {
      const nextS = i < blocks.length ? blocks[i][0] : winE;
      const gapMs = nextS.getTime() - cursor.getTime();
      if (gapMs >= neededMs && cursor >= winS && addHours(cursor, hoursNeeded) <= winE) {
        const startISO = toLocalISO(cursor);
        const endISO = toLocalISO(addHours(cursor, hoursNeeded));
        return { start: startISO, end: endISO };
      }
      if (i < blocks.length) {
        const nextE = blocks[i][1];
        cursor = new Date(Math.max(cursor.getTime(), nextE.getTime()));
      }
    }
  }
  const s = new Date(WEEK_START); s.setHours(9, 0, 0, 0);
  return { start: toLocalISO(s), end: toLocalISO(addHours(s, hoursNeeded)) };
}

/* ================= main ================= */

export function applyMutationsToPlan(
  workordersIn: WorkOrder[],
  opsTasksIn: OpsTask[],
  mutations: PlanMutation[],
  opts?: { businessHours?: [number, number] }
): { workorders: WorkOrder[]; opsTasks: OpsTask[]; notes: string[] } {
  const notes: string[] = [];
  const businessHours: [number, number] = opts?.businessHours ?? [8, 17];

  const workorders = clone(workordersIn);
  const opsTasks = clone(opsTasksIn);

  const woById = new Map(workorders.map(w => [w.id, w]));
  const opsById = new Map(opsTasks.map(o => [o.id, o]));

  for (const m of mutations) {
    const op = String(m.op || '').toUpperCase();

    /* ----- Work Orders ----- */
    if (op === 'MOVE_WO') {
      const id = m.id as string;
      const w = woById.get(id);
      if (!w) { notes.push(`MOVE_WO: ${id} not found`); continue; }

      const h = typeof m.hours === 'number' ? m.hours : durationHours(w.start, w.end, w.hours ?? 2);
      let newStart: Date; let newEnd: Date;

      if (m.start) {
        newStart = new Date(m.start);
        if (isNaN(+newStart)) { notes.push(`MOVE_WO: invalid start for ${id}`); continue; }
        newEnd = m.end ? new Date(m.end) : addHours(newStart, h);
      } else if (m.end) {
        newEnd = new Date(m.end);
        if (isNaN(+newEnd)) { notes.push(`MOVE_WO: invalid end for ${id}`); continue; }
        newStart = addHours(newEnd, -h);
      } else { notes.push(`MOVE_WO: ${id} requires start or end`); continue; }

      w.start = toLocalISO(newStart);
      w.end = toLocalISO(newEnd);
      w.status = 'Scheduled';
      w.hours = h;
      notes.push(`Moved ${id} → ${new Date(w.start).toLocaleString()} (${h}h)`);
      continue;
    }

    if (op === 'CANCEL_WO') {
      const id = m.id as string;
      const w = woById.get(id);
      if (!w) { notes.push(`CANCEL_WO: ${id} not found`); continue; }
      w.status = 'Closed';
      delete w.start; delete w.end;
      notes.push(`Cancelled ${id}`);
      continue;
    }

    if (op === 'ADD_WO') {
      const vehicleId = String(m.vehicleId || '');
      const title = String(m.title || '');
      const hours = Number(m.hours || 2);
      const priority = (m.priority ?? 'Medium') as Priority;
      const skillSingle = m.skill as Skill | undefined;
      const skills = (Array.isArray(m.requiredSkills) ? m.requiredSkills as Skill[] :
                      skillSingle ? [skillSingle] : undefined);

      if (!vehicleId || !title || !hours) { notes.push(`ADD_WO: missing vehicleId/title/hours`); continue; }

      const id = nextWoId(workorders);
      const base: WorkOrder = {
        id, vehicleId, title,
        type: 'Corrective',
        priority,
        status: 'Scheduled',
        start: '', end: '',
        hours
      };
      if (skills) base.requiredSkills = skills;

      let startISO: string, endISO: string;
      if (m.start) {
        const s = new Date(String(m.start));
        if (isNaN(+s)) {
          notes.push(`ADD_WO: invalid start "${m.start}" — will auto-place`);
          const slot = findEarliestSlot(vehicleId, hours, workorders, opsTasks, businessHours);
          startISO = slot.start; endISO = slot.end;
        } else {
          startISO = toLocalISO(s); endISO = toLocalISO(addHours(s, hours));
        }
      } else {
        const slot = findEarliestSlot(vehicleId, hours, workorders, opsTasks, businessHours);
        startISO = slot.start; endISO = slot.end;
      }

      base.start = startISO;
      base.end = endISO;
      workorders.push(base);
      woById.set(id, base);
      notes.push(`Added ${id} for ${vehicleId} → ${new Date(base.start).toLocaleString()} (${hours}h)`);
      continue;
    }

    /* ----- Ops Tasks ----- */
    if (op === 'MOVE_OPS') {
      const id = m.id as string;
      const t = opsById.get(id);
      if (!t) { notes.push(`MOVE_OPS: ${id} not found`); continue; }

      const h = typeof m.hours === 'number' ? m.hours : durationHours(t.start, t.end, t.demandHours ?? 8);
      let newStart: Date; let newEnd: Date;

      if (m.start) {
        newStart = new Date(m.start);
        if (isNaN(+newStart)) { notes.push(`MOVE_OPS: invalid start for ${id}`); continue; }
        newEnd = m.end ? new Date(m.end) : addHours(newStart, h);
      } else if (m.end) {
        newEnd = new Date(m.end);
        if (isNaN(+newEnd)) { notes.push(`MOVE_OPS: invalid end for ${id}`); continue; }
        newStart = addHours(newEnd, -h);
      } else { notes.push(`MOVE_OPS: ${id} requires start or end`); continue; }

      // guard: no OPS overlap on same vehicle
      const veh = t.vehicleId;
      const sD = newStart, eD = newEnd;
      const conflict = opsTasks.some(o => o.vehicleId === veh && o.id !== id &&
        overlaps(sD, eD, new Date(o.start), new Date(o.end)));
      if (conflict) { notes.push(`MOVE_OPS: refused for ${id} — would overlap another ops task for ${veh}`); continue; }

      t.start = toLocalISO(newStart);
      t.end = toLocalISO(newEnd);
      t.demandHours = h;
      notes.push(`Moved ${id} → ${new Date(t.start).toLocaleString()} (${h}h)`);
      continue;
    }

    if (op === 'CANCEL_OPS') {
      const id = m.id as string;
      const idx = opsTasks.findIndex(o => o.id === id);
      if (idx < 0) { notes.push(`CANCEL_OPS: ${id} not found`); continue; }
      opsTasks.splice(idx, 1);
      opsById.delete(id);
      notes.push(`Cancelled ${id}`);
      continue;
    }

    /* ----- Resources / parts (forward to resourceStore) ----- */
    if (op.startsWith('ADD_TECH') || op.startsWith('SET_AVAIL') || op.startsWith('ADD_PART') || op.startsWith('SET_PART') || op.startsWith('REMOVE_PART')) {
      const ack = applyResourceMutations([m]);
      notes.push(...ack);
      continue;
    }

    notes.push(`Unknown op ${op} — ignored`);
  }

  return { workorders, opsTasks, notes };
}
