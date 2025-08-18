// src/agents/context.ts
import { getVehicles, getWorkOrders, getOpsTasks, getDemandHistory, getFailures, getCondition } from '../data/adapter';
import type { WorkOrder } from '../types';

/** Static demo week start (local midnight) */
export const WEEK_START = new Date('2025-08-22T00:00:00');

/** yyy-mm-dd helper */
function ymd(d: Date) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

export function buildKnowledgePack(opts?: { horizonDays?: number; baseWorkorders?: WorkOrder[] }) {
  const horizonDays = Math.max(1, Math.min(30, opts?.horizonDays ?? 7));
  const weekStart = WEEK_START;
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + horizonDays);

  const vehicles = getVehicles(20);
  const workorders = (opts?.baseWorkorders ?? getWorkOrders());
  const opsTasks = getOpsTasks(horizonDays);
  const demand = getDemandHistory(horizonDays);
  const failures = getFailures();
  const condition = getCondition();

  // Derive PM tasks for context (any WO with type === 'Preventive')
  const pmTasks = workorders.filter(w => w.type === 'Preventive');

  return {
    meta: {
      weekStartISO: weekStart.toISOString(),
      weekStartYMD: ymd(weekStart),
      horizonDays,
      generatedAt: new Date().toISOString(),
    },
    vehicles,
    workorders,
    pmTasks,
    opsTasks,
    demand,
    failures,
    condition,
    notes: [
      'Static demo week start set to 2025-08-22.',
      'Preventive maintenance tasks are derived from the current work-order set (type === "Preventive").',
    ],
  };
}
