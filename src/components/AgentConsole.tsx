// src/components/AgentConsole.tsx
import { useEffect, useRef, useState } from 'react';
import type { SchedulerPolicy, ReportQuery, QATurn, AgentDecision } from '../types';

type Msg = { role: 'user' | 'assistant'; text: string };

export default function AgentConsole(props: {
  title: string;
  hasPreview: boolean;
  onSuggest: (policy?: SchedulerPolicy) => Promise<{ moved: number; scheduled: number; unscheduled: number; notes: string[] }>;
  onAccept: () => void;
  onReject: () => void;
  onReport: (q: ReportQuery) => Promise<string>;
  onDecide: (text: string, history: QATurn[]) => Promise<AgentDecision>;
  helloMessage?: string;
  helloNonce?: number;
}) {
  const { title, hasPreview, onSuggest, onAccept, onReject, onReport, onDecide, helloMessage, helloNonce } = props;

  const [msgs, setMsgs] = useState<Msg[]>([
    { role: 'assistant', text: `Hi, I’m your ${title}. Ask me to suggest plans, report status, or answer free-form questions.` }
  ]);
  const [qa, setQa] = useState<QATurn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const lastHello = useRef<number | undefined>(undefined);

  const push = (m: Msg) => setMsgs(prev => [...prev, m]);
  const scroll = () => setTimeout(() => scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' }), 0);

  useEffect(() => {
    if (helloMessage && helloNonce && helloNonce !== lastHello.current) {
      push({ role: 'assistant', text: helloMessage });
      lastHello.current = helloNonce;
      scroll();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [helloMessage, helloNonce]);

  useEffect(() => {
    setMsgs([{ role: 'assistant', text: `Hi, I’m your ${title}. Ask me to suggest plans, report status, or answer free-form questions.` }]);
    setQa([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title]);

  const handle = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    push({ role: 'user', text }); scroll();
    setBusy(true);

    try {
      const decision = await onDecide(text, qa.slice(-6));

      switch (decision.intent) {
        case 'SUGGEST': {
          const res = await onSuggest(decision.policy);
          push({
            role: 'assistant',
            text:
              (decision.answer ? decision.answer + '\n\n' : '') +
              `Proposed: ${res.moved} moved, ${res.scheduled} scheduled, ${res.unscheduled} couldn’t be placed.\nSay “accept” to apply or “reject” to discard.`
          });
          break;
        }
        case 'ACCEPT': {
          if (!hasPreview) push({ role: 'assistant', text: 'No pending proposal to accept. Try “suggest a new schedule” first.' });
          else { onAccept(); push({ role: 'assistant', text: 'Applied. Gantt updated.' }); }
          break;
        }
        case 'REJECT': {
          if (!hasPreview) push({ role: 'assistant', text: 'No pending proposal to reject. Try “suggest a new schedule” first.' });
          else { onReject(); push({ role: 'assistant', text: 'Discarded the proposal.' }); }
          break;
        }
        case 'REPORT': {
          const reply = await onReport(decision.report ?? { kind: 'SUMMARY' });
          push({ role: 'assistant', text: reply });
          break;
        }
        default: {
          const reply = decision.answer ?? 'I could not derive an answer.';
          push({ role: 'assistant', text: reply });
          setQa(prev => [...prev, { role: 'user' as const, text }, { role: 'assistant' as const, text: reply }].slice(-8));
        }
      }
    } finally {
      setBusy(false); scroll();
    }
  };

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/70">
      <div className="p-3 flex items-center justify-between">
        <div>
          <div className="text-sm text-slate-100 font-semibold">{title}</div>
          <div className="text-xs text-slate-400">LLM-first chat with full context.</div>
        </div>
      </div>

      <div ref={scroller} className="px-3 pb-2 max-h-60 overflow-auto space-y-2">
        {msgs.map((m, i) => (
          <div key={i} className={`text-sm ${m.role === 'assistant' ? 'text-slate-200' : 'text-sky-200'}`}>
            <span className={`px-2 py-1 rounded-md inline-block whitespace-pre-line ${
              m.role === 'assistant' ? 'bg-slate-800/80' : 'bg-sky-900/40'
            }`}>{m.text}</span>
          </div>
        ))}
      </div>

      <div className="p-2 border-t border-slate-800 flex items-center gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handle(); } }}
          placeholder={`Ask the ${title}…`}
          className="flex-1 bg-slate-950/60 border border-slate-800 rounded-md px-3 py-2 text-sm text-slate-200 outline-none focus:border-sky-600"
        />
        <button onClick={handle} disabled={busy} className="px-3 py-2 rounded-md text-sm bg-sky-600 hover:bg-sky-500 text-white disabled:opacity-50">
          Send
        </button>
      </div>
    </div>
  );
}
