// src/data/mutatePlan.ts
import type { WorkOrder, OpsTask, Skill } from '../types';

/* ===================== config & utils ===================== */

const ANCHOR_YEAR = 2025; // keep all user-entered dates anchored to 2025

const clampMin = (n: number, min: number) => (Number.isFinite(n) ? Math.max(n, min) : min);

function cloneArr<T>(arr: T[]): T[] {
  return arr.map(x => ({ ...(x as any) }));
}

function toLocalISO(d: Date): string {
  // local-ISO (no trailing 'Z') so the Gantt shows wall-clock time reliably
  const t = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return t.toISOString().replace('Z', '');
}

function addHours(d: Date, h: number): Date {
  return new Date(d.getTime() + h * 3_600_000);
}

function parseISO(maybe?: string): Date | null {
  if (!maybe) return null;
  const d = new Date(maybe);
  return Number.isFinite(+d) ? d : null;
}

function durationHoursFrom(a?: string, b?: string, fallback?: number): number {
  const A = a ? new Date(a) : null;
  const B = b ? new Date(b) : null;
  if (A && B && Number.isFinite(+A) && Number.isFinite(+B)) {
    const ms = +B - +A;
    return clampMin(ms / 3_600_000, 0.25);
  }
  return clampMin(fallback ?? 1, 0.25);
}

function snapYear(d: Date | null): Date | null {
  if (!d) return d;
  if (d.getFullYear() !== ANCHOR_YEAR) {
    const nd = new Date(d);
    nd.setFullYear(ANCHOR_YEAR);
    return nd;
  }
  return d;
}

function nextWoId(existing: WorkOrder[]): string {
  const nums = existing
    .map(w => w.id.match(/WO-(\d+)/)?.[1])
    .filter(Boolean)
    .map(n => parseInt(n as string, 10));
  const next = nums.length ? Math.max(...nums) + 1 : 1;
  return `WO-${String(next).padStart(3, '0')}`;
}

// Local ISO without trailing 'Z' (writes wall‑clock times safely for the Gantt)
function isoLocal(d: Date): string {
  const t = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return t.toISOString().replace('Z', '');
}


const SKILL_ALIASES: Record<string, Skill> = {
  mechanic: 'Mechanical' as Skill,
  mechanical: 'Mechanical' as Skill,
  electrician: 'Electrical' as Skill,
  electrical: 'Electrical' as Skill,
  hydraulics: 'Hydraulic' as Skill,
  hydraulic: 'Hydraulic' as Skill,
  body: 'Body' as Skill,
  panel: 'Body' as Skill,
  tyre: 'Tyre' as Skill,
  tires: 'Tyre' as Skill,
  diagnostics: 'Diagnostics' as Skill,
  diagnostic: 'Diagnostics' as Skill,
};

