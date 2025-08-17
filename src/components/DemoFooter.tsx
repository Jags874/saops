// src/components/DemoFooter.tsx
import React from 'react';
import { demoNow, ymd } from '../utils/demoClock';

export default function DemoFooter() {
  const date = ymd(demoNow());
  const repo = (import.meta.env.VITE_REPO_URL as string | undefined) || '';

  return (
    <div className="fixed bottom-2 right-2 z-50">
      <div className="rounded-lg border border-slate-800 bg-slate-900/80 backdrop-blur px-3 py-2 flex items-center gap-3 text-xs text-slate-300 shadow-lg">
        <div>
          <span className="text-slate-500">Demo date:</span>{' '}
          <span className="text-slate-100 font-medium">{date}</span>
        </div>
        {repo ? (
          <a
            href={repo}
            target="_blank"
            rel="noreferrer"
            className="px-2 py-1 rounded border border-slate-700 bg-slate-800/70 text-slate-200 hover:bg-slate-700/70"
            title="Open GitHub repo"
          >
            GitHub
          </a>
        ) : null}
      </div>
    </div>
  );
}
