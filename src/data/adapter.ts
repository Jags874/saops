// src/data/adapter.ts
import vehiclesRaw from './fake/vehicles.json';
import workordersRaw from './fake/workorders.json';
import opsTasksRaw from './fake/ops_tasks.json';
import failuresRaw from './fake/failures.json';
import conditionRaw from './fake/condition.json';

import type {
  Vehicle, WorkOrder, OpsTask, DemandRecord, FailureRecord, ConditionSnapshot, Skill
} from '../types';

// Static demo week anchor (local midnight)
const WEEK_START = new Date('2025-08-22T00:00:00');

// ---------- helpers ----------
function toISO(d?: string | null): string | undefined {
  if (!d) return undefined;
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return undefined;
  return dt.toISOString();
}
function hoursDiff(a?: string, b?: string): number | undefined {
  const s = a ? new Date(a) : undefined;
  const e = b ? new Date(b) : undefined;
  if (!s || !e || isNaN(s.getTime()) || isNaN(e.getTime())) return undefined;
  return Math.max(0, (e.getTime() - s.getTime()) / 36e5);
}
function ymdLocal(d: Date) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

// Normalize parts/tools regardless of where they appear in JSON
function normalizeParts(input: any): string[] | undefined {
  const src =
    input?.requiredParts ??
    input?.parts ??
    input?.required_resources?.parts ??
    input?.required_resources?.Parts;

  if (!Array.isArray(src) || src.length === 0) return undefined;
  const out = src
    .map((p: any) => {
      if (typeof p === 'string') return p;
      if (p && typeof p === 'object') {
        const id = p.partId ?? p.part_id ?? p.id ?? '';
        const name = p.partName ?? p.part_name ?? p.name ?? '';
        const qty = p.qty ?? p.quantity ?? '';
        const label = name || id || 'part';
        return qty ? `${label} x${qty}` : label;
      }
      return String(p);
    })
    .filter(Boolean);
  return out.length ? out : undefined;
}
function normalizeTools(input: any): string[] | undefined {
  const src =
    input?.requiredTools ??
    input?.tools ??
    input?.required_resources?.tools ??
    input?.required_resources?.Tools;

  if (!Array.isArray(src) || src.length === 0) return undefined;
  const out = src
    .map((t: any) => {
      if (typeof t === 'string') return t;
      if (t && typeof t === 'object') {
        return t.name ?? t.tool ?? t.id ?? JSON.stringify(t);
      }
      return String(t);
    })
    .filter(Boolean);
  return out.length ? out : undefined;
}

// ---------- Vehicles ----------
export function getVehicles(limit?: number): Vehicle[] {
  const arr: any[] = (vehiclesRaw as unknown as any[]) ?? [];
  const out = arr.map(v => ({
    id: String(v.id ?? v.vehicleId ?? v.code ?? ''),
    model: v.model ?? 'Prime Mover',
    year: Number(v.year ?? 2021),
    status: (v.status ?? 'AVAILABLE') as Vehicle['status'],
    criticality: (v.criticality ?? 'Low') as Vehicle['criticality'],
    odometerKm: Number(v.odometerKm ?? v.odometer ?? 0),
    engineHours: Number(v.engineHours ?? v.hours ?? 0),
    photoUrl: v.photoUrl ?? '/assets/prime-mover.png',
  })) as Vehicle[];
  return typeof limit === 'number' ? out.slice(0, limit) : out;
}

// ---------- Work Orders ----------
export function getWorkOrders(): WorkOrder[] {
  const src: any[] = (workordersRaw as unknown as any[]) ?? [];
  return src.map(w => {
    const startRaw = w.start ?? w.scheduled_start ?? w.scheduledStart ?? null;
    const endRaw   = w.end   ?? w.scheduled_end   ?? w.scheduledEnd   ?? null;

    const startISO = toISO(startRaw);
    const endISO   = toISO(endRaw);

    const hours =
      typeof w.hours === 'number'
        ? w.hours
        : hoursDiff(startISO, endISO);

    const requiredSkills: Skill[] | undefined =
      Array.isArray(w.requiredSkills) ? (w.requiredSkills as Skill[]) :
      (w.subsystem === 'electrical' ? (['AutoElec'] as Skill[]) : (['Mechanic'] as Skill[]));

    return {
      id: String(w.id ?? w.work_order_id ?? w.woId ?? ''),
      vehicleId: String(w.vehicleId ?? w.asset_id ?? w.assetId ?? ''),
      title: String(w.title ?? w.description ?? 'Maintenance Task'),
      type: (w.type ?? w.wo_type ?? 'Corrective') as WorkOrder['type'],
      priority: (w.priority ?? 'Medium') as WorkOrder['priority'],
      status: (w.status ?? 'Open') as WorkOrder['status'],
      subsystem: w.subsystem ?? w.system ?? undefined,
      requiredSkills,
      requiredParts: normalizeParts(w),
      requiredTools: normalizeTools(w),
      technicianId: w.technicianId ?? w.assigned_to ?? undefined,
      hours,
      start: startISO,
      end: endISO,
      description: w.notes ?? w.long_description ?? w.description ?? undefined,
    } as WorkOrder;
  });
}

