// src/agents/context.ts
import { getVehicles, getWorkOrders, getOpsTasks } from '../data/adapter';
import { getResourceSnapshot } from '../data/resourceStore';

// Fixed week anchor — the demo runs 22–28 Aug 2025
const WEEK_START_ISO = '2025-08-22T00:00:00';
const WEEK_START = new Date(WEEK_START_ISO);

export type KnowledgePack = {
  weekStartISO: string;
  horizonDays: number;
  businessHours: [number, number];
  vehicles: Array<{ id: string; status: string; model?: string; criticality?: string }>;
  workorders: Array<{
    id: string;
    vehicleId: string;
    title: string;
    priority: string;
    type: string;
    status: string;
    start?: string;
    end?: string;
    hours?: number;
    requiredSkills?: string[];
  }>;
  opsTasks: Array<{
    opsId: string;
    vehicleId: string;
    title: string;
    start: string;
    end: string;
  }>;
  availability: {
    // YMD -> { Mechanic:number, AutoElec:number }
    byDaySkill: Record<string, Record<string, number>>;
  };
  idSets: {
    workorderIds: string[];
    opsIds: string[];
    vehicleIds: string[];
  };
  kpis: {
    woOutstanding: number;
    woScheduled: number;
    woUnscheduled: number;
    opsCount: number;
  };
};

function ymd(d: Date) { return d.toISOString().slice(0, 10); }
function startOfDay(d: Date) { const x = new Date(d); x.setHours(0,0,0,0); return x; }

export function buildKnowledgePack(opts?: { horizonDays?: number; baseWorkorders?: ReturnType<typeof getWorkOrders> }): KnowledgePack {
  const horizonDays = Number(opts?.horizonDays ?? 7);

  const vehicles = getVehicles(20).map(v => ({
    id: v.id,
    status: v.status,
    model: (v as any).model,
    criticality: (v as any).criticality
  }));

  const workorders = (opts?.baseWorkorders ?? getWorkOrders()).map(w => ({
    id: w.id,
    vehicleId: w.vehicleId,
    title: w.title,
    priority: w.priority,
    type: w.type,
    status: w.status,
    start: w.start,
    end: w.end,
    hours: w.hours,
    requiredSkills: (w as any).requiredSkills ?? undefined,
  }));

  // Ops tasks already seeded with stable opsId in your data layer
  const opsTasks = getOpsTasks(horizonDays).map(t => ({
    opsId: (t as any).opsId || (t as any).id || '',
    vehicleId: t.vehicleId,
    title: t.title,
    start: t.start,
    end: t.end,
  }));

  // Simple availability roll-up for the static week
  const { technicians, availability } = getResourceSnapshot();
  const byDaySkill: Record<string, Record<string, number>> = {};
  const day0 = startOfDay(WEEK_START);
  for (let i = 0; i < horizonDays; i++) {
    const key = ymd(new Date(day0.getTime() + i * 86400000));
    byDaySkill[key] = { Mechanic: 0, AutoElec: 0 };
  }

  const techSkills = new Map<string, string[]>();
  for (const t of technicians ?? []) {
    techSkills.set(t.id, (t.skills?.length ? t.skills : ['Mechanic']));
  }
  for (const slot of availability ?? []) {
    const day = slot.date?.slice(0, 10);
    if (!day || !(day in byDaySkill)) continue;
    const skills = techSkills.get(slot.technicianId) ?? ['Mechanic'];
    for (const s of skills) {
      byDaySkill[day][s] = (byDaySkill[day][s] ?? 0) + Number(slot.hours ?? 0);
    }
  }

  const woOutstanding = workorders.filter(w => w.status === 'Open' || w.status === 'Scheduled' || w.status === 'In Progress').length;
  const woScheduled   = workorders.filter(w => w.status === 'Scheduled').length;
  const woUnscheduled = workorders.filter(w => (w.status === 'Open' || !w.start) && w.status !== 'Closed').length;

  const idSets = {
    workorderIds: workorders.map(w => w.id.toUpperCase()),
    opsIds: opsTasks.map(o => String(o.opsId).toUpperCase()),
    vehicleIds: vehicles.map(v => v.id.toUpperCase()),
  };

  return {
    weekStartISO: WEEK_START_ISO,
    horizonDays,
    businessHours: [8, 17],
    vehicles,
    workorders,
    opsTasks,
    availability: { byDaySkill },
    idSets,
    kpis: { woOutstanding, woScheduled, woUnscheduled, opsCount: opsTasks.length },
  };
}
