// src/agents/reliability.ts
import type { QATurn, AgentDecision } from '../types';
import { getFailures, getVehicles } from '../data/adapter';

const OPENAI_API_BASE =
  (import.meta.env?.VITE_OPENAI_API_BASE as string) || 'https://api.openai.com/v1';
const OPENAI_API_KEY = import.meta.env?.VITE_OPENAI_API_KEY as string | undefined;
const OPENAI_MODEL =
  (import.meta.env?.VITE_OPENAI_MODEL as string) || 'gpt-4o-mini';

function extractOutputText(data: any): string {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) return data.output_text;
  if (Array.isArray(data?.output)) {
    const texts: string[] = [];
    for (const item of data.output) {
      const content = item?.content;
      if (Array.isArray(content)) {
        for (const c of content) if (typeof c?.text === 'string') texts.push(c.text);
      }
    }
    if (texts.length) return texts.join('\n');
  }
  if (Array.isArray(data?.choices) && data.choices[0]?.message?.content) {
    return String(data.choices[0].message.content);
  }
  if (typeof data?.text === 'string') return data.text;
  return '';
}

async function callOpenAI(input: string, temperature = 0.2, maxTokens = 800): Promise<string> {
  if (!OPENAI_API_KEY) return 'LLM unavailable (no API key).';
  const res = await fetch(`${OPENAI_API_BASE}/responses`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input,
      temperature,
      max_output_tokens: maxTokens,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    const reason = data?.error?.message || res.statusText;
    throw new Error(`Model call failed: ${reason}`);
  }
  const text = extractOutputText(data);
  return text || 'I could not derive a reliability answer.';
}

export function buildReliabilityPack(windowWeeks = 26, historyDays = 180) {
  const failures = getFailures();
  const vehicles = getVehicles(20);
  return {
    windowWeeks,
    historyDays,
    vehicles: vehicles.map(v => ({ id: v.id, status: v.status, model: (v as any).model })),
    failures,
    hints: [
      'Look for thermostat-related cooling failures across many vehicles in the last ~2 months.',
      'Flag any vehicle with increasing engine or transmission failure rates.',
      'Note one vehicle with intermittent electrical/performance issues suggestive of ECU problems.'
    ]
  };
}

const RELIABILITY_FACTS = [
  'Patterns like “wear-out” show increasing failure rates; “infant mortality” shows early spikes then stabilizes.',
  'RCM separates preventive tasks from condition-based tasks; not all failures are age-related.',
  'Common-cause failures across vehicles often trace back to suppliers, environment, or procedures.',
  'Weibull analysis helps distinguish early life, random, and wear-out regimes.',
  'Leading indicators: rising temperature, vibration, or error codes can precede functional failures.',
];

export function helloReliabilityFact() {
  return RELIABILITY_FACTS[Math.floor(Math.random() * RELIABILITY_FACTS.length)];
}

export async function analyzeReliabilityWithLLM(
  userText: string,
  pack: ReturnType<typeof buildReliabilityPack>,
  history: QATurn[] = []
): Promise<AgentDecision> {
  const hist = history.slice(-8).map(h => `${h.role.toUpperCase()}: ${h.text}`).join('\n');
  const safePack = JSON.stringify(pack).slice(0, 120_000);

  const sys = `
You are a Reliability Engineer agent for heavy vehicles.
Use failure histories, known subsystems (engine, transmission, cooling, electrical, brakes), and standard RE methods:
- Compare failure counts/rates over adjacent periods (e.g., last 3 weeks vs prior 3 weeks).
- Identify clusters by part/subsystem (e.g., thermostats across fleet).
- Suggest plausible root causes and targeted actions (inspection, PM changes, supplier checks).
Be concise, actionable, and quantify where possible.`;

  const prompt = [
    sys.trim(),
    `\nHISTORY (most recent first):\n${hist || '(none)'}\n`,
    `\nDATA_PACK_JSON:\n${safePack}\n`,
    `\nUSER:\n${userText}\n`,
    `Please return a short, clear analysis with bullet points when helpful.`,
  ].join('\n');

  const text = await callOpenAI(prompt, 0.2, 800);
  return { intent: 'QA', answer: text?.trim() || 'I could not derive a reliability answer.' };
}
