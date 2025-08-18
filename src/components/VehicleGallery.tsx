// src/components/VehicleGallery.tsx
import React from 'react';
import type { Vehicle } from '../types';

export default function VehicleGallery({
  vehicles,
  selectedId,
  onSelect,
}: {
  vehicles: Vehicle[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const statusBg = (v: Vehicle) =>
    v.status === 'AVAILABLE'
      ? 'bg-emerald-900/40 ring-emerald-700/40'
      : v.status === 'DUE'
      ? 'bg-amber-900/40 ring-amber-700/40'
      : 'bg-rose-900/40 ring-rose-700/40';

  const statusDot = (v: Vehicle) =>
    v.status === 'AVAILABLE'
      ? 'bg-emerald-500'
      : v.status === 'DUE'
      ? 'bg-amber-400'
      : 'bg-rose-500';

  const fallback = '/assets/prime-mover.png'; // make sure this exists

  return (
    <div className="space-y-2">
      <div className="text-slate-100 text-sm font-semibold">Fleet Assets</div>
      <div className="grid grid-cols-2 gap-2">
        {vehicles.map((v) => {
          const active = selectedId === v.id;
          return (
            <button
              key={v.id}
              onClick={() => onSelect(active ? null : v.id)}
              className={[
                'w-full rounded-xl border p-2 text-left transition ring-1',
                statusBg(v),
                active ? 'border-sky-500 ring-sky-700/40' : 'border-slate-800',
              ].join(' ')}
              title={`${v.id} — ${v.status}`}
            >
              <div className="flex items-start gap-2">
                <div className={`h-2 w-2 rounded-full mt-1 ${statusDot(v)}`} />
                <div className="flex-1">
                  <div className="text-xs text-slate-200 font-medium">{v.id}</div>
                  <div className="text-[10px] text-slate-400">
                    {v.model ?? 'Prime Mover'} {v.year ? `• ${v.year}` : ''}
                  </div>
                </div>
              </div>

              <div className="mt-2 rounded-lg bg-slate-950/40 flex items-center justify-center">
                <img
                  src={v.photoUrl || fallback}
                  alt={v.id}
                  className="h-16 md:h-20 object-contain p-2"
                  loading="lazy"
                />
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
