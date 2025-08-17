// src/data/resourceStore.ts
import { getTechnicians, getAvailability } from './adapter';
import { getPartsCatalog } from './partsCatalog';
import type { Mutation } from '../types';

export type Tech = { id: string; name: string; skills: string[]; depot?: string };
export type Avail = { technicianId: string; date: string; hours: number };
export type Part = ReturnType<typeof getPartsCatalog>[number];

let technicians: Tech[] = [];
let availability: Avail[] = [];
let parts: Part[] = [];

export function reseedGenericTechnicians() {
  const raw = getTechnicians?.() ?? [];
  const norm = raw.map((t: any, i: number) => ({
    id: String(t.id ?? `tech${i+1}`),
    name: String(t.name ?? `Tech ${i+1}`),
    skills: (t.skills ?? ['Mechanic']).map((s: string) => /elec/i.test(s) ? 'AutoElec' : 'Mechanic'),
    depot: t.depot ?? 'Depot A'
  }));
  const mech = norm.filter((t: any) => t.skills.includes('Mechanic')).slice(0, 4);
  const elec = norm.filter((t: any) => t.skills.includes('AutoElec')).slice(0, 2);
  technicians = [...mech, ...elec];

  const ids = new Set(technicians.map(t => t.id));
  availability = (getAvailability?.() ?? [])
    .filter((a: any) => ids.has(String(a.technicianId)))
    .map((a: any) => ({ technicianId: String(a.technicianId), date: String(a.date), hours: Number(a.hours ?? 8) }));

  parts = getPartsCatalog();
}

export function getResourceSnapshot() {
  return { technicians, availability, parts };
}

export function applyMutations(muts: Mutation[]): string[] {
  const notes: string[] = [];
  for (const m of muts) {
    if (m.op === 'ADD_TECH') {
      const id = m.id ?? `tech${technicians.length + 1}`;
      technicians.push({ id, name: m.name ?? id, skills: [m.skill], depot: m.depot ?? 'Depot A' });
      notes.push(`Added tech ${id} (${m.skill})${m.depot ? ` @ ${m.depot}` : ''}`);
    }
    if (m.op === 'SET_AVAILABILITY') {
      const idx = availability.findIndex(a => a.technicianId === m.technicianId && a.date === m.date);
      if (idx >= 0) availability[idx].hours = m.hours;
      else availability.push({ technicianId: m.technicianId, date: m.date, hours: m.hours });
      notes.push(`Set availability for ${m.technicianId} on ${m.date} = ${m.hours}h`);
    }
    if (m.op === 'MARK_PART_AVAILABLE') {
      const p = parts.find(x => x.part_id === m.partId);
      if (p) {
        (p as any).stock = Number((p as any).stock ?? 0) + (m.qty ?? 0);
        if (m.eta) (p as any).eta = m.eta;
      } else {
        (parts as any).push({ part_id: m.partId, part_name: m.partId, subsystem: 'unknown', stock: m.qty ?? 0, eta: m.eta });
      }
      notes.push(`Part ${m.partId}: +${m.qty ?? 0} stock${m.eta ? ` (eta ${m.eta})` : ''}`);
    }
  }
  return notes;
}
