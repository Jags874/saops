// src/agents/parts.ts
import type { QATurn, AgentDecision } from '../types';
import { getFailures, getWorkOrders } from '../data/adapter';
import { getPartsCatalog } from '../data/partsCatalog';

// … keep the rest exactly as in my last message …


export type PartsPack = {
  about: string;
  catalog: Array<{ part_id: string; part_name: string; subsystem: string; lead_time_days?: number; unit_cost?: number }>;
  recentSignals: Array<{ vehicleId: string; subsystem: string; failure_mode?: string; date: string }>;
  openWOs: Array<{ id: string; vehicleId: string; description: string; subsystem?: string }>;
};

export function buildPartsPack(): PartsPack {
  const catalog = getPartsCatalog().map((p: any) => ({
    part_id: String(p.part_id ?? p.id ?? ''),
    part_name: String(p.part_name ?? p.name ?? ''),
    subsystem: String(p.subsystem ?? 'unknown'),
    lead_time_days: p.lead_time_days ?? p.leadTimeDays ?? undefined,
    unit_cost: p.unit_cost ?? p.cost ?? undefined,
  }));
  const recentSignals = getFailures().slice(-200).map((f: any) => ({
    vehicleId: String(f.vehicleId ?? f.asset_id ?? ''),
    subsystem: String(f.subsystem ?? 'unknown'),
    failure_mode: f.failure_mode ? String(f.failure_mode) : undefined,
    date: String(f.failure_date ?? f.date ?? new Date().toISOString()),
  }));
  const openWOs = getWorkOrders()
    .filter((w: any) => w.status !== 'Closed')
    .map((w: any) => ({ id: w.id, vehicleId: w.vehicleId, description: w.description ?? w.title, subsystem: w.subsystem }));

  return {
    about: 'Map natural-language faults to subsystem & likely parts. Provide 2–5 candidates with rationale, lead-time hints, and suggested checks.',
    catalog,
    recentSignals,
    openWOs,
  };
}

export async function analyzePartsWithLLM(
  question: string,
  pack: PartsPack,
  history: QATurn[] = []
): Promise<AgentDecision> {
  const key = import.meta.env.VITE_OPENAI_API_KEY;
  if (!key) return { intent: 'QA', answer: 'VITE_OPENAI_API_KEY missing. Add it in .env.local and restart.' };

  const SYSTEM = [
    'You are the Parts Interpreter Agent.',
    'Given a fault description, infer subsystem and list likely parts from the catalog.',
    'Return 2–5 candidates with brief rationale, and note if any have significant lead time.',
    'If WO-### or vehicle ID is mentioned, cross-reference openWOs and recentSignals.',
    'Be concise and ID-focused.',
  ].join('\n');

  const RESPONSE = [
    'Return ONLY this JSON (no extra text):',
    '```json',
    '{ "intent": "QA",',
    '  "answer": "• Likely subsystem: Cooling\n• Candidates: P-113 Radiator hose (leaks common, cheap), P-221 Water pump (noisy, lead 7d)\n• Next: pressure test, check for residue; order P-221 if shaft play present." }',
    '```'
  ].join('\n');

  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'system', content: RESPONSE },
    { role: 'user', content: `PARTS_PACK:\n\`\`\`json\n${JSON.stringify(pack)}\n\`\`\`` },
    { role: 'user', content: `HISTORY:\n\`\`\`json\n${JSON.stringify(history.slice(-6))}\n\`\`\`` },
    { role: 'user', content: `QUESTION:\n${question}` },
  ] as const;

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini', messages, temperature: 0.2 })
  });
  const data = await resp.json();
  if (!resp.ok || data?.error) {
    return { intent: 'QA', answer: `Model error: ${data?.error?.message ?? resp.statusText}` };
  }

  const text = String(data?.choices?.[0]?.message?.content ?? '').trim();
  const fence = text.match(/```json\s*([\s\S]*?)```/i);
  const raw = fence ? fence[1] : text;
  let obj: any; try { obj = JSON.parse(raw); } catch { obj = {}; }

  const answer = typeof obj?.answer === 'string' && obj.answer.trim() ? obj.answer.trim() : 'I could not derive a parts interpretation.';
  return { intent: 'QA', answer };
}
