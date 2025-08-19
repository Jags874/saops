import React from 'react';
import type { AgentKey } from '../types';

export default function Agents({
  vehiclesClear,     // kept for prop compatibility (not rendered)
  vehiclesDue,       // kept for prop compatibility (not rendered)
  vehiclesDown,      // kept for prop compatibility (not rendered)
  woOutstanding,     // kept for prop compatibility (not rendered)
  active,
  onSelect,
  onHello,
}: {
  vehiclesClear: number;
  vehiclesDue: number;
  vehiclesDown: number;
  woOutstanding: number;
  active: AgentKey;
  onSelect: (a: AgentKey) => void;
  onHello: (a: AgentKey) => void;
}) {
  const card = (
    key: AgentKey,
    title: string,
    subtitle: string,
    emoji: string
  ) => (
    <div
      key={key}
      className={[
        'rounded-xl border p-4 bg-slate-900/60 transition cursor-pointer',
        'border-slate-800 hover:bg-slate-900',
        active === key ? 'ring-2 ring-sky-500' : ''
      ].join(' ')}
      onClick={() => onSelect(key)}
      role="button"
      aria-pressed={active === key}
      tabIndex={0}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-slate-100 text-sm font-semibold">{title}</div>
          <div className="text-xs text-slate-400">{subtitle}</div>
        </div>
        <div className="text-xl">{emoji}</div>
      </div>
      <div className="mt-3">
        <button
          className="text-xs px-2 py-1 rounded-md border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200"
          onClick={(e) => { e.stopPropagation(); onHello(key); }}
        >
          Hello {title.split(' ')[0]} Agent
        </button>
      </div>
    </div>
  );

  return (
    <section className="grid grid-cols-1 md:grid-cols-3 gap-3">
      {card('scheduler', 'Scheduler Agent', 'Plan & re-plan under constraints', '🗓️')}
      {card('reliability', 'Reliability Agent', 'Trends, failure modes, RCM hints', '📈')}
      {card('parts', 'Parts Interpreter', 'Map symptoms → likely parts', '🧩')}
    </section>
  );
}
