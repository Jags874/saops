// src/data/adapter.ts
// Static, deterministic adapter for the demo week anchored to 22 Aug 2025.

import vehiclesRaw from './fake/vehicles.json';
import workordersRaw from './fake/workorders.json';
import opsTasksRaw from './fake/ops_tasks.json';
import failuresRaw from './fake/failures.json';
import conditionRaw from './fake/condition.json';
import pmRaw from './fake/pm.json';
// Parts catalog may be maintained in TS; handle multiple export styles safely.
import * as partsCatalog from './partsCatalog';
import techniciansRaw from './fake/technicians.json';
import {
  getRuntimeWorkordersOverlay,
  getCancelledOpsIds,
  getPendingOpsCancelConflicts,
  addCancelledOps,
  clearPendingOpsCancelConflicts
} from './resourceStore';


// --- Types are imported by consumers; we keep this file light on explicit types to
//     avoid tight coupling across the app and to tolerate shape drift in fake data.

// ===== Static demo anchors =====
const STATIC_WEEK_START_ISO = '2025-08-22T00:00:00.000Z'; // Fri 22 Aug 2025
const DAY_MS = 86_400_000;

// Small helpers

const toDate = (iso?: string) => {
  if (!iso) return null;
  let s = String(iso);
  // If it's a datetime (has time) but NO timezone, assume UTC by appending Z.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s) && !/[zZ]|[+\-]\d{2}:\d{2}$/.test(s)) {
    s += 'Z';
  }
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d : null;
};

const ymd = (d: Date) => d.toISOString().slice(0, 10);

// Public: start of the demo week (used by Gantt/Demand/Resources)
export function getDemoWeekStart(): string {
  return STATIC_WEEK_START_ISO;
}

// Public: earliest scheduled item in dataset (for footer display)
export function getDatasetWeekAnchor(): string {
  // Look for earliest start across ops tasks and scheduled work orders
  const candidates: Date[] = [];

  (opsTasksRaw as any[]).forEach((t) => {
    const d = toDate(t?.start);
    if (d) candidates.push(d);
  });

  (workordersRaw as any[]).forEach((w) => {
    const status = String(w?.status ?? '');
    if ((status === 'Scheduled' || status === 'In Progress') && w?.start) {
      const d = toDate(w.start);
      if (d) candidates.push(d);
    }
  });

  if (!candidates.length) return STATIC_WEEK_START_ISO;
  const earliest = candidates.reduce((min, d) => (d < min ? d : min), candidates[0]);
  return earliest.toISOString();
}

// ===== Vehicles =====
export function getVehicles(limit?: number) {
  const arr = (vehiclesRaw as any[]).slice();
  return typeof limit === 'number' ? arr.slice(0, limit) : arr;
}

// ===== Work Orders (as-is; already anchored by rebase script) =====
export function getWorkOrders() {
  // Load your base JSON as you already do
  const base: any[] = (workordersRaw as any[]) ?? [];

  // Merge runtime overlay (add/replace by id)
  const byId = new Map<string, any>();
  for (const w of base) byId.set(String(w.id), { ...w });
  for (const w of getRuntimeWorkordersOverlay()) byId.set(String(w.id), { ...w });

  // Return array in a stable order: scheduled first by start time, then the rest
  const all = Array.from(byId.values());
  all.sort((a, b) => {
    const aSched = a.status === 'Scheduled' && a.start ? 0 : 1;
    const bSched = b.status === 'Scheduled' && b.start ? 0 : 1;
    if (aSched !== bSched) return aSched - bSched;
    const at = a.start ? new Date(a.start).getTime() : Infinity;
    const bt = b.start ? new Date(b.start).getTime() : Infinity;
    return at - bt;
  });
  return all;
}


