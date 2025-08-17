import React, { useMemo } from 'react';
import { getDemandHistory } from '../data/adapter';
import type { DemandRecord } from '../types';

// Local date only for label formatting
function parseLocalDateOnly(iso?: string) {
  if (!iso) return null;
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const [, y, mo, d] = m;
  const dt = new Date(Number(y), Number(mo) - 1, Number(d), 0, 0, 0, 0);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

export default function DemandSummary() {
  const horizon = 7;
  const raw: DemandRecord[] = useMemo(() => (getDemandHistory?.(horizon) ?? []), [horizon]);

  // Aggregate total hours by date string (YYYY-MM-DD)
  const byDate = new Map<string, number>();
  for (const r of raw) {
    const d = String((r as any).date ?? '').slice(0, 10);
    if (!d) continue;
    byDate.set(d, (byDate.get(d) ?? 0) + Number((r as any).operatingHours ?? (r as any).hours ?? 0));
  }

  // Sorted arrays for charting
  const days = Array.from(byDate.entries()).sort(([a], [b]) => a.localeCompare(b));
  const labels = days.map(([d]) => {
    const dt = parseLocalDateOnly(d) ?? new Date(`${d}T00:00:00`);
    const wd = dt.toLocaleDateString(undefined, { weekday: 'short' }); // Mon
    const dd = String(dt.getDate()).padStart(2, '0');                  // 22
    const mon = dt.toLocaleDateString(undefined, { month: 'short' });  // Aug
    return `${wd}, ${dd} ${mon}`;
  });
  const values = days.map(([, h]) => h);
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

      {/* Visible day labels under bars (Mon, 22 Aug) */}
      <div className="grid grid-cols-7 gap-1 mt-1 mb-2">
        {labels.map((lab, i) => (
          <div key={i} className="text-[11px] text-slate-400 text-center truncate">{lab}</div>
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
