// src/agents/parts.ts
import type { AgentDecision, QATurn, WorkOrder, Vehicle } from '../types';
import { getWorkOrders, getVehicles } from '../data/adapter';
// Be resilient to either export style from partsCatalog.ts
// (some repos export a function, others a constant array)
import * as PC from '../data/partsCatalog';

// ---------------- Types for catalog rows ----------------
type CatalogRow = {
  part_id: string;
  part_name: string;
  subsystem?: string;
  mean_time_between_failures?: number;
  lead_time_days?: number;
  unit_cost?: number;
  supplier?: string;
  keywords?: string;
};

// ---------------- Catalog loader (tolerant) ----------------
function loadPartsCatalog(): CatalogRow[] {
  // Prefer a function export if present
  const maybeFn = (PC as any)?.getPartsCatalog;
  if (typeof maybeFn === 'function') {
    const data = maybeFn();
    return Array.isArray(data) ? data : [];
  }
  // Otherwise look for a constant array
  const arr = (PC as any)?.partsCatalog;
  return Array.isArray(arr) ? arr : [];
}

// ---------------- Pack builder ----------------
export function buildPartsPack() {
  const workorders: WorkOrder[] = (getWorkOrders?.() ?? []);
  const vehicles: Vehicle[] = (getVehicles?.(20) ?? []);
  const catalog: CatalogRow[] = loadPartsCatalog();
  return { partsCatalog: catalog, workorders, vehicles };
}

// ---------------- OpenAI helper (Responses API) ----------------
async function callOpenAI(prompt: string): Promise<string> {
  const key = (import.meta as any).env?.VITE_OPENAI_API_KEY;
  if (!key) return 'LLM unavailable: missing VITE_OPENAI_API_KEY';

  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini-2024-07-18',
      input: prompt,
      temperature: 0.3,
      max_output_tokens: 700,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return `Model call failed (${res.status}): ${text || res.statusText}`;
  }

  const data = await res.json();
  try {
    const first = data?.output?.[0];
    if (first?.type === 'message') {
      const parts = first?.content || [];
      const txt = parts.map((p: any) => (p?.text ?? '')).join('').trim();
      return txt || JSON.stringify(data);
    }
  } catch {}
  return typeof data === 'string' ? data : JSON.stringify(data);
}

// ---------------- Helpers ----------------
const WO_REGEX = /WO-(\d{3,})/i;

function pickWorkOrder(text: string, pack: ReturnType<typeof buildPartsPack>): WorkOrder | undefined {
  const m = text.match(WO_REGEX);
  if (!m) return undefined;
  const id = `WO-${m[1]}`;
  return pack.workorders.find(w => w.id === id);
}

function woMini(wo: WorkOrder | undefined) {
  if (!wo) return null;
  return {
    id: wo.id,
    vehicleId: wo.vehicleId,
    title: wo.title,
    type: wo.type,
    priority: wo.priority,
    status: wo.status,
    start: wo.start,
    end: wo.end,
    subsystem: wo.subsystem,
    requiredSkills: wo.requiredSkills ?? [],
    requiredParts: wo.requiredParts ?? [],
    requiredTools: wo.requiredTools ?? [],
    description: wo.description ?? '',
  };
}

// Very simple candidate search over the catalog using WO context
function candidatesForWO(wo: WorkOrder | undefined, catalog: CatalogRow[]): CatalogRow[] {
  if (!Array.isArray(catalog) || catalog.length === 0) return [];
  if (!wo) return catalog.slice(0, Math.min(6, catalog.length));

  const hay = `${wo.title ?? ''} ${wo.description ?? ''} ${wo.subsystem ?? ''}`.toLowerCase();

  const hits = catalog.filter((row) => {
    const s = `${row.part_name ?? ''} ${row.subsystem ?? ''} ${row.keywords ?? ''}`.toLowerCase();
    // Prefer direct subsystem match
    if (wo.subsystem && s.includes(String(wo.subsystem).toLowerCase())) return true;
    // Common heuristics
    if (hay.includes('thermostat') && s.includes('thermostat')) return true;
    if (hay.includes('coolant') && s.includes('cool')) return true;
    if (hay.includes('overheat') && (s.includes('thermostat') || s.includes('cool'))) return true;
    if (hay.includes('engine') && s.includes('engine')) return true;
    if (hay.includes('brake') && s.includes('brake')) return true;
    if (hay.includes('transmission') && s.includes('transmission')) return true;
    if (hay.includes('electrical') && s.includes('electrical')) return true;
    return false;
  });

  return (hits.length ? hits : catalog).slice(0, Math.min(6, catalog.length));
}

// ---------------- Public entry ----------------
export async function analyzePartsWithLLM(
  userText: string,
  pack: ReturnType<typeof buildPartsPack>,
  history: QATurn[]
): Promise<AgentDecision> {
  const catalog: CatalogRow[] = Array.isArray(pack.partsCatalog) ? pack.partsCatalog : [];
  const wo = pickWorkOrder(userText, pack);
  const woCtx = woMini(wo);
  const cands = candidatesForWO(wo, catalog);

  const sys = `
You are a Parts Interpreter for a heavy-vehicle fleet.

Your job:
- Map faults / work orders to likely parts and quantities.
- Propose realistic SKUs, suppliers, unit costs, and lead times (fabricate but plausible).
- If the user asks for a purchase order, draft concise PO lines (SKU, desc, qty, cost, lead time, supplier).
- If a work order is referenced (e.g., "WO-011"), **use its context** (title, subsystem, description, required parts/tools) and DO NOT ask for symptoms again.
- If no work order is referenced AND the user gives no symptoms, ask at most 1–2 clarifying questions.

Important:
- Keep answers actionable and short.
- Prefer the provided catalog *when relevant*, but you may propose additional common items (e.g., gaskets, O-rings, sealants) with plausible SKUs/costs.
- If multiple alternatives exist, list top 2–3 with trade-offs (quality/price/lead time).`;

  const facts = {
    workOrder: woCtx,
    candidateParts: cands.map((row) => ({
      part_id: row.part_id,
      part_name: row.part_name,
      subsystem: row.subsystem ?? '',
      mean_time_between_failures: row.mean_time_between_failures ?? null,
      lead_time_days: row.lead_time_days ?? null,
      unit_cost: row.unit_cost ?? null,
      supplier_hint: row.supplier ?? '',
    })),
  };

  const prompt = `${sys}

--- CONTEXT ---
${JSON.stringify(facts, null, 2)}

--- HISTORY ---
${history.map(h => `${h.role.toUpperCase()}: ${h.text}`).join('\n')}

--- USER ---
${userText}

Respond with a concise, helpful answer. If drafting a PO, list clear line items.`;

  const answer = await callOpenAI(prompt);
  return { intent: 'QA', answer };
}
