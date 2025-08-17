// src/components/GanttWeek.tsx
import React, { useMemo } from 'react';
import type { Vehicle, WorkOrder, OpsTask } from '../types';
import { getFailures } from '../data/adapter';
import { demoNow, addDays } from '../utils/demoClock';

export default function GanttWeek({
  vehicles,
  workorders,
  opsTasks,
  onTaskClick,
}: {
  vehicles: Vehicle[];
  workorders: WorkOrder[];
  opsTasks: OpsTask[];
  onTaskClick: (woId: string) => void;
}) {
  // Timeline bounds: today 00:00 → +7 days
  const t0 = useMemo(() => {
  return demoNow(); // already normalized to midnight
}, []);
  const t1 = useMemo(() => addDays(t0, 7), [t0]);

  const spanMs = t1.getTime() - t0.getTime();

  // Day labels
  const days = useMemo(() => {
    return Array.from({ length: 7 }).map((_, i) => {
      const d = new Date(t0);
      d.setDate(d.getDate() + i);
      return d;
    });
  }, [t0]);

  // Last-30-days failures per vehicle (for the small badge)
  const last30ByVehicle = useMemo(() => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const byV = new Map<string, number>();
    const failures = (getFailures?.() ?? []);
    for (const f of failures) {
      const vid = String((f as any).vehicleId ?? (f as any).asset_id ?? '');
      const dt = new Date((f as any).date ?? (f as any).failure_date ?? new Date().toISOString());
      if (!vid) continue;
      if (dt >= cutoff) byV.set(vid, (byV.get(vid) ?? 0) + 1);
    }
    return byV;
  }, []);

  // Only render items that intersect the 7-day window
  function clampInterval(startISO?: string, endISO?: string) {
    if (!startISO || !endISO) return null;
    const s = new Date(startISO);
    const e = new Date(endISO);
    if (isNaN(s.getTime()) || isNaN(e.getTime())) return null;
    if (e <= t0 || s >= t1) return null;
    const ss = new Date(Math.max(s.getTime(), t0.getTime()));
    const ee = new Date(Math.min(e.getTime(), t1.getTime()));
    return { s: ss, e: ee };
  }

  function pctLeftWidth(s: Date, e: Date) {
    const left = ((s.getTime() - t0.getTime()) / spanMs) * 100;
    const width = ((e.getTime() - s.getTime()) / spanMs) * 100;
    return { left: Math.max(0, Math.min(100, left)), width: Math.max(0.5, Math.min(100, width)) };
  }

  // Simple color helpers
  const statusPill = (v: Vehicle) => {
    const base = 'text-[10px] px-1.5 py-0.5 rounded border';
    if (v.status === 'AVAILABLE') return `${base} bg-emerald-600/20 text-emerald-300 border-emerald-700/40`;
    if (v.status === 'DUE') return `${base} bg-amber-600/20 text-amber-200 border-amber-700/40`;
    return `${base} bg-rose-600/20 text-rose-200 border-rose-700/40`; // DOWN
  };

// Replace your existing woColor with this:
const woColor = (w: WorkOrder) => {
  switch (w.priority) {
    case 'Critical':
    case 'High':
      return 'bg-rose-600/80 hover:bg-rose-500';    // red
    case 'Medium':
      return 'bg-amber-500/80 hover:bg-amber-400';  // amber
    case 'Low':
    default:
      return 'bg-emerald-600/80 hover:bg-emerald-500'; // green
  }
};


  const opsColor = 'bg-sky-700/50';

  return (
    <div className="rounded-2xl border border-slate-800 overflow-hidden">
      {/* Header */}
      <div className="grid grid-cols-[12rem_1fr] bg-slate-900/70 border-b border-slate-800">
        <div className="px-3 py-2 text-xs text-slate-400">Vehicles (last 30d failures)</div>
        <div className="grid grid-cols-7 divide-x divide-slate-800">
          {days.map((d, i) => (
            <div key={i} className="px-2 py-2 text-xs text-slate-300">
              {d.toLocaleDateString(undefined, { weekday: 'short' })}{' '}
              <span className="text-slate-500">{d.toLocaleDateString(undefined, { month: '2-digit', day: '2-digit' })}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Rows */}
      <div className="divide-y divide-slate-800">
        {vehicles.map((v) => {
          const failures = last30ByVehicle.get(v.id) ?? 0;

          // Row containers
          return (
            <div key={v.id} className="grid grid-cols-[12rem_1fr] bg-slate-950/40">
              {/* Left: vehicle label */}
              <div className="px-3 py-2 flex items-center gap-2">
                <div className="text-slate-200 text-sm font-medium">{v.id}</div>
                <span className={statusPill(v)}>{v.status}</span>
                {failures > 0 && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-600/20 text-rose-200 border border-rose-700/50">
                    {failures} fail
                  </span>
                )}
              </div>

              {/* Right: timeline lane */}
              <div className="relative">
                {/* Day separators */}
                <div className="grid grid-cols-7 h-14">
                  {days.map((_, i) => (
                    <div key={i} className="border-l border-slate-800/70 h-full" />
                  ))}
                </div>

                {/* Ops tasks (underlay) */}
                {(opsTasks ?? [])
                  .filter((t) => t.vehicleId === v.id)
                  .map((t) => {
                    const iv = clampInterval(t.start, t.end);
                    if (!iv) return null;
                    const { left, width } = pctLeftWidth(iv.s, iv.e);
                    return (
                      <div
                        key={t.id}
                        title={`${t.title}\n${iv.s.toLocaleString()} → ${iv.e.toLocaleString()}`}
                        className={`absolute top-1 h-3 rounded-sm ${opsColor}`}
                        style={{ left: `${left}%`, width: `${width}%` }}
                      />
                    );
                  })}

                {/* Maintenance tasks (overlay) */}
                {(workorders ?? [])
                  .filter((w) => w.vehicleId === v.id && w.start && w.end && w.status !== 'Closed')
                  .map((w) => {
                    const iv = clampInterval(w.start, w.end);
                    if (!iv) return null;
                    const { left, width } = pctLeftWidth(iv.s, iv.e);
                    return (
                      <button
                        key={w.id}
                        onClick={() => onTaskClick(w.id)}
                        title={`${w.id} — ${w.title}\n${iv.s.toLocaleString()} → ${iv.e.toLocaleString()}\n${w.type} • ${w.priority} • ${w.status}`}
                        className={`absolute bottom-1 h-4 rounded-sm ${woColor(w)} text-[10px] text-white/90 px-1 overflow-hidden`}
                        style={{ left: `${left}%`, width: `${width}%` }}
                      >
                        {w.id}
                      </button>
                    );
                  })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
