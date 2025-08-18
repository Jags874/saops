// src/agents/scheduler.ts
// Proposer + ops rebalancers used by the UI.

import type { WorkOrder } from '../types';

// Helper: parse "YYYY-MM-DDTHH:MM:SS" as local time (no Z)
function toDateLocal(s: string) { return new Date(String(s).replace('Z', '')); }
function fmtLocal(d: Date) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}
function hoursBetween(a: Date, b: Date) { return Math.max(0, (b.getTime() - a.getTime()) / 36e5); }
function overlaps(aStart?: string, aEnd?: string, bStart?: string, bEnd?: string) {
  if (!aStart || !aEnd || !bStart || !bEnd) return false;
  const aS = toDateLocal(aStart).getTime(), aE = toDateLocal(aEnd).getTime();
  const bS = toDateLocal(bStart).getTime(), bE = toDateLocal(bEnd).getTime();
  return aS < bE && bS < aE;
}
function clampToBusiness(d: Date, startH: number, _endH: number) {
  const x = new Date(d);
  x.setMinutes(0, 0, 0);
  if (x.getHours() < startH) x.setHours(startH);
  return x;
}

export function proposeSchedule(
  current: any[],          // workorders (merged state from adapter)
  _opsTasks: any[],        // latest ops tasks (not needed here but kept for signature)
  policy?: { businessHours?: [number, number] }
) {
  const business = policy?.businessHours ?? null;

  const result: WorkOrder[] = current.map(w => ({ ...w }));
  const rationale: string[] = [];
  let moved = 0, scheduled = 0, unscheduled = 0;
  const movedIds: string[] = [], scheduledIds: string[] = [], unscheduledIds: string[] = [];

  if (business) {
    const [startH, endH] = business;
    for (const w of result) {
      if (!w.start || !w.end || w.status === 'Closed') continue;
      const s = clampToBusiness(toDateLocal(w.start), startH, endH);
      const durH = w.hours ?? hoursBetween(toDateLocal(w.start), toDateLocal(w.end));
      const endDt = new Date(s.getTime() + durH * 36e5);
      const newStart = fmtLocal(s);
      const newEnd = fmtLocal(endDt);
      if (newStart !== w.start || newEnd !== w.end) {
        w.start = newStart; w.end = newEnd; w.status = 'Scheduled';
        moved++; movedIds.push(String(w.id));
      }
    }
    if (moved) rationale.push(`Snapped ${moved} maintenance tasks to business hours ${startH}:00–${endH}:00.`);
  }

  for (const w of result) {
    if (w.status === 'Closed') continue;
    if (w.start && w.end) { scheduled++; scheduledIds.push(String(w.id)); }
    else { unscheduled++; unscheduledIds.push(String(w.id)); }
  }

  return { workorders: result, rationale, moved, scheduled, unscheduled, movedIds, scheduledIds, unscheduledIds };
}

// Move ops tasks within ±opsFlexDays to remove overlap with scheduled WOs in business hours
export function rebalanceOpsForMaintenance(
  wos: any[],
  opsTasks: any[],
  policy: { opsFlexDays?: number, businessHours?: [number, number], forceBusinessHours?: boolean }
): Array<{ type: 'MOVE_OPS_TASK', id: string, start: string, end: string }> {
  const flexDays = Math.max(0, policy?.opsFlexDays ?? 0);
  const flexMs = flexDays * 24 * 36e5;
  const moves: Array<{ type: 'MOVE_OPS_TASK', id: string, start: string, end: string }> = [];
  if (!flexMs) return moves;

  const scheduledWOs = (wos ?? []).filter((w: any) => w && w.start && w.end && w.status !== 'Closed');

  for (const t of opsTasks ?? []) {
    if (!t.start || !t.end) continue;
    const tS0 = toDateLocal(t.start), tE0 = toDateLocal(t.end);
    const dur = tE0.getTime() - tS0.getTime();
    let bestShift: number | null = null;
    const conflicts = scheduledWOs.filter((w: any) =>
      String(w.vehicleId) === String(t.vehicleId) && overlaps(w.start, w.end, t.start, t.end)
    );
    if (!conflicts.length) continue;

    const candidates: number[] = [];
    for (let h = 1; h <= 8; h++) { candidates.push(-h * 36e5); candidates.push(h * 36e5); }
    for (let d = 1; d <= flexDays; d++) { candidates.push(-d * 24 * 36e5); candidates.push(d * 24 * 36e5); }

    for (const sh of candidates) {
      if (Math.abs(sh) > flexMs) continue;
      const sDt = new Date(tS0.getTime() + sh);
      const eDt = new Date(sDt.getTime() + dur);
      const sIso = fmtLocal(sDt), eIso = fmtLocal(eDt);
      const still = scheduledWOs.some((w: any) => overlaps(w.start, w.end, sIso, eIso) && String(w.vehicleId) === String(t.vehicleId));
      if (!still) { bestShift = sh; break; }
    }

    if (bestShift !== null) {
      const sDt = new Date(tS0.getTime() + bestShift);
      const eDt = new Date(sDt.getTime() + dur);
      moves.push({ type: 'MOVE_OPS_TASK', id: String(t.id), start: fmtLocal(sDt), end: fmtLocal(eDt) });
    }
  }
  return moves;
}

// Ensure no overlapping ops per vehicle (simple forward-push repair) — numeric timeline, explicit types.
export function fixOpsOverlaps(
  opsTasks: any[],
  options: { dayStartHour?: number } = {}
): Array<{ type: 'MOVE_OPS_TASK', id: string, start: string, end: string }> {
  const dayStart: number = options.dayStartHour ?? 6;
  const moves: Array<{ type: 'MOVE_OPS_TASK', id: string, start: string, end: string }> = [];

  // Group by vehicle
  const byV = new Map<string, any[]>();
  for (const t of opsTasks ?? []) {
    if (!byV.has(t.vehicleId)) byV.set(t.vehicleId, []);
    byV.get(t.vehicleId)!.push(t);
  }

  for (const [, list] of byV.entries()) {
    const L = list.slice().sort((a, b) => toDateLocal(a.start).getTime() - toDateLocal(b.start).getTime());

    // Use NaN sentinel so type stays `number` (not union)
    let nextFreeMs: number = Number.NaN;

    for (const t of L) {
      const s0Ms: number = toDateLocal(t.start).getTime();
      const e0Ms: number = toDateLocal(t.end).getTime();
      const durMs: number = Math.max(0, e0Ms - s0Ms);

      if (Number.isNaN(nextFreeMs)) {
        nextFreeMs = e0Ms;
        continue;
      }

      if (s0Ms < nextFreeMs) {
        // push to nextFreeMs
        let startMs: number = nextFreeMs;
        let endMs: number = startMs + durMs;

        // If it spills into next day, wrap to next morning at dayStart
        const startDt: Date = new Date(startMs);
        const endDt: Date = new Date(endMs);
        if (startDt.getDate() !== endDt.getDate()) {
          const nextMorning: Date = new Date(startDt);
          nextMorning.setDate(nextMorning.getDate() + 1);
          nextMorning.setHours(dayStart, 0, 0, 0);
          startMs = nextMorning.getTime();
          endMs = startMs + durMs;
        }

        moves.push({
          type: 'MOVE_OPS_TASK',
          id: String(t.id),
          start: fmtLocal(new Date(startMs)),
          end: fmtLocal(new Date(endMs))
        });
        nextFreeMs = endMs;
      } else {
        nextFreeMs = Math.max(nextFreeMs, e0Ms);
      }
    }
  }

  return moves;
}
