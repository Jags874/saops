// src/data/resourceStore.ts
import { getDemoWeekStart } from './adapter';
import type { Skill, Technician } from '../types';

type AvKind = 'available' | 'leave';
export type AvailabilitySlot = {
  technicianId: string;      // keep this name for summary
  start: string;             // ISO
  end: string;               // ISO
  kind: AvKind;              // available | leave
};

// ----------------- in-memory store -----------------
let seeded = false;
let techs: Technician[] = [];
// store leaves as YYYY-MM-DD per tech
const leaveDays: Map<string, Set<string>> = new Map();
// optional parts availability hints (for agents that mutate)
const availableParts: Set<string> = new Set();

const SKILLS: Skill[] = ['Mechanic', 'AutoElec'];

function ymd(d: Date) { return d.toISOString().slice(0, 10); }
function atStartOfDay(d: Date) { const x = new Date(d); x.setHours(0,0,0,0); return x; }
function plusDays(d: Date, n: number) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

// ----------------- seeding -----------------
export function reseedGenericTechnicians() {
  if (seeded) return;
  // Smaller, scarce team by design
  techs = [
    { id: 'T-M-01', name: 'Alex M.',  skills: ['Mechanic'] },
    { id: 'T-M-02', name: 'Jamie M.', skills: ['Mechanic'] },
    { id: 'T-M-03', name: 'Riley M.', skills: ['Mechanic'] },
    { id: 'T-M-04', name: 'Casey M.', skills: ['Mechanic'] },
    { id: 'T-E-01', name: 'Sam E.',   skills: ['AutoElec'] },
    { id: 'T-E-02', name: 'Drew E.',  skills: ['AutoElec'] },
  ];
  seeded = true;
}

function buildWeekDays(horizon = 7): string[] {
  const start = atStartOfDay(new Date(getDemoWeekStart()));
  return Array.from({ length: horizon }, (_, i) => ymd(plusDays(start, i)));
}

// ----------------- availability generation -----------------
function genDailyIntervals(horizon = 7): AvailabilitySlot[] {
  const days = buildWeekDays(horizon);
  const out: AvailabilitySlot[] = [];

  for (const t of techs) {
    const leaves = leaveDays.get(t.id) ?? new Set<string>();
    for (const d of days) {
      const day = new Date(`${d}T00:00:00`);
      const s = new Date(day); s.setHours(8, 0, 0, 0);
      const e = new Date(day); e.setHours(16, 0, 0, 0);

      if (leaves.has(d)) {
        out.push({
          technicianId: t.id,
          start: s.toISOString(),
          end: e.toISOString(),
          kind: 'leave',
        });
      } else {
        out.push({
          technicianId: t.id,
          start: s.toISOString(),
          end: e.toISOString(),
          kind: 'available',
        });
      }
    }
  }
  return out;
}

// ----------------- public snapshot -----------------
export function getResourceSnapshot(horizon = 7): { technicians: Technician[]; availability: AvailabilitySlot[] } {
  // Always generated relative to the static demo week start
  const availability = genDailyIntervals(horizon);
  return { technicians: techs.slice(), availability };
}

// ----------------- mutations for agents -----------------
type Mutation =
  | { type: 'ADD_TECHNICIAN'; id?: string; name?: string; skills?: Skill[] }
  | { type: 'REMOVE_TECHNICIAN'; id: string }
  | { type: 'SET_LEAVE'; techId: string; dates: string[] }       // dates = ['2025-08-22', ...]
  | { type: 'CLEAR_LEAVE'; techId: string; dates?: string[] }
  | { type: 'MARK_PART_AVAILABLE'; partId: string };

export function applyMutations(mutations: Mutation[]): string[] {
  const notes: string[] = [];
  for (const m of mutations ?? []) {
    switch (m.type) {
      case 'ADD_TECHNICIAN': {
        const id = m.id ?? genTechId(m.skills ?? ['Mechanic']);
        const name = m.name ?? suggestName(id);
        const skills = (m.skills && m.skills.length ? m.skills : ['Mechanic']) as Skill[];
        if (techs.find(t => t.id === id)) {
          notes.push(`Tech ${id} already exists — skipped`);
          break;
        }
        techs.push({ id, name, skills });
        notes.push(`Added technician ${id} (${skills.join(', ')})`);
        break;
      }
      case 'REMOVE_TECHNICIAN': {
        const before = techs.length;
        techs = techs.filter(t => t.id !== m.id);
        leaveDays.delete(m.id);
        notes.push(before === techs.length ? `No technician ${m.id} found` : `Removed technician ${m.id}`);
        break;
      }
      case 'SET_LEAVE': {
        const set = leaveDays.get(m.techId) ?? new Set<string>();
        for (const d of m.dates ?? []) set.add(d.slice(0, 10));
        leaveDays.set(m.techId, set);
        notes.push(`Set leave for ${m.techId} on ${[...(m.dates ?? [])].join(', ')}`);
        break;
      }
      case 'CLEAR_LEAVE': {
        if (!m.dates || !m.dates.length) {
          leaveDays.delete(m.techId);
          notes.push(`Cleared all leave for ${m.techId}`);
        } else {
          const set = leaveDays.get(m.techId) ?? new Set<string>();
          for (const d of m.dates) set.delete(d.slice(0, 10));
          leaveDays.set(m.techId, set);
          notes.push(`Cleared leave dates for ${m.techId}: ${m.dates.join(', ')}`);
        }
        break;
      }
      case 'MARK_PART_AVAILABLE': {
        availableParts.add(m.partId);
        notes.push(`Marked part ${m.partId} as available`);
        break;
      }
      default:
        notes.push(`Unknown mutation ${(m as any).type ?? '<?>'} — ignored`);
    }
  }
  return notes;
}

// ----------------- small helpers -----------------
function genTechId(skills: Skill[]): string {
  const kind = (skills[0] ?? 'Mechanic') === 'AutoElec' ? 'E' : 'M';
  const seq = techs.filter(t => (t.skills?.[0] ?? 'Mechanic') === (kind === 'E' ? 'AutoElec' : 'Mechanic')).length + 1;
  return `T-${kind}-${String(seq).padStart(2, '0')}`;
}
function suggestName(id: string) {
  return id.includes('-E-') ? 'New AutoElec' : 'New Mechanic';
}
