// src/components/GanttWeek.tsx
import React, { useMemo, useState } from 'react';
import type { Vehicle, WorkOrder, OpsTask } from '../types';
import { getFailures } from '../data/adapter';

// Static demo window: start on 22 Aug 2025
const T0 = new Date('2025-08-22T00:00:00');
const DAYS = 7;

export default function GanttWeek({
  vehicles,
  workorders,
  opsTasks,
}: {
  vehicles: Vehicle[];
  workorders: WorkOrder[];
  opsTasks: OpsTask[];
}) {
  const t0 = T0;
  const t1 = useMemo(() => {
    const x = new Date(t0); x.setDate(x.getDate() + DAYS); return x;
  }, []);

  const spanMs = t1.getTime() - t0.getTime();

  const days = useMemo(() => {
    return Array.from({ length: DAYS }).map((_, i) => {
      const d = new Date(t0);
      d.setDate(d.getDate() + i);
      return d;
    });
  }, []);

  // last-30d failures per vehicle
  const last30ByVehicle = useMemo(() => {
    const cutoff = new Date(t0); cutoff.setDate(cutoff.getDate() - 30);
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

  // Helpers
  function clampInterval(startISO?: string, endISO?: string) {
    if (!startISO || !endISO) return null;
    const s = new Date(startISO); const e = new Date(endISO);
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

  const statusPill = (v: Vehicle) => {
    const base = 'text-[10px] px-1.5 py-0.5 rounded border';
    if (v.status === 'AVAILABLE') return `${base} bg-emerald-600/20 text-emerald-300 border-emerald-700/40`;
    if (v.status === 'DUE') return `${base} bg-amber-600/20 text-amber-200 border-amber-700/40`;
    return `${base} bg-rose-600/20 text-rose-200 border-rose-700/40`;
  };
  const woColor = (w: WorkOrder) => {
    switch (w.priority) {
      case 'Critical':
      case 'High': return 'bg-rose-600/80 hover:bg-rose-500';
      case 'Medium': return 'bg-amber-500/80 hover:bg-amber-400';
      case 'Low':
      default: return 'bg-emerald-600/80 hover:bg-emerald-500';
    }
  };
  const opsColor = 'bg-sky-700/50';

  // Work-order detail popover state (local to Gantt)
  const [detailId, setDetailId] = useState<string | null>(null);

  const detailWO = useMemo(() => (workorders ?? []).find(w => w.id === detailId) || null, [workorders, detailId]);

  function closeDetail() { setDetailId(null); }

  return (
    <div className="rounded-2xl border border-slate-800 overflow-hidden">
      {/* Header */}
      <div className="grid grid-cols-[12rem_1fr] bg-slate-900/70 border-b border-slate-800">
        <div className="px-3 py-2 text-xs text-slate-400">Vehicles (last 30d failures)</div>
        <div className="grid grid-cols-7 divide-x divide-slate-800">
          {days.map((d, i) => (
            <div key={i} className="px-2 py-2 text-xs text-slate-300">
              {d.toLocaleDateString(undefined, { weekday: 'short' })}{' '}
              <span className="text-slate-500">
                {d.toLocaleDateString(undefined, { month: 'short', day: '2-digit' })}
              </span>
            </div>
          ))}
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
                <div className="text-slate-200 text-sm font-medium">{v.id}</div>
                <span className={statusPill(v)}>{v.status}</span>
                {failures > 0 && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-600/20 text-rose-200 border border-rose-700/50">
                    {failures} fail
                  </span>
                )}
              </div>

              {/* Right: lane */}
              <div className="relative">
                {/* day separators */}
                <div className="grid grid-cols-7 h-16">
                  {days.map((_, i) => (
                    <div key={i} className="border-l border-slate-800/70 h-full" />
                  ))}
                </div>

                {/* ops tasks underlay */}
                {(opsTasks ?? [])
                  .filter(t => t.vehicleId === v.id)
                  .map(t => {
                    const iv = clampInterval(t.start, t.end);
                    if (!iv) return null;
                    const { left, width } = pctLeftWidth(iv.s, iv.e);
                    return (
                      <div
                        key={t.id}
                        title={`Ops ${t.id}\n${t.title}\n${iv.s.toLocaleString()} → ${iv.e.toLocaleString()}`}
                        className={`absolute top-1 h-3 rounded-sm ${opsColor}`}
                        style={{ left: `${left}%`, width: `${width}%` }}
                      />
                    );
                  })}

                {/* maintenance overlay */}
                {(workorders ?? [])
                  .filter(w => w.vehicleId === v.id && w.start && w.end && w.status !== 'Closed')
                  .map(w => {
                    const iv = clampInterval(w.start, w.end);
                    if (!iv) return null;
                    const { left, width } = pctLeftWidth(iv.s, iv.e);
                    return (
                      <button
                        key={w.id}
                        onClick={() => setDetailId(w.id)}
                        title={`${w.id} — ${w.title}\n${iv.s.toLocaleString()} → ${iv.e.toLocaleString()}\n${w.type} • ${w.priority} • ${w.status}`}
                        className={`absolute bottom-1 h-4 rounded-sm ${woColor(w)} text-[10px] text-white/90 px-1 overflow-hidden`}
                        style={{ left: `${left}%`, width: `${width}%` }}
                      >
                        {w.id}
                      </button>
                    );
                  })}

                {/* detail popover (if any) */}
                {detailWO && (
                  <div className="absolute right-2 bottom-6 z-10 w-[22rem] rounded-xl border border-slate-700 bg-slate-900/95 shadow-xl p-3 text-xs text-slate-200">
                    <div className="flex items-center justify-between">
                      <div className="font-semibold text-slate-100">{detailWO.id} — {detailWO.title}</div>
                      <button onClick={closeDetail} className="text-slate-400 hover:text-slate-200">×</button>
                    </div>
                    <div className="mt-1 text-slate-300">{detailWO.type} • {detailWO.priority} • {detailWO.status}</div>
                    <div className="mt-1 text-slate-400">
                      {new Date(detailWO.start!).toLocaleString()} → {new Date(detailWO.end!).toLocaleTimeString()}
                    </div>
                    {/* parts + tools with fallbacks */}
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      <div className="rounded-md border border-slate-700 p-2">
                        <div className="text-[11px] text-slate-400 mb-1">Parts</div>
                        <ul className="list-disc ml-4">
                          {((detailWO as any).requiredParts
                            ?? (detailWO as any).parts
                            ?? (detailWO as any).requiredResources?.parts
                            ?? []).slice(0,6).map((p: any, i: number) => (
                              <li key={i}>{typeof p === 'string' ? p : (p?.name || p?.part || JSON.stringify(p))}</li>
                          ))}
                          {(((detailWO as any).requiredParts ?? (detailWO as any).requiredResources?.parts ?? []).length === 0) && (
                            <li className="text-slate-500">—</li>
                          )}
                        </ul>
                      </div>
                      <div className="rounded-md border border-slate-700 p-2">
                        <div className="text-[11px] text-slate-400 mb-1">Tools</div>
                        <ul className="list-disc ml-4">
                          {((detailWO as any).requiredTools
                            ?? (detailWO as any).tools
                            ?? (detailWO as any).requiredResources?.tools
                            ?? []).slice(0,6).map((p: any, i: number) => (
                              <li key={i}>{typeof p === 'string' ? p : (p?.name || JSON.stringify(p))}</li>
                          ))}
                          {(((detailWO as any).requiredTools ?? (detailWO as any).requiredResources?.tools ?? []).length === 0) && (
                            <li className="text-slate-500">—</li>
                          )}
                        </ul>
                      </div>
                    </div>
                    {detailWO.description && (
                      <div className="mt-2 text-slate-300">{detailWO.description}</div>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
