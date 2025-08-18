// src/data/resourceStore.ts
import type { Technician, AvailabilitySlot, WorkOrder } from '../types';

// ===== Technicians + availability (seed + runtime) =====
let technicians: Technician[] = [];
let availability: AvailabilitySlot[] = [];

// Runtime overlays
const woOverlay = new Map<string, WorkOrder>();               // added/created WOs
const woPatches = new Map<string, Partial<WorkOrder>>();      // patches to base/overlay WOs (e.g., MOVE/UPDATE)
const opsOverlay = new Map<string, any>();                    // id -> ops partial (we merge onto base in adapter)
const cancelledOps = new Set<string>();                       // explicit cancels
const pendingConflictWO = new Set<string>();                  // WO ids whose first overlapping ops should be cancelled

export function reseedGenericTechnicians() {
  technicians = [
    { id: 'T01', name: 'Alex M', skills: ['Mechanic'] },
    { id: 'T02', name: 'Blake R', skills: ['Mechanic'] },
    { id: 'T03', name: 'Casey E', skills: ['AutoElec'] },
  ];
  // Week from 2025-08-22, 8h per tech per day
  const start = new Date(Date.UTC(2025, 7, 22, 0, 0, 0));
  const DAY = 86_400_000;
  availability = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start.getTime() + i * DAY);
    const y = d.getUTCFullYear(), m = String(d.getUTCMonth() + 1).padStart(2, '0'), day = String(d.getUTCDate()).padStart(2, '0');
    const ymd = `${y}-${m}-${day}`;
    for (const t of technicians) availability.push({ date: ymd, technicianId: t.id, hours: 8 });
  }
}

export function getResourceSnapshot() {
  return { technicians: [...technicians], availability: [...availability] };
}

// ===== Overlay getters for adapter =====
export function getRuntimeWorkordersOverlay(): WorkOrder[] { return Array.from(woOverlay.values()); }
export function getRuntimeWOPatches(): Array<{ id: string; patch: Partial<WorkOrder> }> {
  return Array.from(woPatches.entries()).map(([id, patch]) => ({ id, patch }));
}
export function getRuntimeOpsOverlay(): any[] { return Array.from(opsOverlay.values()); }
export function getCancelledOpsIds(): Set<string> { return cancelledOps; }
export function getPendingOpsCancelConflicts(): string[] { return Array.from(pendingConflictWO.values()); }
export function addCancelledOps(ids: string[]) { for (const id of ids) cancelledOps.add(id.toUpperCase()); }
export function clearPendingOpsCancelConflicts() { pendingConflictWO.clear(); }

