// src/components/WorkOrdersModal.tsx
import React from 'react';
import type { WorkOrder, Priority } from '../types';

export default function WorkOrdersModal({
  open,
  onClose,
  workorders,
}: {
  open: boolean;
  onClose: () => void;
  workorders: WorkOrder[];
}) {
  if (!open) return null;

  const prioClass: Record<Priority, string> = {
    Critical: 'bg-red-600/20 text-red-300 border-red-700/40',
    High:     'bg-orange-600/20 text-orange-200 border-orange-700/40',
    Medium:   'bg-yellow-600/20 text-yellow-200 border-yellow-700/40',
    Low:      'bg-slate-700/30 text-slate-200 border-slate-600/40',
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/50">
      <div className="w-full md:max-w-3xl bg-slate-950 border border-slate-800 rounded-t-2xl md:rounded-2xl p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="text-slate-100 font-semibold">Outstanding Work Orders</div>
          <button onClick={onClose} className="text-slate-300 hover:text-white text-sm">Close</button>
        </div>

        <div className="space-y-2 max-h-[60vh] overflow-auto pr-1">
          {workorders.length === 0 && (
            <div className="text-slate-400 text-sm">Nothing to show.</div>
          )}
          {workorders.map((w) => (
            <div key={w.id} className="rounded-xl border border-slate-800 bg-slate-900/50 p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="text-slate-200 text-sm font-medium">{w.id} — {w.title}</div>
                <span className={`text-[10px] px-2 py-0.5 rounded border ${prioClass[w.priority]}`}>{w.priority}</span>
              </div>
              <div className="mt-1 grid grid-cols-2 md:grid-cols-4 gap-2 text-xs text-slate-300">
                <div><span className="text-slate-500">Type:</span> {w.type}</div>
                <div><span className="text-slate-500">Vehicle:</span> {w.vehicleId}</div>
                <div><span className="text-slate-500">Status:</span> {w.status}</div>
                <div><span className="text-slate-500">Subsystem:</span> {w.subsystem ?? '—'}</div>
                <div><span className="text-slate-500">Hours:</span> {w.hours ?? '—'}</div>
                <div><span className="text-slate-500">Start:</span> {w.start ? new Date(w.start).toLocaleString() : '—'}</div>
                <div><span className="text-slate-500">End:</span> {w.end ? new Date(w.end).toLocaleString() : '—'}</div>
                <div><span className="text-slate-500">Tech:</span> {w.technicianId ?? '—'}</div>
              </div>
              {w.description && <div className="mt-2 text-xs text-slate-300">{w.description}</div>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
