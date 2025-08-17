// src/data/resourceStore.ts
import type { Technician, AvailabilitySlot, WorkOrder } from '../types';

// ====== Technicians (your existing simplified model) ======
let technicians: Technician[] = [];
let availability: AvailabilitySlot[] = [];

export function reseedGenericTechnicians() {
  // Keep your existing seeding logic or this simple default:
  technicians = [
    { id: 'T01', name: 'Alex M', skills: ['Mechanic'] },
    { id: 'T02', name: 'Blake R', skills: ['Mechanic'] },
    { id: 'T03', name: 'Casey E', skills: ['AutoElec'] },
  ];
  // Static demo week starting 2025-08-22 local (Mon-Sun doesn’t matter visually)
  const start = new Date(Date.UTC(2025, 7, 22, 0, 0, 0)); // 22 Aug 2025
  const DAY = 86_400_000;

  availability = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start.getTime() + i * DAY);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    const ymd = `${y}-${m}-${day}`;
    // 8h per day per tech
    for (const t of technicians) {
      availability.push({ date: ymd, technicianId: t.id, hours: 8 });
    }
  }
}

export function getResourceSnapshot() {
  return { technicians, availability };
}

// ====== Runtime overlays & mutations ======

// Overlay for newly added / edited work orders
const runtimeWO = new Map<string, WorkOrder>();

// Ops task cancellations by explicit id
const cancelledOps = new Set<string>();

// Ops task cancellations requested by “conflictsWith: WO-…”
const pendingCancelByConflict = new Set<string>(); // holds WO ids

// Minimal note helper
function note(s: string) { return s; }

/**
 * Apply agent mutations (ADD_WORKORDER, CANCEL_OPS_TASK).
 * Return human-readable notes used by the UI.
 */
export function applyMutations(mutations: any[] = []): string[] {
  const notes: string[] = [];

  for (const m of mutations) {
    const kind = String(m?.type ?? m?.op ?? '').toUpperCase();

    if (kind === 'ADD_WORKORDER') {
      const w: WorkOrder | undefined = m?.workorder;
      if (w && w.id) {
        runtimeWO.set(w.id, { ...w });
        notes.push(note(`Added/updated work order ${w.id} (${w.vehicleId})`));
      } else {
        notes.push(note(`ADD_WORKORDER missing payload — ignored`));
      }
      continue;
    }

    if (kind === 'CANCEL_OPS_TASK') {
      const opId: string | undefined = m?.id;
      const conflictsWith: string | undefined = m?.conflictsWith;
      if (opId) {
        cancelledOps.add(opId.toUpperCase());
        notes.push(note(`Cancelled ops task ${opId.toUpperCase()}`));
      } else if (conflictsWith) {
        pendingCancelByConflict.add(conflictsWith.toUpperCase());
        notes.push(note(`Marked ops task conflicting with ${conflictsWith.toUpperCase()} for cancel`));
      } else {
        notes.push(note(`CANCEL_OPS_TASK missing id/conflictsWith — ignored`));
      }
      continue;
    }

    // Unknown mutation
    if (kind) {
      notes.push(note(`Unknown mutation ${kind} — ignored`));
    } else {
      notes.push(note(`Malformed mutation — ignored`));
    }
  }

  return notes;
}

// ====== Overlay accessors used by adapter.ts ======

export function getRuntimeWorkordersOverlay(): WorkOrder[] {
  return Array.from(runtimeWO.values());
}

export function getCancelledOpsIds(): Set<string> {
  return cancelledOps;
}

/** WO ids for which we should cancel the first overlapping ops task */
export function getPendingOpsCancelConflicts(): string[] {
  return Array.from(pendingCancelByConflict.values());
}

/** Mark a list of ops ids as cancelled (used after conflict resolution) */
export function addCancelledOps(ids: string[]) {
  for (const id of ids) cancelledOps.add(id.toUpperCase());
}

/** Clear conflict placeholders once resolved */
export function clearPendingOpsCancelConflicts() {
  pendingCancelByConflict.clear();
}
