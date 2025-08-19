// src/agents/parts.ts
import type { AgentDecision, QATurn } from '../types';
import { getWorkOrders } from '../data/adapter';

/** Minimal pack: current WOs + guidance. (We let the LLM fabricate realistic PNs/prices/lead-times.) */
export function buildPartsPack() {
  const workorders = (getWorkOrders?.() ?? []);
  return {
    meta: { asOf: '2025-08-22' },
    workorders: workorders.map(w => ({
      id: w.id, vehicleId: w.vehicleId, title: w.title, description: w.description,
      subsystem: w.subsystem, partId: (w as any).partId || (w as any).partID || undefined,
      priority: w.priority, status: w.status
    })),
    guidance: [
      'Interpret fault symptoms or WO descriptions and map to plausible parts.',
      'Invent realistic part numbers (e.g., OEM-style), suppliers, unit cost, and lead time.',
      'If user implies fleet-wide action, suggest a consolidated purchase quantity with rationale.',
      'Return a concise, helpful plan the user could turn into a PO.'
    ]
  };
}

export async function analyzePartsWithLLM(
  userText: string,
  pack: any,
  history: QATurn[] = []
): Promise<AgentDecision> {
  const apiKey = import.meta.env.VITE_OPENAI_API_KEY as string | undefined;
  const SYSTEM =
    'You are the Parts Interpreter. From symptoms/work orders, recommend parts with plausible OEM-style part numbers, supplier, unit cost, and lead time. Be realistic, concise, and actionable.';

  const messages = [
    { role: 'system', content: SYSTEM },
    ...history.map(h => ({ role: h.role, content: h.text })),
    {
      role: 'user',
      content: [
        'User question:\n', userText.trim(),
        '\n\nCurrent workorders (trimmed):\n', JSON.stringify(pack)
      ].join('')
    }
  ];

  if (!apiKey) {
    return {
      intent: 'QA',
      answer:
        'Connect your API key to get tailored parts suggestions. Example: “Given repeated thermostat failures, draft a PO for 20 thermostats with lead times & cost.”'
    };
  }

  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini', temperature: 0.3, messages })
    });
    if (!resp.ok) {
      const t = await resp.text();
      return { intent: 'QA', answer: `Parts LLM error: ${t.slice(0, 400)}` };
    }
    const data = await resp.json();
    const content: string =
      data?.choices?.[0]?.message?.content ??
      data?.choices?.[0]?.message ??
      data?.choices?.[0]?.text ??
      'I could not interpret parts from the current data.';
    return { intent: 'QA', answer: String(content) };
  } catch (err: any) {
    return { intent: 'QA', answer: `Parts LLM request failed: ${err?.message ?? String(err)}` };
  }
}
