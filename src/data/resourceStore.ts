// src/data/resourceStore.ts
import type { Technician, AvailabilitySlot, Skill } from '../types';

// Minimal mutation shape understood by applyMutations
export type AgentMutation = { op: string; [k: string]: any };

// In-memory stores (shared across calls)
let technicians: Technician[] = [];
let availability: AvailabilitySlot[] = [];
let seeded = false;

const WEEK_START = new Date('2025-08-22T00:00:00');
function ymdLocal(d: Date) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}
function weekDays(start = WEEK_START, days = 7): string[] {
  const out: string[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    out.push(ymdLocal(d));
  }
  return out;
}

/** Seed a smaller, generic team once (Mechanic & AutoElec) with 8h/day availability. */
export function reseedGenericTechnicians() {
  if (seeded) return;
  technicians = [
    { id: 'T-M1', name: 'Alex Carter', skills: ['Mechanic'] as Skill[] },
    { id: 'T-M2', name: 'Sam Morgan',  skills: ['Mechanic'] as Skill[] },
    { id: 'T-E1', name: 'Jamie Lee',   skills: ['AutoElec'] as Skill[] },
  ];
  const days = weekDays(WEEK_START, 7);
  availability = [];
  for (const d of days) {
    for (const t of technicians) {
      availability.push({ technicianId: t.id, date: d, hours: 8 });
    }
  }
  seeded = true;
}

/** Snapshot used by ResourceSummary and scheduler */
export function getResourceSnapshot(): { technicians: Technician[]; availability: AvailabilitySlot[] } {
  return { technicians: [...technicians], availability: [...availability] };
}

/** Apply resource/parts mutations coming from the Scheduler Agent */
export function applyMutations(muts: AgentMutation[] = []): string[] {
  const notes: string[] = [];
  for (const m of muts) {
    const op = String(m.op ?? '').toUpperCase();

    if (op === 'ADD_TECH') {
      const id: string = m.id ?? `T-${Math.random().toString(36).slice(2, 7)}`;
      const name: string = m.name ?? 'New Tech';
      const skills: Skill[] = (Array.isArray(m.skills) && m.skills.length ? m.skills : ['Mechanic']) as Skill[];
      technicians.push({ id, name, skills });
      // default availability: 8h/day across the demo week
      for (const d of weekDays(WEEK_START, 7)) {
        availability.push({ technicianId: id, date: d, hours: Number(m.dailyHours ?? 8) });
      }
      notes.push(`Added technician ${name} (${skills.join(', ')}) with default availability.`);
      continue;
    }

    if (op === 'REMOVE_TECH') {
      const tid: string = m.technicianId ?? m.id;
      if (!tid) { notes.push('REMOVE_TECH missing technicianId'); continue; }
      technicians = technicians.filter(t => t.id !== tid);
      availability = availability.filter(a => a.technicianId !== tid);
      notes.push(`Removed technician ${tid} and their availability.`);
      continue;
    }

    if (op === 'SET_AVAIL') {
      const tid: string = m.technicianId;
      const date: string = m.date;
      const hours: number = Number(m.hours ?? 0);
      if (!tid || !date) { notes.push('SET_AVAIL missing technicianId/date'); continue; }
      let slot = availability.find(a => a.technicianId === tid && a.date === date);
      if (!slot) {
        slot = { technicianId: tid, date, hours: 0 };
        availability.push(slot);
      }
      slot.hours = hours;
      notes.push(`Set availability for ${tid} on ${date} to ${hours}h.`);
      continue;
    }

    // Accept but no-op unknown/parts mutations (other stores may handle them)
    if (op.startsWith('ADD_PART') || op.startsWith('SET_PART') || op.startsWith('REMOVE_PART')) {
      notes.push(`(Parts store not modeled) Acknowledged ${op}.`);
      continue;
    }

    // Unhandled op
    notes.push(`Unknown mutation ${op} — ignored`);
  }
  return notes;
}