// ===== Mutations =====
export function applyMutations(mutations: any[] = []): string[] {
  const notes: string[] = [];
  for (const m of mutations) {
    const kind = String(m?.type ?? m?.op ?? '').toUpperCase();

    // --- Work orders ---
    if (kind === 'ADD_WORKORDER') {
      const w = m?.workorder;
      if (w?.id) { woOverlay.set(w.id, { ...w }); notes.push(`Work order ${w.id} added/updated`); }
      else notes.push('ADD_WORKORDER missing payload — ignored');
      continue;
    }
    if (kind === 'UPDATE_WORKORDER') {
      const id = String(m?.id ?? '');
      const patch: Partial<WorkOrder> = m?.patch ?? {};
      if (!id) { notes.push('UPDATE_WORKORDER missing id — ignored'); continue; }
      if (woOverlay.has(id)) {
        const cur = woOverlay.get(id)!;
        woOverlay.set(id, { ...cur, ...patch });
      } else {
        const prev = woPatches.get(id) ?? {};
        woPatches.set(id, { ...prev, ...patch });
      }
      notes.push(`Work order ${id} updated`);
      continue;
    }
    if (kind === 'MOVE_WORKORDER') {
      const id = String(m?.id ?? '');
      if (!id) { notes.push('MOVE_WORKORDER missing id — ignored'); continue; }
      const patch: Partial<WorkOrder> = { start: m.start, end: m.end, status: 'Scheduled' };
      if (woOverlay.has(id)) {
        const cur = woOverlay.get(id)!;
        woOverlay.set(id, { ...cur, ...patch });
      } else {
        const prev = woPatches.get(id) ?? {};
        woPatches.set(id, { ...prev, ...patch });
      }
      notes.push(`Work order ${id} moved`);
      continue;
    }
    if (kind === 'CANCEL_WORKORDER') {
      const id = String(m?.id ?? '');
      if (!id) { notes.push('CANCEL_WORKORDER missing id — ignored'); continue; }
      const patch: Partial<WorkOrder> = { status: 'Closed' };
      if (woOverlay.has(id)) {
        const cur = woOverlay.get(id)!;
        woOverlay.set(id, { ...cur, ...patch });
      } else {
        const prev = woPatches.get(id) ?? {};
        woPatches.set(id, { ...prev, ...patch });
      }
      notes.push(`Work order ${id} cancelled`);
      continue;
    }

    // --- Ops tasks ---
    if (kind === 'ADD_OPS_TASK') {
      const t = m?.task;
      if (t?.id) {
        opsOverlay.set(String(t.id).toUpperCase(), { ...t }); // full object; adapter will merge onto base
        notes.push(`Ops task ${t.id} added/updated`);
      } else {
        notes.push('ADD_OPS_TASK missing payload — ignored');
      }
      continue;
    }
    if (kind === 'MOVE_OPS_TASK') {
      const id = String(m?.id ?? '').toUpperCase();
      if (!id) { notes.push('MOVE_OPS_TASK missing id — ignored'); continue; }
      // We allow moving a base task by creating a *partial* overlay (adapter merges onto base).
      const cur = opsOverlay.get(id) ?? { id };
      opsOverlay.set(id, { ...cur, id, start: m.start, end: m.end });
      notes.push(`Ops task ${id} moved`);
      continue;
    }
    if (kind === 'CANCEL_OPS_TASK') {
      const id = m?.id ? String(m.id).toUpperCase() : undefined;
      const conflictsWith = m?.conflictsWith ? String(m.conflictsWith).toUpperCase() : undefined;
      if (id) { cancelledOps.add(id); notes.push(`Ops task ${id} cancelled`); }
      else if (conflictsWith) { pendingConflictWO.add(conflictsWith); notes.push(`Will cancel ops task conflicting with ${conflictsWith}`); }
      else { notes.push('CANCEL_OPS_TASK missing id/conflictsWith — ignored'); }
      continue;
    }

    // --- Resources ---
    if (kind === 'ADD_TECH') {
      const t = m?.tech;
      if (t?.id) {
        const exists = technicians.find(x => x.id === t.id);
        if (exists) Object.assign(exists, t);
        else technicians.push({ id: t.id, name: t.name ?? t.id, skills: t.skills ?? ['Mechanic'] });
        notes.push(`Tech ${t.id} added/updated`);
      } else {
        notes.push('ADD_TECH missing tech — ignored');
      }
      continue;
    }
    if (kind === 'REMOVE_TECH') {
      const id = String(m?.id ?? '');
      if (!id) { notes.push('REMOVE_TECH missing id — ignored'); continue; }
      technicians = technicians.filter(t => t.id !== id);
      availability = availability.filter(a => a.technicianId !== id);
      notes.push(`Tech ${id} removed`);
      continue;
    }
    if (kind === 'ADD_AVAILABILITY') {
      const s = m?.slot;
      if (s?.date && s?.technicianId && typeof s?.hours === 'number') {
        const i = availability.findIndex(a => a.date === s.date && a.technicianId === s.technicianId);
        if (i >= 0) availability[i] = { ...s }; else availability.push({ ...s });
        notes.push(`Availability ${s.technicianId} on ${s.date} = ${s.hours}h`);
      } else {
        notes.push('ADD_AVAILABILITY missing slot — ignored');
      }
      continue;
    }
    if (kind === 'REMOVE_AVAILABILITY') {
      const s = m?.slot;
      if (s?.date && s?.technicianId) {
        availability = availability.filter(a => !(a.date === s.date && a.technicianId === s.technicianId));
        notes.push(`Availability removed ${s.technicianId} on ${s.date}`);
      } else {
        notes.push('REMOVE_AVAILABILITY missing slot — ignored');
      }
      continue;
    }

    // Unknown
    notes.push(kind ? `Unknown mutation ${kind} — ignored` : 'Malformed mutation — ignored');
  }
  return notes;
}
