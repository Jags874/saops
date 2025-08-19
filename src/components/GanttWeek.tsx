// src/components/GanttWeek.tsx
import React, { useMemo } from 'react';
import type { Vehicle, WorkOrder, OpsTask } from '../types';
import { WEEK_START as T0, getFailures } from '../data/adapter';

const DAYS = 7;

export default function GanttWeek({
  vehicles,
  workorders,
  opsTasks,
  onTaskClick,
}: {
  vehicles: Vehicle[];
  workorders: WorkOrder[];
  opsTasks: OpsTask[];
  onTaskClick?: (id: string) => void;
}) {
  const last30ByVehicle = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of getFailures()) m.set(f.vehicleId, (m.get(f.vehicleId) ?? 0) + 1);
    return m;
  }, []);

  const days = Array.from({ length: DAYS }, (_, i) => {
    const d = new Date(T0);
    d.setDate(T0.getDate() + i);
    return d;
  });

  function pctLeftWidth(start: Date, end: Date) {
    const span = DAYS * 24 * 60 * 60 * 1000;
    const s0 = +T0;
    const left = Math.max(0, Math.min(1, (+start - s0) / span));
    const right = Math.max(0, Math.min(1, (+end - s0) / span));
    const width = Math.max(0, right - left);
    return { left: left * 100, width: width * 100 };
  }

  function clampInterval(s?: string | Date, e?: string | Date) {
    if (!s || !e) return null;
    const ss = new Date(s), ee = new Date(e);
    if (isNaN(+ss) || isNaN(+ee)) return null;
    const s0 = new Date(T0);
    const e0 = new Date(T0); e0.setDate(T0.getDate() + DAYS);
    const s1 = new Date(Math.max(+ss, +s0));
    const e1 = new Date(Math.min(+ee, +e0));
    if (e1 <= s1) return null;
    return { s: s1, e: e1 };
  }

  const gridCols = 'grid grid-cols-[12rem_1fr]';

  const statusPill = (v: Vehicle) =>
    'text-[10px] px-2 py-[2px] rounded-full ' + (
      v.status === 'AVAILABLE' ? 'bg-emerald-900/40 text-emerald-300 ring-1 ring-emerald-700/40' :
      v.status === 'DUE'       ? 'bg-amber-900/40 text-amber-300 ring-1 ring-amber-700/40' :
                                 'bg-rose-900/40 text-rose-300 ring-1 ring-rose-700/40'
    );

  // OPS look
  const opsClass = 'bg-sky-600/80 hover:bg-sky-500 text-white';

  // WO colour by priority
  const woClass = (priority?: WorkOrder['priority'], closed?: boolean) => {
    if (closed) return 'bg-slate-700/70 text-slate-200 italic line-through';
    switch ((priority ?? 'Medium')) {
      case 'High':   return 'bg-rose-600/85 hover:bg-rose-500 text-white';
      case 'Low':    return 'bg-emerald-600/85 hover:bg-emerald-500 text-white';
      case 'Medium':
      default:       return 'bg-amber-600/85 hover:bg-amber-500 text-white';
    }
  };

  return (
    <div className="rounded-xl border border-slate-800 overflow-hidden">
      {/* Header scale */}
      <div className={`${gridCols} bg-slate-900/60 border-b border-slate-800`}>
        <div className="px-3 py-2 text-xs text-slate-400">Vehicle</div>
        <div className="relative h-9">
          <div className="absolute inset-0">
            {days.map((d, i) => (
              <div key={i}
                   className="absolute top-0 bottom-0 border-l border-slate-800/70 text-[10px] text-slate-300"
                   style={{ left: `${(i / DAYS) * 100}%`, width: `${(1 / DAYS) * 100}%` }}>
                <div className="pl-1 pt-1 font-medium">
                  {d.toLocaleDateString(undefined, { weekday: 'short' })}{' '}
                  {d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Rows */}
      <div className="divide-y divide-slate-800">
        {vehicles.map((v) => {
          const failures = last30ByVehicle.get(v.id) ?? 0;

          return (
            <div key={v.id} className="grid grid-cols-[12rem_1fr] bg-slate-950/40 relative">
              {/* Left: label */}
              <div className="px-3 py-2 flex items-center gap-2">
                <div className="text-slate-200 text-sm font-semibold">{v.id}</div>
                <span className={statusPill(v)}>{v.status}</span>
                {failures > 0 && (
                  <span className="ml-2 text-[10px] px-2 py-[1px] rounded-full bg-slate-800 text-slate-300">
                    {failures} fails/30d
                  </span>
                )}
              </div>

              {/* Right: lane */}
              <div className="relative h-16">
                {/* OPS overlay */}
                {(opsTasks ?? [])
                  .filter(t => t.vehicleId === v.id && t.start && t.end)
                  .map(t => {
                    const iv = clampInterval(t.start, t.end);
                    if (!iv) return null;
                    const { left, width } = pctLeftWidth(iv.s, iv.e);
                    return (
                      <div
                        key={t.id}
                        className={`absolute top-1 h-5 rounded-md shadow-sm ${opsClass} px-2 flex items-center`}
                        style={{ left: `${left}%`, width: `${width}%` }}
                        title={`OPS ${t.id} — ${t.title}\n${iv.s.toLocaleString()} → ${iv.e.toLocaleString()}`}
                      >
                        <div className="truncate text-[11px] leading-none">
                          OPS {t.id} · {t.title}
                        </div>
                      </div>
                    );
                  })}

                {/* Maintenance overlay */}
                {(workorders ?? [])
                  .filter(w => w.vehicleId === v.id && w.start && w.end)
                  .map(w => {
                    const iv = clampInterval(w.start, w.end);
                    if (!iv) return null;
                    const { left, width } = pctLeftWidth(iv.s, iv.e);
                    const closed = w.status === 'Closed';
                    return (
                      <div
                        key={w.id}
                        onClick={() => !closed && onTaskClick?.(w.id)}
                        className={[
                          'absolute top-8 h-6 rounded-md shadow-sm px-2 flex items-center cursor-pointer',
                          woClass(w.priority, closed),
                        ].join(' ')}
                        style={{ left: `${left}%`, width: `${width}%` }}
                        title={`${w.id} — ${w.title}\n${iv.s.toLocaleString()} → ${iv.e.toLocaleString()}`}
                      >
                        <div className="truncate text-[11px] leading-none">
                          {w.id} · {w.title}
                        </div>
                      </div>
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
