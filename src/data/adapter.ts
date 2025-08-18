// src/data/adapter.ts
// Central adapter that merges base JSON with runtime overlays/cancellations.
// All timestamps we return are local ISO without 'Z' to avoid timezone shifts.

import vehiclesRaw from './fake/vehicles.json';
import workordersRaw from './fake/workorders.json';
import opsTasksRaw from './fake/ops_tasks.json';
import failuresRaw from './fake/failures.json';
import pmRaw from './fake/pm.json';

import {
  getRuntimeWorkordersOverlay,
  getRuntimeWOPatches,
  getRuntimeOpsOverlay,
  getCancelledOpsIds,
  getPendingOpsCancelConflicts,
  addCancelledOps,
  clearPendingOpsCancelConflicts
} from './resourceStore';

// ----- Static demo anchor -----
export function getDemoWeekStart() {
  return '2025-08-22T00:00:00Z';
}

// ----- Helpers -----
const isSched = (w: any) => w && w.status === 'Scheduled' && w.start && w.end;

function overlaps(aStart?: string, aEnd?: string, bStart?: string, bEnd?: string) {
  if (!aStart || !aEnd || !bStart || !bEnd) return false;
  const aS = new Date(aStart.replace('Z','')).getTime();
  const aE = new Date(aEnd.replace('Z','')).getTime();
  const bS = new Date(bStart.replace('Z','')).getTime();
  const bE = new Date(bEnd.replace('Z','')).getTime();
  return aS < bE && bS < aE;
}

// ----- Vehicles -----
export function getVehicles(limit?: number) {
  const arr = (vehiclesRaw as any[]).map(v => ({ ...v }));
  return typeof limit === 'number' ? arr.slice(0, limit) : arr;
}

// ----- Work Orders (merged + patches) -----
export function getWorkOrders() {
  // base + overlay
  const byId = new Map<string, any>();
  for (const w of (workordersRaw as any[])) byId.set(String(w.id), { ...w });
  for (const w of getRuntimeWorkordersOverlay()) byId.set(String(w.id), { ...w });

  // apply patches (MOVE/UPDATE/CANCEL recorded against ids)
  for (const { id, patch } of getRuntimeWOPatches()) {
    if (byId.has(id)) {
      const cur = byId.get(id)!;
      byId.set(id, { ...cur, ...patch });
    }
  }

  const all = Array.from(byId.values());
  all.sort((a, b) => {
    const aSched = isSched(a) ? 0 : 1;
    const bSched = isSched(b) ? 0 : 1;
    if (aSched !== bSched) return aSched - bSched;
    const at = a.start ? new Date(a.start.replace('Z','')).getTime() : Infinity;
    const bt = b.start ? new Date(b.start.replace('Z','')).getTime() : Infinity;
    return at - bt;
  });
  return all;
}

// ----- Ops tasks (merged + cancellations) -----
export function getOpsTasks(_horizonDays: number) {
  // base
  const byId = new Map<string, any>();
  for (const t of (opsTasksRaw as any[])) byId.set(String(t.id).toUpperCase(), { ...t });

  // overlay (MERGE onto base so we can move-by-id without having a full overlay object)
  for (const ov of getRuntimeOpsOverlay()) {
    const id = String(ov.id).toUpperCase();
    const base = byId.get(id) ?? {};
    byId.set(id, { ...base, ...ov });
  }

  // explicit cancels
  const cancelled = getCancelledOpsIds();
  let tasks = Array.from(byId.values()).filter(t => !cancelled.has(String(t.id).toUpperCase()));

  // resolve pending "conflictsWith: WO-..." against current merged WOs
  const pending = getPendingOpsCancelConflicts();
  if (pending.length) {
    const wos = getWorkOrders();
    const toCancel: string[] = [];
    for (const woId of pending) {
      const w = wos.find(x => String(x.id).toUpperCase() === String(woId).toUpperCase());
      if (!w || !w.start || !w.end) continue;
      const hit = tasks.find(t =>
        String(t.vehicleId) === String(w.vehicleId) &&
        overlaps(w.start, w.end, t.start, t.end)
      );
      if (hit) toCancel.push(String(hit.id).toUpperCase());
    }
    if (toCancel.length) {
      addCancelledOps(toCancel);
      tasks = tasks.filter(t => !toCancel.includes(String(t.id).toUpperCase()));
    }
    clearPendingOpsCancelConflicts();
  }

  return tasks;
}

// ----- PM & Failures -----
export function getPMTasks() { return (pmRaw as any[]).map(x => ({ ...x })); }
export function getFailures() { return (failuresRaw as any[]).map(x => ({ ...x })); }

// ----- Demand history (derived from ops tasks) -----
export function getDemandHistory(horizonDays: number) {
  const tasks = getOpsTasks(horizonDays);
  const byDay = new Map<string, number>();
  for (const t of tasks) {
    if (!t.start || !t.end) continue;
    const start = new Date(t.start.replace('Z',''));
    const end = new Date(t.end.replace('Z',''));
    const hrs = Math.max(0, (end.getTime() - start.getTime()) / 36e5);
    const ymd = t.start.slice(0, 10);
    byDay.set(ymd, (byDay.get(ymd) ?? 0) + hrs);
  }
  return Array.from(byDay.entries()).sort(([a],[b]) => a.localeCompare(b)).map(([date, hours]) => ({ date, hours }));
}
