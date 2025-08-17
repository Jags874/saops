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
  return (workordersRaw as any[]).slice();
}

// ===== Ops Tasks filtered by LOCAL 7-day window with overlap semantics =====
export function getOpsTasks(days = 7) {
  const anchorUTC = new Date(STATIC_WEEK_START_ISO);
  // Local midnight for the same calendar date as the UTC anchor (22 Aug 2025)
  const localStart = new Date(
    anchorUTC.getUTCFullYear(),
    anchorUTC.getUTCMonth(),
    anchorUTC.getUTCDate(),
    0, 0, 0, 0
  );
  const localEnd = new Date(localStart.getTime() + days * DAY_MS);

  return (opsTasksRaw as any[]).filter((t) => {
    const s = toDate(t?.start);
    const e = toDate(t?.end);
    if (!s || !e) return false;
    // Include if it overlaps the [localStart, localEnd) window at all
    return e > localStart && s < localEnd;
  });
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