// ---------- Ops Tasks ----------
export function getOpsTasks(_days = 7): OpsTask[] {
  const src: any[] = (opsTasksRaw as unknown as any[]) ?? [];
  return src.map((t, i) => {
    const sISO = toISO((t as any).start ?? (t as any).scheduled_start ?? (t as any).scheduledStart ?? '');
    const eISO = toISO((t as any).end   ?? (t as any).scheduled_end   ?? (t as any).scheduledEnd   ?? '');
    const idCandidate = (t as any)['id'] ?? (t as any)['opsId'] ?? `OPS-${i + 1}`;
    return {
      id: String(idCandidate),
      vehicleId: String((t as any).vehicleId ?? (t as any).asset_id ?? ''),
      title: String((t as any).title ?? 'Transport Task'),
      start: sISO ?? new Date('2025-08-22T00:00:00').toISOString(),
      end:   eISO ?? new Date('2025-08-22T01:00:00').toISOString(),
      demandHours: Number((t as any).hours ?? (t as any).demandHours ?? hoursDiff(sISO, eISO) ?? 0),
    } as OpsTask;
  });
}

// ---------- Demand (derived from ops tasks; attributed to the task start date) ----------
export function getDemandHistory(horizonDays = 7): DemandRecord[] {
  const start = new Date(WEEK_START);
  const byDay = new Map<string, number>();
  for (let i = 0; i < horizonDays; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    byDay.set(ymdLocal(d), 0);
  }

  const ops: any[] = (opsTasksRaw as unknown as any[]) ?? [];
  for (const t of ops) {
    const sISO = toISO((t as any).start ?? (t as any).scheduled_start ?? (t as any).scheduledStart ?? '');
    const eISO = toISO((t as any).end   ?? (t as any).scheduled_end   ?? (t as any).scheduledEnd   ?? '');
    if (!sISO || !eISO) continue;
    const day = ymdLocal(new Date(sISO));
    if (!byDay.has(day)) continue; // ignore tasks outside the horizon
    const hours = Number((t as any).hours ?? (t as any).demandHours ?? hoursDiff(sISO, eISO) ?? 0);
    byDay.set(day, (byDay.get(day) ?? 0) + hours);
  }

  return Array.from(byDay.entries()).map(([date, hours]) => ({ date, hours }));
}

// ---------- Failures ----------
export function getFailures(): FailureRecord[] {
  const src: any[] = (failuresRaw as unknown as any[]) ?? [];
  return src.map(f => ({
    id: String((f as any).id ?? (f as any).failure_id ?? ''),
    vehicleId: String((f as any).vehicleId ?? (f as any).asset_id ?? ''),
    subsystem: String((f as any).subsystem ?? (f as any).system ?? 'engine'),
    partId: (f as any).partId ?? (f as any).part_id ?? undefined,
    failureMode: String((f as any).failureMode ?? (f as any).failure_mode ?? 'unknown'),
    date: toISO((f as any).date ?? (f as any).failure_date ?? new Date().toISOString())!,
    downtimeHours: Number((f as any).downtimeHours ?? (f as any).downtime_hours ?? 0),
  })) as FailureRecord[];
}

// ---------- Condition ----------
export function getCondition(): ConditionSnapshot[] {
  const src: any[] = (conditionRaw as unknown as any[]) ?? [];
  return src.map(c => {
    const score = Number((c as any).condition ?? (c as any).score ?? 80);
    const band = (((c as any).band ??
      (score >= 80 ? 'Good' : score >= 60 ? 'Watch' : 'Poor')) as 'Good' | 'Watch' | 'Poor');
    return {
      vehicleId: String((c as any).vehicleId ?? (c as any).asset_id ?? ''),
      date: String((c as any).date ?? '').slice(0, 10),
      subsystem: String((c as any).subsystem ?? 'engine'),
      condition: score,
      band,
      notes: (c as any).notes ?? undefined,
    };
  }) as ConditionSnapshot[];
}
