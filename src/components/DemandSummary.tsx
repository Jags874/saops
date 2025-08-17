// src/components/DemandSummary.tsx
import React, { useMemo } from 'react';
import { getDemandHistory } from '../data/adapter';
import type { DemandRecord } from '../types';

export default function DemandSummary() {
  const horizon = 7;
  const raw: DemandRecord[] = useMemo(() => (getDemandHistory?.(horizon) ?? []), [horizon]);

  // Aggregate demand hours by date (YYYY-MM-DD)
  const byDate = new Map<string, number>();
  for (const r of raw) {
    const d = (r.date ?? '').slice(0, 10);
    if (!d) continue;
    byDate.set(d, (byDate.get(d) ?? 0) + (r.hours ?? 0));
  }

  // Sorted arrays for charting
  const days = Array.from(byDate.entries()).sort(([a], [b]) => a.localeCompare(b));
  const labels = days.map(([d]) => d.slice(5)); // MM-DD
  const values = days.map(([, h]) => h);
  const total = values.reduce((a, b) => a + b, 0);
  const avgPerDay = values.length ? Math.round((total / values.length) * 10) / 10 : 0;
  const peak = values.length ? Math.max(...values) : 0;
  const max = Math.max(1, peak);

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <div className="text-slate-100 text-sm font-semibold">Fleet Utilisation (next {horizon} days)</div>
      <div className="text-xs text-slate-400 mb-2">Operational demand hours from transport tasks</div>

      <div className="flex items-end gap-1 h-24 mb-2">
        {values.map((v, i) => (
          <div
            key={i}
            className="flex-1 bg-slate-800 rounded-sm"
            style={{ height: `${(v / max) * 100}%` }}
            title={`${labels[i]} — ${v}h`}
          />
        ))}
      </div>

      <div className="grid grid-cols-3 gap-2 text-xs">
        <div className="rounded-md bg-slate-800/60 border border-slate-700 p-2">
          <div className="text-slate-400">Total Demand</div>
          <div className="text-slate-100 font-semibold">{total} h</div>
        </div>
        <div className="rounded-md bg-slate-800/60 border border-slate-700 p-2">
          <div className="text-slate-400">Avg / Day</div>
          <div className="text-slate-100 font-semibold">{avgPerDay} h</div>
        </div>
        <div className="rounded-md bg-slate-800/60 border border-slate-700 p-2">
          <div className="text-slate-400">Peak Day</div>
          <div className="text-slate-100 font-semibold">{peak} h</div>
        </div>
      </div>
    </div>
  );
}
