// src/types.ts

// ========== Shared enums/unions ==========
export type AgentKey = 'scheduler' | 'reliability' | 'parts';

export type VehicleStatus = 'AVAILABLE' | 'DUE' | 'DOWN';
export type Priority = 'Critical' | 'High' | 'Medium' | 'Low';
export type WoType = 'Corrective' | 'Preventive';
export type Skill = 'Mechanic' | 'AutoElec';

// ========== Core domain types ==========
export type Vehicle = {
  id: string;
  status: VehicleStatus;
  image?: string;
  model?: string;
  year?: number;
  criticality?: 'High' | 'Medium' | 'Low' | number;
  odometerKm?: number;
  engineHours?: number;
};

export type WorkOrder = {
  id: string;
  vehicleId: string;
  title: string;
  description?: string;
  type: WoType;
  priority: Priority;
  status: 'Open' | 'Scheduled' | 'In Progress' | 'Closed';
  subsystem?: string;
  start?: string; // ISO
  end?: string;   // ISO
  hours?: number;
  technicianId?: string;
  requiredSkills?: Skill[];
  parts?: Array<{ partId: string; qty: number }>;
  created?: string; // ISO
  tools?: string[];
};

export type OpsTask = {
  id: string;
  vehicleId: string;
  title: string;
  start: string; // ISO
  end: string;   // ISO
  hours: number;
};

export type ConditionBand = 'Good' | 'Fair' | 'Poor';
export type ConditionSnapshot = {
  vehicleId: string;
  date: string; // ISO
  bands: Record<string, ConditionBand>; // subsystem -> band
};

export type FailureRecord = {
  vehicleId: string;
  subsystem: string;
  failure_mode?: string;
  date: string; // ISO
  downtime_hours?: number;
};

export type DemandRecord = {
  date: string; // ISO
  vehicleId?: string;
  hours?: number;
};

export type PMTask = {
  id: string;
  title: string;
  subsystem?: string;
  interval?: string | number; // "500h" | "90d" | 500
  estimatedHours?: number;
  requiredSkills?: Skill[];
  parts?: Array<{ partId: string; qty: number }>;
};

export type Technician = {
  id: string;
  name: string;
  skills: Skill[];
  depot?: string;
};

export type AvailabilitySlot = {
  technicianId: string;
  date: string; // ISO
  hours: number;
};

// ========== Agent plumbing ==========
export type SchedulerPolicy = {
  windows?: Array<{ startHour: number; endHour: number }>;
  avoidOps?: boolean;
  weekendsAllowed?: boolean;
  vehicleScope?: string[];
  depotScope?: string[];
  horizonDays?: number;
  prioritize?: Array<'Corrective' | 'Preventive' | 'Critical' | 'High' | 'Medium' | 'Low'>;
  splitLongJobs?: boolean;
  maxChunkHours?: number;
};

export type ReportQuery = {
  kind: 'UNSCHEDULED' | 'MOVED' | 'SUMMARY' | 'SCHEDULED_FOR_VEHICLE' | 'DELTA';
  vehicleId?: string;
  nBack?: number;
};

export type QATurn = { role: 'user' | 'assistant'; text: string };

export type PlanContext = {
  lastAccepted?: {
    when: string;
    moved: number; scheduled: number; unscheduled: number;
    movedIds?: string[]; scheduledIds?: string[]; unscheduledIds?: string[];
  };
  preview?: {
    when: string;
    moved: number; scheduled: number; unscheduled: number;
    movedIds?: string[]; scheduledIds?: string[]; unscheduledIds?: string[];
  };
};

export type LLMIntent = 'SUGGEST' | 'ACCEPT' | 'REJECT' | 'REPORT' | 'QA' | 'MUTATE';

export type Mutation =
  | { op: 'ADD_TECH'; id?: string; name?: string; skill: Skill; depot?: string; hoursPerDay?: number }
  | { op: 'SET_AVAILABILITY'; technicianId: string; date: string; hours: number }
  | { op: 'MARK_PART_AVAILABLE'; partId: string; qty: number; eta?: string };

export type AgentDecision = {
  intent: LLMIntent;
  policy?: SchedulerPolicy;
  report?: ReportQuery;
  answer?: string;
  mutations?: Mutation[];
  confidence?: number;
};
