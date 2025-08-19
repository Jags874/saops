// src/components/DemoFooter.tsx
import React from 'react';

const WEEK_START = new Date('2025-08-22T00:00:00');

function addDays(d: Date, n: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function fmt(d: Date) {
  // e.g. "Fri, 22 Aug"
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
  });
}

export default function DemoFooter() {
  const start = WEEK_START;
  const end = addDays(start, 6);

  return (
    <footer className="text-[11px] text-slate-400 mt-4">
      <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-2">
        <div>
          Demo window:&nbsp;
          <span className="text-slate-300">{fmt(start)}</span>
          &nbsp;→&nbsp;
          <span className="text-slate-300">{fmt(end)}</span>
        </div>
        <div className="mt-1">
          Tip: ask the Scheduler, Reliability, or Parts agents questions in the console above.
        </div>
      </div>
    </footer>
  );
}
