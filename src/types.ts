// src/types.ts

export type VehicleStatus = 'AVAILABLE' | 'DUE' | 'DOWN';
export type Criticality = 'Low' | 'Medium' | 'High';
export type Priority = 'Low' | 'Medium' | 'High' | 'Critical';
export type WoType = 'Preventive' | 'Corrective' | 'Inspection' | 'Other';
export type Skill = 'Mechanic' | 'AutoElec';

export type Vehicle = {
  id: string;
  model?: string;
  year?: number;
  status: VehicleStatus;
  criticality?: Criticality;
  odometerKm?: number;
  engineHours?: number;
  photoUrl?: string;
};

export type WorkOrder = {
  id: string;
  vehicleId: string;
  title: string;
  type: WoType;
  priority: Priority;
  status: 'Open' | 'Scheduled' | 'In Progress' | 'Closed';
  subsystem?: string;
  requiredSkills?: Skill[];
  /** Normalized for UI popups */
  requiredParts?: string[];
  /** Normalized for UI popups */
  requiredTools?: string[];
  technicianId?: string;
  hours?: number;
  start?: string; // ISO
  end?: string;   // ISO
  description?: string;
};

export type OpsTask = {
  id: string; // unique ops id
  vehicleId: string;
  title: string;
  start: string; // ISO
  end: string;   // ISO
  demandHours?: number;
};

export type DemandRecord = {
  date: string; // YYYY-MM-DD
  hours: number;
};

export type FailureRecord = {
  id: string;
  vehicleId: string;
  subsystem: string;
  partId?: string;
  failureMode: string;
  date: string; // ISO
  downtimeHours: number;
};

export type ConditionBand = 'Good' | 'Watch' | 'Poor';

export type ConditionSnapshot = {
  vehicleId: string;
  date: string; // YYYY-MM-DD
  subsystem: string;
  condition: number;
  band: ConditionBand;
  notes?: string;
};

/** NEW: used by resourceStore and scheduler */
export type Technician = {
  id: string;
  name: string;
  skills: Skill[];
};

/** NEW: daily availability blocks (date-local, hours available that day) */
export type AvailabilitySlot = {
  technicianId: string;
  date: string; // YYYY-MM-DD
  hours: number; // e.g., 8 for full day
};

export type AgentKey = 'scheduler' | 'reliability' | 'parts';

// Scheduling / agent types (kept loose to avoid churn)
export type SchedulerPolicy = unknown;

export type ReportQuery =
  | { kind: 'UNSCHEDULED' }
  | { kind: 'MOVED' }
  | { kind: 'DELTA'; nBack?: number }
  | { kind: 'SCHEDULED_FOR_VEHICLE'; vehicleId: string };

export type QATurn = { role: 'user' | 'assistant'; text: string };

export type AgentDecision = {
  intent: 'QA' | 'MUTATE' | 'PLAN' | 'UNKNOWN';
  answer?: string;
  mutations?: Array<any>;
};

export type PlanContext = {
  lastAccepted?: {
    when: string;
    moved: number;
    scheduled: number;
    unscheduled: number;
    movedIds: string[];
    scheduledIds: string[];
    unscheduledIds: string[];
  };
  preview?: {
    when: string;
    moved: number;
    scheduled: number;
    unscheduled: number;
    movedIds: string[];
    scheduledIds: string[];
    unscheduledIds: string[];
  };
};
