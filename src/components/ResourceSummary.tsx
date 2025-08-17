// src/components/ResourceSummary.tsx
import React, { useMemo } from 'react';
import { getWorkOrders } from '../data/adapter';
import { getResourceSnapshot } from '../data/resourceStore';
import type { Skill, WorkOrder } from '../types';
import { demoNow, startOfDay, addDays } from '../utils/demoClock';


const SKILLS: Skill[] = ['Mechanic', 'AutoElec'];

function ymd(d: Date) { return d.toISOString().slice(0, 10); }
function atStartOfDay(d: Date) { const x = new Date(d); x.setHours(0,0,0,0); return x; }
function hoursBetween(a: Date, b: Date) { return Math.max(0, (b.getTime() - a.getTime()) / 36e5); }

export default function ResourceSummary() {
  const horizon = 7;

  // Build day list (YYYY-MM-DD)
  const days = useMemo(() => {
  const start = startOfDay(demoNow());
  return Array.from({ length: horizon }, (_, i) => ymd(addDays(start, i)));
}, [horizon]);


  // Pull current snapshot and work orders
  const { technicians, availability } = getResourceSnapshot();
  const workorders: WorkOrder[] = useMemo(() => (getWorkOrders?.() ?? []), []);

  // Availability per day+skill
  const availByDaySkill = useMemo(() => {
    const map = new Map<string, Map<Skill, number>>();
    for (const day of days) map.set(day, new Map<Skill, number>(SKILLS.map(s => [s, 0])));

    // Each availability slot contributes its hours to ALL skills of that tech (usually one)
    const techSkills = new Map<string, Skill[]>();
    for (const t of technicians ?? []) techSkills.set(t.id, (t.skills?.length ? t.skills : ['Mechanic']) as Skill[]);

    for (const slot of availability ?? []) {
      if (!map.has(slot.date)) continue;
      const skills = techSkills.get(slot.technicianId) ?? (['Mechanic'] as Skill[]);
      const dayMap = map.get(slot.date)!;
      for (const s of skills) {
        dayMap.set(s, (dayMap.get(s)! + Number(slot.hours ?? 0)));
      }
    }
    return map;
  }, [technicians, availability, days]);

  // Scheduled maintenance hours per day+skill
  const schedByDaySkill = useMemo(() => {
    const map = new Map<string, Map<Skill, number>>();
    for (const day of days) map.set(day, new Map<Skill, number>(SKILLS.map(s => [s, 0])));

    const startOf = (day: string) => new Date(`${day}T00:00:00`);
    const endOf   = (day: string) => new Date(`${day}T23:59:59`);

    for (const w of workorders) {
      if (!(w.status === 'Scheduled' || w.status === 'In Progress')) continue;
      if (!w.start || !w.end) continue;

      const s = new Date(w.start);
      const e = new Date(w.end);
      if (isNaN(s.getTime()) || isNaN(e.getTime())) continue;

      // Allocate to requiredSkills (fallback to Mechanic unless electrical)
      const skills: Skill[] =
        (w.requiredSkills && w.requiredSkills.length ? w.requiredSkills :
          (w.subsystem === 'electrical' ? ['AutoElec'] : ['Mechanic'])) as Skill[];

      // Attribute the WO's hours to the day containing its start time
      const day = ymd(atStartOfDay(s));
      if (!map.has(day)) continue;

      const dur = w.hours ?? hoursBetween(s, e);
      const per = dur / skills.length;
      const dayMap = map.get(day)!;
      for (const k of skills) {
        dayMap.set(k, (dayMap.get(k)! + per));
      }
    }
    return map;
  }, [workorders, days]);

  // Roll up totals & simple cards
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

  // Simple bar heights for today
  const today = days[0];
  const todayBars = SKILLS.map((skill) => {
    const a = availByDaySkill.get(today)!.get(skill)!;
    const s = schedByDaySkill.get(today)!.get(skill)!;
    const pct = a > 0 ? Math.min(100, Math.round((s / a) * 100)) : 0;
    return { skill, a, s, pct };
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

      {/* Tiny “today” bars */}
      <div className="mt-3">
        <div className="text-xs text-slate-400 mb-1">Today</div>
        <div className="grid grid-cols-2 gap-2">
          {todayBars.map(({ skill, a, s, pct }) => (
            <div key={skill} className="rounded-md border border-slate-800 bg-slate-900/50 p-2">
              <div className="text-[11px] text-slate-300 mb-1">{skill}</div>
              <div className="h-3 bg-slate-800 rounded overflow-hidden">
                <div className="h-3 bg-sky-600" style={{ width: `${Math.min(100, pct)}%` }} />
              </div>
              <div className="mt-1 text-[11px] text-slate-400">{s} / {a} h</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
