// src/agents/scheduler.ts
// Lightweight proposer + ops rebalancer used by the UI.
// - proposeSchedule: builds a maintenance proposal (keeps your existing preview/accept flow).
// - rebalanceOpsForMaintenance: moves ops tasks within a flex window to clear business-hours for WOs.

import type { WorkOrder } from '../types';

// Helper: parse "YYYY-MM-DDTHH:MM:SS" as local time (no Z)
function toDateLocal(s: string) {
  return new Date(s.replace('Z',''));
}
function fmtLocal(d: Date) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}
function hoursBetween(a: Date, b: Date) {
  return Math.max(0, (b.getTime() - a.getTime()) / 36e5);
}
function clampToBusiness(d: Date, startH: number, endH: number) {
  const x = new Date(d);
  x.setMinutes(0,0,0);
  if (x.getHours() < startH) x.setHours(startH);
  if (x.getHours() >= endH) x.setHours(startH);
  return x;
}
function overlaps(aStart?: string, aEnd?: string, bStart?: string, bEnd?: string) {
  if (!aStart || !aEnd || !bStart || !bEnd) return false;
  const aS = toDateLocal(aStart).getTime();
  const aE = toDateLocal(aEnd).getTime();
  const bS = toDateLocal(bStart).getTime();
  const bE = toDateLocal(bEnd).getTime();
  return aS < bE && bS < aE;
}

export function proposeSchedule(
  current: any[],          // workorders (merged state from adapter)
  opsTasks: any[],         // latest ops tasks
  policy?: { businessHours?: [number, number] }
) {
  const business = policy?.businessHours ?? null;

  const result: WorkOrder[] = current.map(w => ({ ...w }));
  const rationale: string[] = [];

  let moved = 0, scheduled = 0, unscheduled = 0;
  const movedIds: string[] = [];
  const scheduledIds: string[] = [];
  const unscheduledIds: string[] = [];

  // Very lightweight: snap scheduled WOs to business hours if requested.
  if (business) {
    const [startH, endH] = business;
    for (const w of result) {
      if (!w.start || !w.end || w.status === 'Closed') continue;
      const s = clampToBusiness(toDateLocal(w.start), startH, endH);
      const durH = w.hours ?? hoursBetween(toDateLocal(w.start), toDateLocal(w.end));
      const e = new Date(s.getTime() + durH * 36e5);
      const newStart = fmtLocal(s);
      const newEnd = fmtLocal(e);
      if (newStart !== w.start || newEnd !== w.end) {
        w.start = newStart;
        w.end = newEnd;
        w.status = 'Scheduled';
        moved++; movedIds.push(String(w.id));
      }
    }
    if (moved) rationale.push(`Snapped ${moved} maintenance tasks to business hours ${startH}:00–${endH}:00.`);
  }

  // Count scheduled/unscheduled
  for (const w of result) {
    if (w.status === 'Closed') continue;
    if (w.start && w.end) {
      if (!business) scheduled++;
      else scheduled++; // after snapping
      scheduledIds.push(String(w.id));
    } else {
      unscheduled++;
      unscheduledIds.push(String(w.id));
    }
  }

  return {
    workorders: result,
    rationale,
    moved, scheduled, unscheduled,
    movedIds, scheduledIds, unscheduledIds,
  };
}

// Move ops tasks within ±opsFlexDays to remove overlap with scheduled WOs in business hours
export function rebalanceOpsForMaintenance(
  wos: any[],            // scheduled workorders (use preview or accepted)
  opsTasks: any[],       // current ops tasks
  policy: { opsFlexDays?: number, businessHours?: [number, number], forceBusinessHours?: boolean }
): Array<{ type: 'MOVE_OPS_TASK', id: string, start: string, end: string }> {

  const flexDays = Math.max(0, policy?.opsFlexDays ?? 0);
  const flexMs = flexDays * 24 * 36e5;

  const moves: Array<{ type: 'MOVE_OPS_TASK', id: string, start: string, end: string }> = [];
  if (!flexMs) return moves;

  const scheduledWOs = (wos ?? []).filter((w: any) => w && w.start && w.end && w.status !== 'Closed');

  // For each ops task that overlaps a scheduled WO for same vehicle, shift minimally within ±flex
  for (const t of opsTasks ?? []) {
    if (!t.start || !t.end) continue;

    const tS0 = toDateLocal(t.start);
    const tE0 = toDateLocal(t.end);
    const dur = tE0.getTime() - tS0.getTime();
    let bestShift: number | null = null;

    const conflicts = scheduledWOs.filter((w: any) =>
      String(w.vehicleId) === String(t.vehicleId) && overlaps(w.start, w.end, t.start, t.end)
    );
    if (!conflicts.length) continue;

    // Evaluate candidate shifts: same day early/late, previous day late, next day early … within ±flex
    const candidates: number[] = [];
    // Try shifting earlier/later by 1–8 hours in 1h steps, also whole-day +/- within flex
    for (let h = 1; h <= 8; h++) { candidates.push(-h * 36e5); candidates.push(h * 36e5); }
    for (let d = 1; d <= flexDays; d++) { candidates.push(-d * 24 * 36e5); candidates.push(d * 24 * 36e5); }

    for (const sh of candidates) {
      if (Math.abs(sh) > flexMs) continue;
      const s = new Date(tS0.getTime() + sh);
      const e = new Date(s.getTime() + dur);
      const sIso = fmtLocal(s);
      const eIso = fmtLocal(e);
      const stillConflicts = scheduledWOs.some((w: any) => overlaps(w.start, w.end, sIso, eIso) && String(w.vehicleId) === String(t.vehicleId));
      if (!stillConflicts) { bestShift = sh; break; }
    }

    if (bestShift !== null) {
      const s = new Date(tS0.getTime() + bestShift);
      const e = new Date(s.getTime() + dur);
      moves.push({ type: 'MOVE_OPS_TASK', id: String(t.id), start: fmtLocal(s), end: fmtLocal(e) });
    }
  }

  return moves;
}
