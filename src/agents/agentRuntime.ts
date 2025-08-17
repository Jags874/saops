// src/agents/agentRuntime.ts
import type {
  SchedulerPolicy, ReportQuery, QATurn, AgentDecision, PlanContext
} from '../types';
import type { KnowledgePack } from './context';

const normalize = (s: string) =>
  s.replace(/\u2018|\u2019|\u201B/g, "'").replace(/\u201C|\u201D/g, '"').replace(/\s+/g, ' ').trim();

function safeSlice<T>(arr: T[] | undefined, n = 60): T[] | undefined {
  if (!arr) return arr;
  return arr.length > n ? arr.slice(0, n) : arr;
}
function parseJSONFrom(text: string): any | null {
  const t = text.trim();
  const fence = t.match(/```json\s*([\s\S]*?)```/i);
  const raw = fence ? fence[1] : t;
  try { return JSON.parse(raw); } catch { return null; }
}

export async function analyzeWithLLM(
  question: string,
  pack: KnowledgePack,
  history: QATurn[] = [],
  plan: PlanContext = {}
): Promise<AgentDecision> {
  const key = import.meta.env.VITE_OPENAI_API_KEY;
  if (!key) return { intent: 'QA', answer: 'Cloud reasoning key missing. Add VITE_OPENAI_API_KEY in .env.local and restart.' };

  const shortHistory = history.slice(-6);
  const planContext: PlanContext = {
    lastAccepted: plan.lastAccepted ? {
      ...plan.lastAccepted,
      movedIds: safeSlice(plan.lastAccepted.movedIds, 120),
      scheduledIds: safeSlice(plan.lastAccepted.scheduledIds, 120),
      unscheduledIds: safeSlice(plan.lastAccepted.unscheduledIds, 120),
    } : undefined,
    preview: plan.preview ? {
      ...plan.preview,
      movedIds: safeSlice(plan.preview.movedIds, 120),
      scheduledIds: safeSlice(plan.preview.scheduledIds, 120),
      unscheduledIds: safeSlice(plan.preview.unscheduledIds, 120),
    } : undefined
  };

  const SYSTEM = [
    'You are the Scheduler Agent for a fleet maintenance app.',
    'You receive a Knowledge Pack + short history + plan context.',
    'INTENTS:',
    ' • SUGGEST: produce a scheduling policy (JSON).',
    ' • ACCEPT / REJECT: apply or discard the current preview.',
    ' • REPORT: return a report query JSON.',
    ' • QA: natural language concise answer using ONLY provided data.',
    ' • MUTATE: change resources/parts (add technicians, set availability, mark a part available) via JSON mutations.',
    'When MUTATE is used, also reply with a short natural-language confirmation in "answer".',
  ].join('\n');

  const RESPONSE_FORMAT = [
    'Return ONLY this JSON (no extra text):',
    '```json',
    '{',
    '  "intent": "SUGGEST|ACCEPT|REJECT|REPORT|QA|MUTATE",',
    '  "policy": { "windows": [{"startHour": 18, "endHour": 23}], "avoidOps": true, "weekendsAllowed": true, "vehicleScope": ["V001"], "depotScope": ["Depot B"], "horizonDays": 7, "prioritize": ["Corrective","Critical","High","Preventive","Medium","Low"], "splitLongJobs": true, "maxChunkHours": 4 },',
    '  "report": { "kind": "UNSCHEDULED", "vehicleId": "V007", "nBack": 1 },',
    '  "mutations": [',
    '    { "op": "ADD_TECH", "name": "Temp Tech", "skill": "Mechanic", "depot": "Depot B", "hoursPerDay": 8 },',
    '    { "op": "SET_AVAILABILITY", "technicianId": "techA", "date": "2025-08-22", "hours": 6 },',
    '    { "op": "MARK_PART_AVAILABLE", "partId": "P-221", "qty": 2, "eta": "2025-08-23" }',
    '  ],',
    '  "answer": "Short confirmation or explanation.",',
    '  "confidence": 0.0',
    '}',
    '```'
  ].join('\n');

  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'system', content: RESPONSE_FORMAT },
    { role: 'user', content: `KNOWLEDGE_PACK:\n\`\`\`json\n${JSON.stringify(pack)}\n\`\`\`` },
    { role: 'user', content: `PLAN_CONTEXT:\n\`\`\`json\n${JSON.stringify(planContext)}\n\`\`\`` },
    { role: 'user', content: `HISTORY:\n\`\`\`json\n${JSON.stringify(shortHistory)}\n\`\`\`` },
    { role: 'user', content: `QUESTION:\n${normalize(question)}` },
  ] as const;

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini', messages, temperature: 0.2 })
  });

  const data = await resp.json();
  if (!resp.ok || data?.error) {
    const reason = data?.error?.message ?? resp.statusText;
    return { intent: 'QA', answer: `Model error: ${reason}` };
  }

  const text = String(data?.choices?.[0]?.message?.content ?? '');
  const obj = parseJSONFrom(text) ?? {};
  const rawIntent = String(obj.intent ?? 'QA').toUpperCase();
  const allowed = new Set(['SUGGEST','ACCEPT','REJECT','REPORT','QA','MUTATE']);
  const intent = (allowed.has(rawIntent) ? rawIntent : 'QA') as AgentDecision['intent'];

  const decision: AgentDecision = {
    intent,
    policy: obj.policy,
    report: obj.report,
    answer: obj.answer,
    mutations: Array.isArray(obj.mutations) ? obj.mutations : undefined,
    confidence: typeof obj.confidence === 'number' ? obj.confidence : undefined
  };

  if (decision.intent === 'SUGGEST' && decision.policy?.horizonDays) {
    decision.policy.horizonDays = Math.max(1, Math.min(14, Number(decision.policy.horizonDays)));
  }

  return decision;
}

const FACTS = [
  'Grouping PM by skill reduces changeovers and increases wrench time.',
  'Night/weekend windows cut conflicts with transport demand.',
  'Carry spares for long-lead, high-criticality parts to reduce downtime.',
  'Split long jobs into chunks to fit tight capacity.',
  'Backlog > 2× weekly capacity predicts future breakdowns.',
  'Depot-specific scheduling avoids travel time and slippage.',
];
export function helloSchedulerFact(): string {
  const fact = FACTS[Math.floor(Math.random() * FACTS.length)];
  return `Hello 👋 — I’m the Scheduler Agent. Tip: ${fact}`;
}
