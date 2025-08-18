// src/agents/reliability.ts
import type { AgentDecision, QATurn } from '../types';
import { getVehicles, getFailures, getPMTasks, getDemoWeekStart } from '../data/adapter';

const FACTS = [
  'Rule of thumb: repeated same-subsystem failures in short intervals suggest design/maintenance issues.',
  'Compare last 60 days vs previous 60 days to spot batch effects (e.g., thermostats).',
  'RCM: Only add PM tasks if the failure mode is preventable and cost-effective.',
  'Always propose a quick confirmatory inspection before changing the PM strategy.',
];
export function helloReliabilityFact(): string {
  return FACTS[Math.floor(Math.random() * FACTS.length)];
}

// Simple OpenAI call
async function chatLLM(system: string, messages: QATurn[] | undefined, user: string): Promise<string> {
  const apiKey = (import.meta as any).env?.VITE_OPENAI_API_KEY;
  const model = (import.meta as any).env?.VITE_OPENAI_MODEL || 'gpt-4o-mini';
  if (!apiKey) return 'I cannot reach the LLM (missing VITE_OPENAI_API_KEY).';
  const history = (messages ?? []).map(m => ({ role: m.role, content: m.text }));
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, temperature: 0.2, messages: [{ role: 'system', content: system }, ...history, { role: 'user', content: user }] })
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    return `LLM error (${res.status}): ${t.slice(0,200) || res.statusText}`;
  }
  const json = await res.json();
  return json?.choices?.[0]?.message?.content ?? '';
}

const REL_SYSTEM = `
You are a Reliability Engineer using RCM principles.
Analyze failures: per-vehicle trends, fleet-wide spikes (e.g., thermostat), repeated/related modes.
Provide a concise, targeted answer with vehicles/subsystems, plausible root-cause hypotheses, and a quick action to confirm.
`;

export function buildReliabilityPack(weeksBack = 26, daysBack = 180) {
  const anchor = getDemoWeekStart();
  const vehicles = getVehicles().map(v => ({ id: v.id, status: v.status }));
  const failures = getFailures(); // assumed already aligned around the anchor
  const pm = getPMTasks();
  return { anchor, weeksBack, daysBack, vehicles, failures, pm };
}

export async function analyzeReliabilityWithLLM(
  userText: string,
  pack: any,
  history: QATurn[] = []
): Promise<AgentDecision> {
  const prompt =
`DATA:
${JSON.stringify(pack).slice(0, 120000)}

QUESTION:
${userText}

Answer plainly. If you see a likely root cause, suggest a quick confirmatory action (e.g., targeted inspection).`;
  const content = await chatLLM(REL_SYSTEM, history, prompt);
  return { intent: 'QA', answer: content };
}
