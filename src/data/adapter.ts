// src/data/adapter.ts (file-backed initial load)
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

export function getVehicles(count = (vehicles as Vehicle[]).length): Vehicle[] {
  return (vehicles as Vehicle[]).slice(0, count);
}

export function getPMTasks(): PMTask[] {
  return pm as PMTask[];
}

export function getTechnicians(): Technician[] {
  return technicians as Technician[];
}

export function getAvailability(): AvailabilitySlot[] {
  return availability as AvailabilitySlot[];
}

export function getFailures(): FailureRecord[] {
  return failures as FailureRecord[];
}

export function getConditions(): ConditionSnapshot[] {
  return conditions as ConditionSnapshot[];
}

export function getOpsTasks(days = 7): OpsTask[] {
  // Filter to next `days` from "today" to keep UI tidy
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(end.getDate() + days);
  return (opsTasks as OpsTask[]).filter(t => {
    const s = new Date(t.start);
    return s >= start && s < end;
  });
}

export function getWorkOrders(): WorkOrder[] {
  return workorders as WorkOrder[];
}

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
