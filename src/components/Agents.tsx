// src/components/Agents.tsx
import React from 'react';

export type AgentKey = 'scheduler' | 'reliability' | 'parts';

export default function Agents(props: {
  vehiclesClear: number;
  vehiclesDue: number;
  vehiclesDown: number;
  woOutstanding: number;
  active: AgentKey;
  onSelect: (agent: AgentKey) => void;
  onHello: (agent: AgentKey) => void;
}) {
  const { vehiclesClear, vehiclesDue, vehiclesDown, woOutstanding, active, onSelect, onHello } = props;

  const Card = ({ agent, title, desc }: { agent: AgentKey; title: string; desc: string }) => {
    const isActive = active === agent;
    return (
      <div className={`rounded-xl border ${isActive ? 'border-sky-600' : 'border-slate-800'} bg-slate-900/60 p-4 flex flex-col gap-2`}>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-slate-100 font-semibold text-sm">{title}</div>
            <div className="text-xs text-slate-400">{desc}</div>
          </div>
          {isActive && <span className="text-[10px] px-2 py-0.5 rounded bg-sky-700 text-white">Active</span>}
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => { onSelect(agent); onHello(agent); }}
            className="px-2.5 py-1.5 rounded-md text-xs bg-violet-600 hover:bg-violet-500 text-white"
          >
            Hello {title}
          </button>
          <button
            onClick={() => onSelect(agent)}
            className="px-2.5 py-1.5 rounded-md text-xs bg-slate-800 hover:bg-slate-700 text-slate-100"
          >
            Make Active
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
      <Card agent="scheduler" title="Scheduler Agent" desc="Balance demand vs maintenance with constraints." />
      <Card agent="reliability" title="Reliability Agent" desc="Trends, repeated failures, RCM insights." />
      <Card agent="parts" title="Parts Interpreter" desc="Map vague faults to subsystems & parts." />

      <div className="md:col-span-2 xl:col-span-3 grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Vehicles OK" value={vehiclesClear} />
        <Stat label="Maintenance Due" value={vehiclesDue} />
        <Stat label="Down / Workshop" value={vehiclesDown} />
        <Stat label="Outstanding WOs" value={woOutstanding} />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-3">
      <div className="text-xs text-slate-400">{label}</div>
      <div className="text-lg text-slate-100 font-semibold">{value}</div>
    </div>
  );
}
