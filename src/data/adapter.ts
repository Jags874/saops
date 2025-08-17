// src/data/adapter.ts — file-backed + demo-date rebase
import vehicles from './fake/vehicles.json';
import pm from './fake/pm.json';
import technicians from './fake/technicians.json';
import availability from './fake/availability.json';
import failures from './fake/failures.json';
import conditions from './fake/condition.json';
import opsTasks from './fake/ops_tasks.json';
import workorders from './fake/workorders.json';

import type {
  Vehicle, WorkOrder, OpsTask, PMTask, FailureRecord, DemandRecord,
  Technician, AvailabilitySlot, ConditionSnapshot
} from '../types';

import { demoNow, startOfDay, addDays, ymd as ymdUtil } from '../utils/demoClock';

// --- demo rebase helpers (align dataset’s first ops day to the demo date) ---
const DEMO_START = startOfDay(demoNow());
let deltaDaysCache: number | null = null;

function getDeltaDays(): number {
  if (deltaDaysCache !== null) return deltaDaysCache;
  const raw = opsTasks as OpsTask[];
  if (!raw.length) { deltaDaysCache = 0; return 0; }
  const minStartMs = Math.min(...raw.map(t => new Date(t.start).getTime()));
  const datasetStart = new Date(minStartMs);
  datasetStart.setHours(0, 0, 0, 0);
  const diffMs = DEMO_START.getTime() - datasetStart.getTime();
  deltaDaysCache = Math.round(diffMs / 86400000); // whole days
  return deltaDaysCache!;
}

function shiftISO(isoStr: string, days: number) {
  const d = new Date(isoStr);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}
function shiftYmd(ymdStr: string, days: number) {
  const d = new Date(`${ymdStr}T00:00:00`);
  d.setDate(d.getDate() + days);
  return ymdUtil(d);
}

// --- simple passthroughs for static datasets ---
export function getVehicles(count = (vehicles as Vehicle[]).length): Vehicle[] {
  return (vehicles as Vehicle[]).slice(0, count);
}
export function getPMTasks(): PMTask[] { return pm as PMTask[]; }
export function getTechnicians(): Technician[] { return technicians as Technician[]; }
export function getFailures(): FailureRecord[] { return failures as FailureRecord[]; }
export function getConditions(): ConditionSnapshot[] { return conditions as ConditionSnapshot[]; }

// --- time-sensitive datasets (rebased) ---
export function getAvailability(): AvailabilitySlot[] {
  const delta = getDeltaDays();
  return (availability as AvailabilitySlot[]).map(a => ({
    ...a,
    date: shiftYmd(a.date, delta),
  }));
}

export function getOpsTasks(days = 7): OpsTask[] {
  const delta = getDeltaDays();
  const start = DEMO_START;
  const end = addDays(start, days);
  return (opsTasks as OpsTask[])
    .map(t => ({
      ...t,
      start: shiftISO(t.start, delta),
      end: shiftISO(t.end, delta),
    }))
    .filter(t => {
      const s = new Date(t.start);
      return s >= start && s < end;
    });
}

export function getWorkOrders(): WorkOrder[] {
  const delta = getDeltaDays();
  return (workorders as WorkOrder[]).map(w => {
    if (w.start && w.end) {
      return { ...w, start: shiftISO(w.start, delta), end: shiftISO(w.end, delta) };
    }
    return w;
  });
}

// --- demand derived from (rebased) ops ---
export function getDemandHistory(days = 7): DemandRecord[] {
  const ops = getOpsTasks(days);
  const byDay = new Map<string, number>();
  for (const t of ops) {
    const day = t.start.slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + (t.hours ?? 0));
  }
  return Array.from(byDay.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, hours]) => ({ date, hours }));
}
