// src/agents/scheduler.ts
import type { WorkOrder, OpsTask } from '../types';

function parseISO(x?: string): Date | null {
  if (!x) return null;
  const d = new Date(x);
  return isNaN(d.getTime()) ? null : d;
}

function overlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  const s1 = parseISO(aStart), e1 = parseISO(aEnd), s2 = parseISO(bStart), e2 = parseISO(bEnd);
  if (!s1 || !e1 || !s2 || !e2) return false;
  return !(e1 <= s2 || e2 <= s1);
}

/** Deterministic WO vs Ops overlap index. */
export function computeClashes(workorders: WorkOrder[], opsTasks: OpsTask[]) {
  let total = 0;
  const clashes: Array<{
    vehicleId: string;
    woId: string;
    opsId: string;
    woStart: string;
    woEnd: string;
    opsStart: string;
    opsEnd: string;
  }> = [];

  const opsKey = (t: OpsTask) => String((t as any).opsId ?? (t as any).opsID ?? t.id ?? '');

  for (const w of workorders) {
    if (!w.vehicleId || !w.start || !w.end || w.status === 'Closed') continue;
    for (const t of opsTasks) {
      if (t.vehicleId !== w.vehicleId) continue;
      if (!t.start || !t.end) continue;
      if (overlap(w.start, w.end, t.start, t.end)) {
        total++;
        clashes.push({
          vehicleId: w.vehicleId,
          woId: w.id,
          opsId: opsKey(t),
          woStart: w.start,
          woEnd: w.end,
          opsStart: t.start,
          opsEnd: t.end,
        });
      }
    }
  }

  return { total, clashes };
}

// Keep the signature used by Dashboard; leave your tuned logic if you have it.
export type SchedulerPolicy = { businessHours?: [number, number] };

export function proposeSchedule(
  workorders: WorkOrder[],
  _opsTasks: OpsTask[],
  _policy?: SchedulerPolicy
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
  // Placeholder — keep your current tuned implementation instead.
  return {
    workorders: [...workorders],
    moved: 0,
    scheduled: 0,
    unscheduled: 0,
    movedIds: [],
    scheduledIds: [],
    unscheduledIds: [],
    rationale: ['No changes (placeholder).'],
  };
}
