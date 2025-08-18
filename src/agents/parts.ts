// src/agents/parts.ts
import type { AgentDecision, QATurn } from '../types';
import { getVehicles } from '../data/adapter';

const PARTS_SYSTEM = `
You are the Parts Interpreter.
Map fault descriptions/work orders to parts. Provide fictional but realistic details:
- Part number (SKU), description, supplier, unit cost (USD), typical lead time (days).
- If fleet-wide issue is implied, recommend a quantity and rationale.
Be concise and practical.`;

async function chatLLM(system: string, history: QATurn[] | undefined, user: string): Promise<string> {
  const apiKey = (import.meta as any).env?.VITE_OPENAI_API_KEY;
  const model = (import.meta as any).env?.VITE_OPENAI_MODEL || 'gpt-4o-mini';
  if (!apiKey) return 'I cannot reach the LLM (missing VITE_OPENAI_API_KEY).';
  const msgs = [
    { role: 'system', content: system },
    ...(history ?? []).map(m => ({ role: m.role, content: m.text })),
    { role: 'user', content: user }
  ];
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, temperature: 0.2, messages: msgs })
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    return `LLM error (${res.status}): ${t.slice(0,200) || res.statusText}`;
  }
  const json = await res.json();
  return json?.choices?.[0]?.message?.content ?? '';
}

export function buildPartsPack() {
  const vehicles = getVehicles().map(v => v.id);
  return { vehicles, note: 'Cooling system thermostat failures recently increased across multiple vehicles.' };
}

export async function analyzePartsWithLLM(
  userText: string,
  pack: any,
  history: QATurn[] = []
): Promise<AgentDecision> {
  const prompt =
`CONTEXT:
${JSON.stringify(pack)}

REQUEST:
${userText}

Reply with a compact recommendation (bullets ok). Include SKU, supplier, price, lead time, and suggested quantity if fleet-wide.`;
  const content = await chatLLM(PARTS_SYSTEM, history, prompt);
  return { intent: 'QA', answer: content };
}
