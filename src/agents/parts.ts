// src/agents/parts.ts
import type { QATurn, AgentDecision } from '../types';
import { getWorkOrders } from '../data/adapter';
import * as partsModule from '../data/partsCatalog';

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
      if (Array.isArray(content)) for (const c of content) if (typeof c?.text === 'string') texts.push(c.text);
    }
    if (texts.length) return texts.join('\n');
  }
  if (Array.isArray(data?.choices) && data.choices[0]?.message?.content) return String(data.choices[0].message.content);
  if (typeof data?.text === 'string') return data.text;
  return '';
}

async function callOpenAI(input: string, temperature = 0.3, maxTokens = 700): Promise<string> {
  if (!OPENAI_API_KEY) return 'LLM unavailable (no API key).';
  const res = await fetch(`${OPENAI_API_BASE}/responses`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: OPENAI_MODEL, input, temperature, max_output_tokens: maxTokens }),
  });
  const data = await res.json();
  if (!res.ok) {
    const reason = data?.error?.message || res.statusText;
    throw new Error(`Model call failed: ${reason}`);
  }
  const text = extractOutputText(data);
  return text || 'I could not determine parts without more detail.';
}

// ---- Catalog normalization from whatever export shape you have ----
type CatalogItemIn = Record<string, unknown>;
type CatalogItemOut = {
  part_id: string;
  part_name: string;
  subsystem?: string;
  lead_time_days?: number;
  unit_cost?: number;
};
function pickCatalogArray(mod: any): CatalogItemIn[] {
  const candidates = [mod?.default, mod?.partsCatalog, mod?.catalog, mod?.PARTS, mod?.items, mod?.parts, mod];
  for (const c of candidates) if (Array.isArray(c)) return c as CatalogItemIn[];
  if (mod && typeof mod === 'object') {
    for (const k of Object.keys(mod)) {
      const v = (mod as any)[k];
      if (Array.isArray(v)) return v as CatalogItemIn[];
    }
  }
  return [];
}
function toNum(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
function normalizeCatalog(raw: CatalogItemIn[]): CatalogItemOut[] {
  return raw.map((p: CatalogItemIn) => {
    const x = p as any;
    return {
      part_id: x.part_id ?? x.partId ?? x.id ?? '',
      part_name: x.part_name ?? x.partName ?? x.name ?? '',
      subsystem: x.subsystem ?? x.system ?? undefined,
      lead_time_days: toNum(x.lead_time_days ?? x.leadTimeDays ?? x.leadTime),
      unit_cost: toNum(x.unit_cost ?? x.unitCost ?? x.cost),
    };
  });
}

export function buildPartsPack() {
  const rawArr = pickCatalogArray(partsModule);
  const catalog = normalizeCatalog(rawArr);
  const workorders = getWorkOrders().map(w => ({
    id: w.id,
    vehicleId: w.vehicleId,
    description: w.description,
    subsystem: (w as any).subsystem
  }));
  return { catalog, workorders };
}

function isGreeting(s: string) {
  const t = s.trim().toLowerCase();
  return ['hi','hello','hey','yo','howdy','gday','g’day','good morning','good evening'].some(g => t.startsWith(g));
}
function skuFor(name: string) {
  const base = name.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 6);
  const tail = Math.abs(hash(name)).toString(36).toUpperCase().slice(0, 4).padStart(4,'0');
  return `${base}-${tail}`;
}
function hash(s: string) { let h = 0; for (let i = 0; i < s.length; i++) h = ((h << 5) - h) + s.charCodeAt(i) | 0; return h; }

export async function analyzePartsWithLLM(
  userText: string,
  pack: ReturnType<typeof buildPartsPack>,
  history: QATurn[] = []
): Promise<AgentDecision> {
  if (isGreeting(userText)) {
    return {
      intent: 'QA',
      answer: "Hi! Tell me a symptom (e.g., “engine overheating at idle”, “starter intermittently dead”) or reference a work order ID, and I’ll suggest likely parts with lead times and costs."
    };
  }

  // If user referenced a WO ID, include that WO context
  const woMatch = userText.match(/\bWO-\d{3,}\b/i);
  let woCtx: any = null;
  if (woMatch) {
    const id = woMatch[0].toUpperCase();
    woCtx = pack.workorders.find(w => w.id === id) || null;
  }

  const safePack = JSON.stringify({ catalog: pack.catalog, workorder: woCtx }).slice(0, 90_000);

  const sys = `
You are a Parts Interpreter for heavy-vehicle maintenance.
Task:
- Map symptoms or work order descriptions to likely parts (with plausible supplier info).
- Cross-check against the provided parts catalog when possible.
- If uncertain, ask a brief clarifying question instead of fabricating.
Output:
- A concise recommendation with: Part name, SKU (invent one if needed), likely supplier, typical lead time, unit cost (estimate if missing), and quantity rationale.
- If the user only greets you, do NOT invent parts; invite them to share symptoms or a WO ID.`;

  const prompt = [
    sys.trim(),
    `\nDATA_PACK_JSON:\n${safePack}\n`,
    `\nUSER:\n${userText}\n`,
    `If recommending a part not in the catalog, invent a realistic SKU like ${skuFor('Thermostat Valve')} and reasonable lead time/cost.`,
  ].join('\n');

  const text = await callOpenAI(prompt, 0.3, 700);
  return { intent: 'QA', answer: text?.trim() || 'I could not determine parts without more detail.' };
}
