// src/agents/agentRuntime.ts
import type { AgentDecision, QATurn } from '../types';
import { buildKnowledgePack } from './context';

const FACTS = [
  'Tip: schedule short inspections in low-demand windows to avoid cancelling ops.',
  'Ask me to “move WO-011 to 2025-08-22 10:00–12:00”.',
  'Say “move OP-007 to tomorrow 13:00–17:00” to reschedule an ops task by ID.',
  'Say “within ±1 day, shift ops so all maintenance runs 09:00–17:00” for a global re-balance.',
];
export function helloSchedulerFact(): string {
  return FACTS[Math.floor(Math.random() * FACTS.length)];
}

async function chatLLM(system: string, messages: QATurn[] | undefined, user: string): Promise<string> {
  const apiKey = (import.meta as any).env?.VITE_OPENAI_API_KEY;
  const model = (import.meta as any).env?.VITE_OPENAI_MODEL || 'gpt-4o-mini';
  if (!apiKey) return 'I cannot reach the LLM (missing VITE_OPENAI_API_KEY).';
  const history = (messages ?? []).map(m => ({ role: m.role, content: m.text }));
  const body = { model, temperature: 0.2, messages: [{ role: 'system', content: system }, ...history, { role: 'user', content: user }] };
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    return `LLM error (${res.status}): ${t.slice(0,200) || res.statusText}`;
  }
  const json = await res.json();
  return json?.choices?.[0]?.message?.content ?? '';
}

function parseAssistant(content: string): { decision: 'QA'|'MUTATE'|'SUGGEST', answer?: string, mutations?: any[], policy?: any } {
  const fence = content.match(/```json\s*([\s\S]*?)\s*```/i);
  const raw = fence ? fence[1] : content;
  try {
    const obj = JSON.parse(raw);
    const decision = (obj.decision ?? obj.intent ?? 'QA').toUpperCase();
    return {
      decision: (decision === 'MUTATE' || decision === 'SUGGEST') ? decision : 'QA',
      answer: obj.answer ?? obj.summary ?? undefined,
      mutations: Array.isArray(obj.mutations) ? obj.mutations : undefined,
      policy: obj.policy
    } as any;
  } catch {
    return { decision: 'QA', answer: content };
  }
}

const SCHED_SYSTEM = `
You are the Scheduler Agent for a fleet maintenance operation.
You see a summarized JSON of the current plan/state and may propose JSON "mutations" for the app to apply.

VERY IMPORTANT BEHAVIOR:
- If the user gives a DIRECT EDIT (e.g., “move WO-011 to 2025-08-22 09:00–10:00”, or “move OP-007 to 2025-08-23 13:00–17:00”), perform ONLY that edit:
  - For maintenance: emit MOVE_WORKORDER with that id/start/end.
  - For ops tasks: emit MOVE_OPS_TASK with that id/start/end.
  Do NOT move or reschedule anything else unless asked to "suggest/optimise/re-balance".
- If the user asks to "suggest/optimise/re-balance", return decision "SUGGEST" with an optional "policy" object.
  Example policy:
  {
    "forceBusinessHours": true,
    "businessHours": [9, 17],
    "opsFlexDays": 1   // allow ops tasks to move within ±1 day from their original start
  }
  The app will then apply a bulk re-balance using this policy and propose a new schedule.
- Dates must be local wall-clock ISO without a timezone suffix (e.g., 2025-08-22T09:00:00).
- Keep changes within the static demo week starting 2025-08-22.
- Never invent vehicles.

Return ONLY a single JSON object in a \`\`\`json fenced block with:
{
  "decision": "MUTATE" | "SUGGEST" | "QA",
  "answer": "short human explanation",
  "policy": { ... },               // optional, only for SUGGEST
  "mutations": [                   // only for MUTATE
     { "type": "MOVE_WORKORDER", "id": "WO-011", "start": "YYYY-MM-DDTHH:MM:SS", "end": "YYYY-MM-DDTHH:MM:SS" },
     { "type": "MOVE_OPS_TASK", "id": "OP-007", "start": "YYYY-MM-DDTHH:MM:SS", "end": "YYYY-MM-DDTHH:MM:SS" },

     { "type": "ADD_WORKORDER", "workorder": { "id": string, "vehicleId": string, "title": string, "type": "Preventive"|"Corrective", "priority": "Low"|"Medium"|"High"|"Critical", "requiredSkills": string[], "hours": number, "start": "YYYY-MM-DDTHH:MM:SS", "end": "YYYY-MM-DDTHH:MM:SS", "status": "Scheduled"|"Open", "subsystem"?: string } },
     { "type": "UPDATE_WORKORDER", "id": string, "patch": { "start"?: string, "end"?: string, "priority"?: string, "status"?: string, "requiredSkills"?: string[], "title"?: string } },
     { "type": "CANCEL_WORKORDER", "id": string },

     { "type": "ADD_OPS_TASK", "task": { "id": string, "vehicleId": string, "title": string, "start": string, "end": string } },
     { "type": "CANCEL_OPS_TASK", "id": string },
     { "type": "CANCEL_OPS_TASK", "conflictsWith": "WO-..." },

     { "type": "ADD_TECH", "tech": { "id": string, "name": string, "skills": string[] } },
     { "type": "REMOVE_TECH", "id": string },
     { "type": "ADD_AVAILABILITY", "slot": { "date": "YYYY-MM-DD", "technicianId": string, "hours": number } },
     { "type": "REMOVE_AVAILABILITY", "slot": { "date": "YYYY-MM-DD", "technicianId": string } }
  ]
}
`;

export async function analyzeWithLLM(
  userText: string,
  knowledgePack?: any,
  history: QATurn[] = [],
  planCtx?: any
): Promise<AgentDecision> {
  const pack = knowledgePack ?? buildKnowledgePack({ horizonDays: 7 });
  const ctx = { planContext: planCtx ?? {} };

  const prompt =
`DATA (summarized JSON):
${JSON.stringify(pack).slice(0, 120000)}

CONTEXT:
${JSON.stringify(ctx).slice(0, 4000)}

USER REQUEST:
${userText}

Return the JSON per schema.`;

  const content = await chatLLM(SCHED_SYSTEM, history, prompt);
  const parsed = parseAssistant(content);

  if (parsed.decision === 'MUTATE') {
    const withCompat = (parsed.mutations ?? []).map((m: any) => ({ op: m.type ?? m.op, ...m }));
    return { intent: 'MUTATE', answer: parsed.answer, mutations: withCompat as any[] };
  }
  if (parsed.decision === 'SUGGEST') {
    // Carry an optional policy through; Dashboard will action it.
    return { intent: 'SUGGEST', answer: parsed.answer, ...(parsed.policy ? { policy: parsed.policy } : {}) } as any;
  }
  return { intent: 'QA', answer: parsed.answer ?? content };
}
