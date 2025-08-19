// src/agents/reliability.ts
import type { AgentDecision, QATurn } from '../types';
import { getVehicles, getWorkOrders, getFailures } from '../data/adapter';

/** Build a compact knowledge pack for reliability analysis */
export function buildReliabilityPack(windowWeeks = 26, historyDays = 180) {
  const vehicles = (getVehicles?.(20) ?? getVehicles?.() ?? []);
  const workorders = (getWorkOrders?.() ?? []);
  const failures = (getFailures?.() ?? []);

  return {
    meta: { asOf: '2025-08-22', windowWeeks, historyDays },
    overview: 'Prime mover fleet; analyze failure trends, repeated/related faults, and recommended PM updates.',
    vehicles: vehicles.map(v => ({ id: v.id, status: v.status, criticality: v.criticality })),
    workorders: workorders.map(w => ({
      id: w.id, vehicleId: w.vehicleId, title: w.title, type: w.type,
      priority: w.priority, status: w.status, start: w.start, end: w.end, hours: w.hours
    })),
    failures: failures.map((f: any) => ({
      vehicleId: String(f.vehicleId ?? f.asset_id ?? ''),
      subsystem: String(f.subsystem ?? f.system ?? ''),
      part: String(f.part ?? f.part_id ?? f.partID ?? ''),
      mode: String(f.mode ?? f.failure_mode ?? ''),
      date: String(f.date ?? f.failureDate ?? f.failure_date ?? ''),
      downtimeHours: Number(f.downtimeHours ?? f.downtime_hours ?? 0)
    })),
    guidance: [
      'Identify vehicles with increasing failure rate (e.g., last 3–4 weeks vs prior period).',
      'Detect repeated or related failures by subsystem/part.',
      'Look for cross-fleet spikes (e.g., many thermostats in last ~2 months).',
      'Suggest root causes and actions (e.g., PM change, inspection, redesign).',
      'Cite specific vehicle IDs, counts, and time windows in your answer.'
    ]
  };
}

/** Call the LLM and return a readable answer (no UI changes required) */
export async function analyzeReliabilityWithLLM(
  userText: string,
  pack: any,
  history: QATurn[] = []
): Promise<AgentDecision> {
  const apiKey = import.meta.env.VITE_OPENAI_API_KEY as string | undefined;
  const SYSTEM =
    'You are the Reliability Agent. Analyze failure trends using reliability engineering principles (RCM, Weibull-thinking, Pareto, trend analysis). Give concise, actionable findings with evidence (vehicle IDs, counts, dates).';

  const messages = [
    { role: 'system', content: SYSTEM },
    ...history.map(h => ({ role: h.role, content: h.text })),
    {
      role: 'user',
      content: [
        'User question:\n', userText.trim(),
        '\n\nData (trimmed):\n', JSON.stringify(pack)
      ].join('')
    }
  ];

  if (!apiKey) {
    return {
      intent: 'QA',
      answer:
        'Connect your API key to analyze patterns. Once connected, ask: “Any repeated or related failures we should investigate?” or “Are thermostats spiking across the fleet?”'
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
      return { intent: 'QA', answer: `Reliability LLM error: ${t.slice(0, 400)}` };
    }
    const data = await resp.json();
    const content: string =
      data?.choices?.[0]?.message?.content ??
      data?.choices?.[0]?.message ??
      data?.choices?.[0]?.text ??
      'I could not derive a reliability answer.';
    return { intent: 'QA', answer: String(content) };
  } catch (err: any) {
    return { intent: 'QA', answer: `Reliability LLM request failed: ${err?.message ?? String(err)}` };
  }
}

/** Small hello blurb for the card */
export function helloReliabilityFact() {
  const facts = [
    'Tip: Ask “Any repeated or related failures we should investigate?”',
    'Try: “Are any vehicles showing an increasing failure rate?”',
    'Ask: “Any cross-fleet spikes (e.g., thermostats) in last 2 months?”'
  ];
  return facts[Math.floor(Math.random() * facts.length)];
}