function normalizeSkillLabel(label: unknown): Skill | null {
  const raw = String(label ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (SKILL_ALIASES[raw]) return SKILL_ALIASES[raw];
  const tcase = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
  return (tcase as unknown) as Skill;
}

// Map strings the LLM/user might say → your Skill union
function normalizeSkill(s: unknown): Skill | null {
  const raw = String(s ?? '').trim().toLowerCase();
  if (!raw) return null;
  switch (raw) {
    case 'mechanic':
    case 'mechanical':  return 'Mechanical' as Skill;
    case 'electrician':
    case 'electrical':  return 'Electrical' as Skill;
    case 'hydraulic':
    case 'hydraulics':  return 'Hydraulic'  as Skill;
    case 'body':
    case 'panel':       return 'Body'       as Skill;
    case 'tyre':
    case 'tire':
    case 'tires':       return 'Tyre'       as Skill;
    case 'diagnostic':
    case 'diagnostics': return 'Diagnostics' as Skill;
    default:
      // Title‑case fallback (helps if your Skill union already matches)
      const t = raw.charAt(0).toUpperCase() + raw.slice(1);
      return t as unknown as Skill;
  }
}

// Keep priority strictly in your Priority union
function normalizePriority(p: unknown): WorkOrder['priority'] {
  const raw = String(p ?? '').toLowerCase();
  if (raw === 'low' || raw === 'medium' || raw === 'high') {
    return (raw.charAt(0).toUpperCase() + raw.slice(1)) as WorkOrder['priority'];
  }
  return 'Medium';
}

// Heuristic: guess WoType from the title; fallback to a safe default
function inferWoType(title: unknown): WorkOrder['type'] {
  const t = String(title ?? '').toLowerCase();
  if (t.includes('inspect')) return 'Inspection' as WorkOrder['type'];
  if (t.includes('service') || t.includes('maint')) return 'Preventive' as WorkOrder['type'];
  if (t.includes('repair') || t.includes('fault'))  return 'Corrective' as WorkOrder['type'];
  // If your WoType union includes 'Maintenance' use that; otherwise pick one you have:
  return 'Preventive' as WorkOrder['type'];
}


/* ===================== mutation contracts ===================== */

export type MoveWo   = { type: 'MOVE_WO';   id: string; start?: string; end?: string; hours?: number; demandHours?: number };
export type CancelWo = { type: 'CANCEL_WO'; id: string };

export type MoveOps   = { type: 'MOVE_OPS';   id: string; start?: string; end?: string; hours?: number; demandHours?: number };
export type CancelOps = { type: 'CANCEL_OPS'; id: string };

export type AddWo = {
  type: 'ADD_WO';
  vehicleId: string;
  title: string;
  hours?: number;
  demandHours?: number;        // tolerated for back-compat
  requiredSkills?: string[] | Skill[];
  priority?: WorkOrder['priority'];
  start?: string;
};

export type Mutation = MoveWo | CancelWo | MoveOps | CancelOps | AddWo;

export type ApplyResult = {
  workorders: WorkOrder[];
  opsTasks: OpsTask[];
  notes: string[];
};

/* ============== OPS id normalization (accept multiple styles) ============== */

function buildOpsIndex(opsTasks: OpsTask[]) {
  const idx = new Map<string, number>();
  opsTasks.forEach((t, i) => {
    const id = String((t as any).id ?? '').toUpperCase();
    idx.set(id, i);

    const num = id.match(/(\d+)/)?.[1];
    const veh = String((t as any).vehicleId ?? '').toUpperCase();

    if (num) {
      idx.set(`OPS-${num}`, i);
      idx.set(`OP-${num}`, i);
      if (veh) {
        idx.set(`OPS-${veh}-${num}`, i);
        idx.set(`OP-${veh}-${num}`, i);
      }
    }
  });
  return idx;
}

function resolveOpsIndex(map: Map<string, number>, raw: string): number {
  const key = raw.toUpperCase();
  if (map.has(key)) return map.get(key)!;
  const num = key.match(/(\d+)/)?.[1];
  if (num && map.has(`OPS-${num}`)) return map.get(`OPS-${num}`)!;
  if (num && map.has(`OP-${num}`))  return map.get(`OP-${num}`)!;
  return -1;
}

/* ===================== main apply function ===================== */

export function applyMutationsToPlan(
  workordersIn: WorkOrder[],
  opsTasksIn: OpsTask[],
  mutationsIn: Mutation[] | any[],
  _policy?: { businessHours?: [number, number] }
): ApplyResult {
  const workorders = cloneArr(workordersIn);
  const opsTasks   = cloneArr(opsTasksIn);
  const notes: string[] = [];

  // accept both `op` or `type`, and `demandHours` as alias of `hours`
  const mutations: Array<Mutation & { op?: string }> = (mutationsIn ?? []).map((m: any) => {
    const type = m.type ?? m.op; // accept `op`
    const hours = m.hours ?? m.demandHours;
    return { ...m, type, hours };
  });

  const woById = new Map(workorders.map(w => [String(w.id).toUpperCase(), w]));
  const opsIdx = buildOpsIndex(opsTasks);

  for (const m of mutations) {
    /* ------------ MOVE_WO ------------ */
    if (m.type === 'MOVE_WO') {
      const w = woById.get(String((m as any).id).toUpperCase());
      if (!w) { notes.push(`MOVE_WO: ${(m as any).id} not found`); continue; }

      let startD = snapYear(parseISO(m.start ?? (w.start as any)));
      let endD   = snapYear(parseISO(m.end   ?? (w.end   as any)));

      const demand = clampMin(
        m.hours ?? (w as any).hours ?? durationHoursFrom(w.start as any, w.end as any, 2),
        0.25
      );

      if (!startD && !endD) { notes.push(`MOVE_WO: ${(m as any).id} needs start or end`); continue; }
      if (startD && !endD) endD = addHours(startD, demand);
      if (!startD && endD) startD = addHours(endD, -demand);

      if (startD) w.start = toLocalISO(startD);
      if (endD)   w.end   = toLocalISO(endD);
      (w as any).status = 'Scheduled';
      (w as any).hours  = demand;

      notes.push(`Moved ${w.id} — ${new Date(w.start as any).toLocaleString()} (${demand}h)`);
      continue;
    }

    /* ------------ CANCEL_WO ------------ */
    if (m.type === 'CANCEL_WO') {
      const w = woById.get(String((m as any).id).toUpperCase());
      if (!w) { notes.push(`CANCEL_WO: ${(m as any).id} not found`); continue; }
      (w as any).status = 'Cancelled';
      (w as any).start  = undefined;
      (w as any).end    = undefined;
      notes.push(`Cancelled ${w.id}`);
      continue;
    }

    /* ------------ MOVE_OPS ------------ */
    if (m.type === 'MOVE_OPS') {
      const idx = resolveOpsIndex(opsIdx, String((m as any).id));
      if (idx < 0) { notes.push(`MOVE_OPS: ${(m as any).id} not found`); continue; }

      const t = opsTasks[idx];

      let startD = snapYear(parseISO(m.start ?? (t.start as any)));
      let endD   = snapYear(parseISO(m.end   ?? (t.end   as any)));

      const demand = clampMin(
        m.hours ?? (t as any).hours ?? durationHoursFrom(t.start as any, t.end as any, 4),
        0.25
      );

      if (!startD && !endD) { notes.push(`MOVE_OPS: ${(m as any).id} needs start or end`); continue; }
      if (startD && !endD) endD = addHours(startD, demand);
      if (!startD && endD) startD = addHours(endD, -demand);

      if (startD) t.start = toLocalISO(startD);
      if (endD)   t.end   = toLocalISO(endD);
      (t as any).hours = demand;

      notes.push(`Moved ${t.id} — ${new Date(t.start as any).toLocaleString()} (${demand}h)`);
      continue;
    }

    /* ------------ CANCEL_OPS ------------ */
    if (m.type === 'CANCEL_OPS') {
      const idx = resolveOpsIndex(opsIdx, String((m as any).id));
      if (idx < 0) { notes.push(`CANCEL_OPS: ${(m as any).id} not found`); continue; }
      const t = opsTasks[idx];
      (t as any).status = 'Cancelled';
      notes.push(`Cancelled ${t.id}`);
      continue;
    }

    /* ------------ ADD_WO ------------ */
if (m.type === 'ADD_WO') {
  const id = nextWoId(workorders);

  // duration (prefer m.hours, fallback m.demandHours)
  const demand = clampMin((m.hours ?? m.demandHours ?? 1), 0.25);

  // parse start -> compute end
  const startD = parseISO(m.start);
  const endD   = startD ? addHours(startD, demand) : null;

  // normalize to your unions
  const status: WorkOrder['status']     = startD ? 'Scheduled' : 'Open';
  const priority: WorkOrder['priority'] = normalizePriority((m as any).priority);
  const woType: WorkOrder['type']       = inferWoType((m as any).title);

  // normalize skills → Skill[]
  const reqSkills: Skill[] | undefined = (m.requiredSkills && m.requiredSkills.length)
    ? (m.requiredSkills.map(normalizeSkill).filter(Boolean) as Skill[])
    : undefined; // keep it undefined if none provided, since your type marks it optional

  const w: WorkOrder = {
    id,
    vehicleId: String(m.vehicleId),
    title: String(m.title),
    type: woType,                 // <-- REQUIRED by your WorkOrder
    priority,
    status,
    hours: demand,
    requiredSkills: reqSkills,    // optional in your type, ok to be undefined
    start: startD ? isoLocal(startD) : undefined,
    end:   endD   ? isoLocal(endD)   : undefined,
  };

  workorders.push(w);
  notes.push(
    `Added ${w.id} (${w.title}) for ${w.vehicleId}` +
    (startD ? ` at ${new Date(w.start as any).toLocaleString()}` : '') +
    ` (${demand}h)`
  );
  continue;
}




    /* ------------ Unknown type (leave a breadcrumb) ------------ */
    {
      const typeStr = (m as any)?.type ?? '(missing type/op)';
      let payload = '';
      try { payload = JSON.stringify(m); } catch { payload = '[unstringifiable]'; }
      notes.push(`Unknown mutation type: ${String(typeStr)} for ${payload}`);
    }
  }

  // Final safety: if any records still have a trailing 'Z', rewrite to local-ISO
  for (const w of workorders) {
    if ((w as any).start && String((w as any).start).endsWith('Z')) (w as any).start = toLocalISO(new Date((w as any).start));
    if ((w as any).end   && String((w as any).end).endsWith('Z'))   (w as any).end   = toLocalISO(new Date((w as any).end));
  }
  for (const t of opsTasks) {
    if ((t as any).start && String((t as any).start).endsWith('Z')) (t as any).start = toLocalISO(new Date((t as any).start));
    if ((t as any).end   && String((t as any).end).endsWith('Z'))   (t as any).end   = toLocalISO(new Date((t as any).end));
  }

  return { workorders, opsTasks, notes };
}
