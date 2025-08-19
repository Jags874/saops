// src/agents/agentRuntime.ts
import type { QATurn, AgentDecision, SchedulerPolicy } from '../types';

// Read key from Vite env (client-side). Make sure you have VITE_OPENAI_API_KEY set.
const OPENAI_API_KEY = (import.meta as any).env?.VITE_OPENAI_API_KEY;

// Enforce a strict output schema so the UI can act on it
const SCHEMA = `
You are the Scheduler Agent. Output ONLY a JSON object with this shape (no prose):

{
  "intent": "MUTATE" | "PLAN" | "QA",
  "answer": string,                // short human-friendly confirmation/summary
  "mutations": [                   // present when intent="MUTATE"
    { "op": "MOVE_WO", "id": "WO-011", "start": "YYYY-MM-DDTHH:mm:ss", "hours": 2 },
    { "op": "CANCEL_WO", "id": "WO-012" },
    { "op": "MOVE_OPS", "id": "OPS-105", "start": "YYYY-MM-DDTHH:mm:ss", "hours": 8 },
    { "op": "CANCEL_OPS", "id": "OPS-090" },
    { "op": "ADD_WO", "vehicleId": "V005", "title": "Replace alternator", "hours": 2, "priority": "High", "requiredSkills": ["AutoElec"], "start": "YYYY-MM-DDTHH:mm:ss" }
  ],
  "policy": {                      // present when intent="PLAN"
    "businessHours": [8,17],
    "opsShiftDays": 1,
    "avoidOpsOverlap": true,
    "forVehicle": "V005"           // optional
  }
}
Rules:
- Normalize IDs to WO-### and OPS-###.
- Dates: interpret week around the current demo week; output local-ISO (no timezone Z).
- Never invent fields not in the schema.
`;

function extractJSON(text: string): any | null {
  try {
    // try whole string
    return JSON.parse(text);
  } catch {
    // try to find a {...} block
    const m = text.match(/\{[\s\S]*\}$/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch { return null; }
  }
}

export async function analyzeWithLLM(
  text: string,
  _pack: any,
  _history: QATurn[],
  _ctx?: any
): Promise<AgentDecision> {
  // If no key, at least respond (prevents “does nothing”)
  if (!OPENAI_API_KEY) {
    return {
      intent: 'QA',
      answer: "Scheduler isn't configured with an API key. Add VITE_OPENAI_API_KEY to use LLM planning. Meanwhile, try: “Move WO-011 to 09:00 on 22 Aug”, “Cancel WO-012”, “Optimise to day shift ±1 day ops”."
    };
  }

  // Build a compact chat with instructions + the user utterance
  const body = {
    model: 'gpt-4o-mini',
    temperature: 0.2,
    messages: [
      { role: 'system', content: SCHEMA },
      { role: 'user', content: text }
    ]
  };

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const msg = await resp.text().catch(() => String(resp.status));
    return { intent: 'QA', answer: `LLM error: ${msg}` };
  }

  const data = await resp.json();
  const raw = data?.choices?.[0]?.message?.content ?? '';
  const parsed = extractJSON(raw);

  if (!parsed || typeof parsed !== 'object') {
    return { intent: 'QA', answer: "I couldn't produce a valid plan. Please try a more direct instruction (e.g., “Move WO-011 to 09:00 on 22 Aug”)." };
  }

  // Basic normalization/guardrails
  const intent = (parsed.intent === 'MUTATE' || parsed.intent === 'PLAN') ? parsed.intent : 'QA';
  const answer = typeof parsed.answer === 'string' ? parsed.answer : undefined;

  if (intent === 'MUTATE' && Array.isArray(parsed.mutations)) {
    return { intent: 'MUTATE', answer, mutations: parsed.mutations } as any;
  }

  if (intent === 'PLAN' && parsed.policy && typeof parsed.policy === 'object') {
    const policy = parsed.policy as SchedulerPolicy;
    return { intent: 'PLAN', answer, policy } as any;
  }

  return { intent: 'QA', answer: answer ?? 'Not sure what to do with that.' };
}

export function helloSchedulerFact() {
  return 'Hello 👋 — I can move/cancel WOs & OPS, add WOs, and propose plans (day shift, ±1 day ops, no overlaps).';
}
