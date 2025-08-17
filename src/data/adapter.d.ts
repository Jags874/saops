// src/data/adapter.d.ts
import type {
  Vehicle, WorkOrder, Priority, WoType, DemandRecord, PMTask,
  Technician, AvailabilitySlot, OpsTask, FailureRecord, ConditionSnapshot
} from '../types';

export function getVehicles(count?: number): Vehicle[];
export function getWorkOrders(): WorkOrder[];
export function getOpsTasks(days?: number): OpsTask[];
export function getPMTasks(): PMTask[];
export function getFailures(): FailureRecord[];
export function getDemandHistory(days?: number): DemandRecord[];
export function getTechnicians(): Technician[];
export function getAvailability(): AvailabilitySlot[];
export function getConditions(): ConditionSnapshot[];
