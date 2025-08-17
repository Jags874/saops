import React, { useMemo } from 'react';
import { getWorkOrders, getDemoWeekStart } from '../data/adapter';
import { getResourceSnapshot } from '../data/resourceStore';
import type { Skill, WorkOrder } from '../types';

const SKILLS: Skill[] = ['Mechanic', 'AutoElec'];
const DAY_MS = 86_400_000;

function ymdLocal(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function hoursBetween(a: Date, b: Date) {
  return Math.max(0, (b.getTime() - a.getTime()) / 3_600_000);
}

// Parse local wall-clock from ISO-ish string (ignore timezone suffix if present)
function parseLocal(iso?: string) {
  if (!iso) return null;
  const s = String(iso);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  const [, y, mo, d, hh = '00', mm = '00', ss = '00'] = m;
  const dt = new Date(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mm), Number(ss), 0);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

export default function ResourceSummary() {
  const horizon = 7;

  // Static local week: 22 Aug 2025 → +7d
  const startLocal = useMemo(() => {
    const anchorUTC = new Date(getDemoWeekStart()); // '2025-08-22T00:00:00Z'
    return new Date(
      anchorUTC.getUTCFullYear(),
      anchorUTC.getUTCMonth(),
      anchorUTC.getUTCDate(),
      0, 0, 0, 0
    );
  }, []);

  const days = useMemo(() => {
    return Array.from({ length: horizon }, (_, i) => {
      const d = new Date(startLocal.getTime() + i * DAY_MS);
      d.setHours(0, 0, 0, 0);
      return ymdLocal(d);
    });
  }, [startLocal, horizon]);
  const daySet = useMemo(() => new Set(days), [days]);

  const { technicians, availability } = getResourceSnapshot();
  const workorders: WorkOrder[] = useMemo(() => (getWorkOrders?.() ?? []), []);

  // Map tech -> skills (default Mechanic)
  const techSkills = useMemo(() => {
    const m = new Map<string, Skill[]>();
    for (const t of technicians ?? []) {
      const id = String((t as any).id ?? (t as any).techId ?? (t as any).name ?? '');
      const skills: Skill[] = ((t as any).skills?.length ? (t as any).skills : ['Mechanic']) as Skill[];
      if (id) m.set(id, skills);
    }
    return m;
  }, [technicians]);

  // Availability per day+skill — **mirror the scheduler logic**
  const availByDaySkill = useMemo(() => {
    const map = new Map<string, Map<Skill, number>>();
    for (const d of days) map.set(d, new Map<Skill, number>(SKILLS.map(s => [s, 0])));

    for (const a of availability ?? []) {
      // Day key
      let dayKey: string | null = null;
      if (typeof (a as any).date === 'string') {
        dayKey = String((a as any).date).slice(0, 10);
      } else if ((a as any).start) {
        const s = parseLocal((a as any).start);
        if (s) dayKey = ymdLocal(new Date(s.getFullYear(), s.getMonth(), s.getDate(), 0, 0, 0, 0));
      }
      if (!dayKey || !daySet.has(dayKey)) continue;

      // Hours
      let hrs = 0;
      if (typeof (a as any).hours === 'number') {
        hrs = Number((a as any).hours);
      } else if ((a as any).start && (a as any).end) {
        const s = parseLocal((a as any).start);
        const e = parseLocal((a as any).end);
        if (s && e) hrs = hoursBetween(s, e);
      }

      // Tech skills
      const techId = String((a as any).technicianId ?? (a as any).techId ?? '');
      const skills = techSkills.get(techId) ?? (['Mechanic'] as Skill[]);

      const m = map.get(dayKey)!;
      for (const sk of skills) m.set(sk, (m.get(sk) ?? 0) + hrs);
    }

    return map;
  }, [availability, techSkills, days, daySet]);

  // Scheduled maintenance per day+skill
  const schedByDaySkill = useMemo(() => {
    const map = new Map<string, Map<Skill, number>>();
    for (const d of days) map.set(d, new Map<Skill, number>(SKILLS.map(s => [s, 0])));

    for (const w of workorders ?? []) {
      if (!(w.status === 'Scheduled' || w.status === 'In Progress')) continue;
      if (!w.start || !w.end) continue;

      const s = parseLocal(w.start);
      const e = parseLocal(w.end);
      if (!s || !e) continue;

      const dayKey = ymdLocal(new Date(s.getFullYear(), s.getMonth(), s.getDate(), 0, 0, 0, 0));
      if (!daySet.has(dayKey)) continue;

      const dur = Number.isFinite(Number(w.hours)) ? Number(w.hours) : hoursBetween(s, e);

      const explicit = (w as any).requiredSkills as Skill[] | undefined;
      const skills: Skill[] = explicit && explicit.length
        ? explicit
        : (String((w as any).subsystem || '').toLowerCase().includes('elect') ? (['AutoElec'] as Skill[]) : (['Mechanic'] as Skill[]));

      const per = dur / Math.max(1, skills.length);
      const m = map.get(dayKey)!;
      for (const sk of skills) m.set(sk, (m.get(sk) ?? 0) + per);
    }

    return map;
  }, [workorders, daySet, days]);

  // Roll-up cards
  const rows = useMemo(() => {
    return SKILLS.map((skill) => {
      let availableHours = 0;
      let scheduledHours = 0;
      for (const d of days) {
        availableHours += availByDaySkill.get(d)!.get(skill)!;
        scheduledHours += schedByDaySkill.get(d)!.get(skill)!;
      }
      const utilisationPct = availableHours > 0 ? Math.round((scheduledHours / availableHours) * 100) : 0;
      return { skill, availableHours: Math.round(availableHours), scheduledHours: Math.round(scheduledHours), utilisationPct };
    });
  }, [days, availByDaySkill, schedByDaySkill]);

  // Today mini-bars
  const today = days[0];
  const todayBars = SKILLS.map((skill) => {
    const a = availByDaySkill.get(today)!.get(skill)!;
    const s = schedByDaySkill.get(today)!.get(skill)!;
    const pct = a > 0 ? Math.min(100, Math.round((s / a) * 100)) : 0;
    return { skill, a: Math.round(a), s: Math.round(s), pct };
  });

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <div className="text-slate-100 text-sm font-semibold">Resource Utilisation</div>
      <div className="text-xs text-slate-400 mb-3">Capacity vs scheduled maintenance (next {horizon} days)</div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {rows.map(({ skill, availableHours, scheduledHours, utilisationPct }) => (
          <div key={skill} className="rounded-lg border border-slate-800 bg-slate-900/50 p-3">
            <div className="flex items-center justify-between">
              <div className="text-slate-200 text-sm font-medium">{skill}</div>
              <div className="text-xs text-slate-400">{utilisationPct}% utilised</div>
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
              <div className="rounded-md bg-slate-800/60 border border-slate-700 p-2">
                <div className="text-slate-400">Available</div>
                <div className="text-slate-100 font-semibold">{availableHours} h</div>
              </div>
              <div className="rounded-md bg-slate-800/60 border border-slate-700 p-2">
                <div className="text-slate-400">Scheduled</div>
                <div className="text-slate-100 font-semibold">{scheduledHours} h</div>
              </div>
              <div className="rounded-md bg-slate-800/60 border border-slate-700 p-2">
                <div className="text-slate-400">Gap</div>
                <div className="text-slate-100 font-semibold">{Math.max(0, availableHours - scheduledHours)} h</div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Today mini-bars */}
      <div className="mt-3">
        <div className="text-xs text-slate-400 mb-1">Today</div>
        <div className="grid grid-cols-2 gap-2">
          {todayBars.map(({ skill, a, s, pct }) => (
            <div key={skill} className="rounded-md border border-slate-800 bg-slate-900/50 p-2">
              <div className="text-[11px] text-slate-300 mb-1">{skill}</div>
              <div className="h-3 bg-slate-800 rounded overflow-hidden">
                <div className="h-3 bg-sky-600" style={{ width: `${pct}%` }} />
              </div>
              <div className="mt-1 text-[11px] text-slate-400">{s} / {a} h</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
