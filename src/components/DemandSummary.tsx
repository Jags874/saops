import React, { useMemo } from 'react';
import { getDemandHistory } from '../data/adapter';
import type { DemandRecord } from '../types';

// Fixed week labels anchored to 22 Aug 2025 for consistent display
const WEEK_START = new Date('2025-08-23T00:00:00');

function ymd(d: Date) { return d.toISOString().slice(0, 10); }
function addDays(d: Date, n: number) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function shortLabel(d: Date) {
  const w = d.toLocaleDateString(undefined, { weekday: 'short' });
  const m = d.toLocaleDateString(undefined, { month: 'short' });
  const day = d.toLocaleDateString(undefined, { day: '2-digit' });
  return `${w}, ${day} ${m}`;
}

export default function DemandSummary() {
  const horizon = 7;

  // Demand records (hours per day)
  const raw: DemandRecord[] = useMemo(() => (getDemandHistory?.(horizon) ?? []), [horizon]);

  // Build fixed week day keys and pretty labels
  const dayKeys = useMemo(() => {
    return Array.from({ length: horizon }, (_, i) => ymd(addDays(WEEK_START, i)));
  }, [horizon]);
  const pretty = useMemo(() => dayKeys.map(d => shortLabel(new Date(`${d}T00:00:00`))), [dayKeys]);

  // Aggregate into the fixed keys so ordering and labels are stable
  const byDate = new Map<string, number>(dayKeys.map(k => [k, 0]));
  for (const r of raw) {
    const d = (r.date ?? '').slice(0, 10);
    if (!d) continue;
    if (!byDate.has(d)) continue;
    byDate.set(d, (byDate.get(d) ?? 0) + (r.hours ?? 0));
  }

  // Sorted arrays for charting (already ordered)
  const labels = pretty;
  const values = dayKeys.map(k => byDate.get(k) ?? 0);
  const total = values.reduce((a, b) => a + b, 0);
  const avgPerDay = values.length ? Math.round((total / values.length) * 10) / 10 : 0;
  const peak = values.length ? Math.max(...values) : 0;
  const max = Math.max(1, peak);

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <div className="text-slate-100 text-sm font-semibold">Fleet Utilisation (next {horizon} days)</div>
      <div className="text-xs text-slate-400 mb-2">Operational demand hours from transport tasks</div>

      <div className="flex items-end gap-1 h-24 mb-1">
        {values.map((v, i) => (
          <div
            key={i}
            className="flex-1 bg-slate-800 rounded-sm"
            style={{ height: `${(v / max) * 100}%` }}
            title={`${labels[i]} — ${v}h`}
          />
        ))}
      </div>

      {/* Day labels under the bars */}
      <div className="grid grid-cols-7 gap-1 mt-1 mb-3">
        {labels.map((txt, i) => (
          <div key={i} className="text-[10px] text-slate-400 text-center truncate" title={txt}>
            {txt}
          </div>
        ))}
      </div>

      {/* Keep it lightweight — no extra summary cards (you asked to reduce duplicate cards) */}
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