// ===== Ops Tasks filtered by LOCAL 7-day window with overlap semantics =====
export function getOpsTasks(horizonDays: number) {
  // Load base ops tasks exactly as you already do for the static week
  const base: any[] = (opsTasksRaw as any[]) ?? [];

  // 1) Filter out explicit cancels
  const cancelled = getCancelledOpsIds();
  let tasks = base.filter(t => !cancelled.has(String(t.id).toUpperCase()));

  // 2) Resolve pending “conflictsWith: WO-…” placeholders
  const pending = getPendingOpsCancelConflicts();
  if (pending.length) {
    const wos = getWorkOrders(); // merged (base + overlay), includes new WO
    const toCancel: string[] = [];

    // Helper: simple overlap check
    const overlaps = (aStart?: string, aEnd?: string, bStart?: string, bEnd?: string) => {
      if (!aStart || !aEnd || !bStart || !bEnd) return false;
      const aS = new Date(aStart).getTime();
      const aE = new Date(aEnd).getTime();
      const bS = new Date(bStart).getTime();
      const bE = new Date(bEnd).getTime();
      return aS < bE && bS < aE;
    };

    for (const woId of pending) {
      const w = wos.find(x => String(x.id).toUpperCase() === String(woId).toUpperCase());
      if (!w || !w.start || !w.end) continue;
      // pick the first ops task on same vehicle that overlaps the WO window
      const hit = tasks.find(t =>
        String(t.vehicleId) === String(w.vehicleId) &&
        overlaps(w.start, w.end, t.start, t.end)
      );
      if (hit) toCancel.push(String(hit.id).toUpperCase());
    }

    if (toCancel.length) {
      addCancelledOps(toCancel);
      // Remove them from the result set
      tasks = tasks.filter(t => !toCancel.includes(String(t.id).toUpperCase()));
    }
    // Clear placeholders so we don’t resolve them twice
    clearPendingOpsCancelConflicts();
  }

  // Return week’s tasks (your current logic likely already clips to 7 days)
  return tasks;
}



// ===== Demand history derived from ops tasks (next N days from static start) =====
export function getDemandHistory(days = 7) {
  const start = new Date(STATIC_WEEK_START_ISO);

  const dayBuckets = new Map<string, { hours: number; trips: number }>();
  for (let i = 0; i < days; i++) {
    const d0 = new Date(start.getTime() + i * DAY_MS);
    dayBuckets.set(ymd(d0), { hours: 0, trips: 0 });
  }

  (opsTasksRaw as any[]).forEach((t) => {
    const s = toDate(t?.start);
    const e = toDate(t?.end);
    if (!s || !e) return;

    const dKey = ymd(new Date(s.getTime() - (s.getTimezoneOffset() * 60 * 1000))); // keep day stable
    if (!dayBuckets.has(dKey)) return;

    const durHrs = Math.max(0, (e.getTime() - s.getTime()) / 3_600_000);
    const bucket = dayBuckets.get(dKey)!;
    bucket.hours += durHrs;
    bucket.trips += 1;
  });

  // Adapter returns { date, operatingHours, trips, distanceKm } per day
  return Array.from(dayBuckets.entries()).map(([day, v]) => {
    const d0 = new Date(`${day}T00:00:00.000Z`);
    const operatingHours = Number(v.hours.toFixed(2));
    return {
      date: d0.toISOString(),
      operatingHours,
      trips: v.trips,
      distanceKm: Math.round(operatingHours * 60), // simple proxy for visuals
    };
  });
}

// ===== Failures & Condition (history used by Reliability + badges) =====
export function getFailures() {
  return (failuresRaw as any[]).slice();
}

// ===== Technicians (for knowledge packs, etc.) =====
export function getTechnicians() {
  return (techniciansRaw as any[]).slice();
}

// ===== Availability for the static week (22 Aug 2025) =====
// Returns interval slots 08:00–16:00 UTC for each tech, per day.
export function getAvailability(days = 7) {
  const techs = getTechnicians();
  const start = new Date(getDemoWeekStart()); // '2025-08-22T00:00:00.000Z'
  const out: any[] = [];

  for (let i = 0; i < days; i++) {
    // Build day in UTC to avoid TZ drift
    const dayUTC = new Date(Date.UTC(
      start.getUTCFullYear(),
      start.getUTCMonth(),
      start.getUTCDate() + i, 0, 0, 0, 0
    ));

    for (const t of techs) {
      const id = String(t?.id ?? t?.techId ?? t?.name ?? `T-${i}`);
      const s = new Date(dayUTC); s.setUTCHours(8, 0, 0, 0);
      const e = new Date(dayUTC); e.setUTCHours(16, 0, 0, 0);
      out.push({
        technicianId: id,
        start: s.toISOString(),
        end: e.toISOString(),
        kind: 'available',
      });
    }
  }

  return out;
}



export function getConditionSnapshots() {
  return (conditionRaw as any[]).slice();
}

// ===== Preventive Maintenance definitions =====
export function getPMTasks() {
  return (pmRaw as any[]).slice();
}

// ===== Parts catalog (tolerant to export style) =====
export function getPartsCatalog() {
  // Accept common shapes: PARTS, default, parts
  const anyPC = partsCatalog as any;
  return (anyPC?.PARTS ?? anyPC?.default ?? anyPC?.parts ?? []) as any[];
}
