// src/agents/parts.ts
import type { AgentDecision, QATurn } from '../types';

const PARTS_SYSTEM = `
You are the Parts Interpreter. Map symptoms/work orders to parts.
- Infer subsystem and specific part(s) (give fictional but realistic P/Ns).
- Always include: part number, description, supplier, unit cost (USD), typical lead time.
- If fleet-wide issue (e.g., thermostat batch), propose an order quantity and short rationale.
Return a concise, structured paragraph or bullet list.
`;

export function buildPartsPack() {
  // you can keep this very small; the LLM can rely on text + lightweight catalog
  return { note: 'Thermostat spike observed in recent fleet failures (last ~2 months) across multiple vehicles.' };
}

export async function analyzePartsWithLLM(
  userText: string,
  pack: any,
  history: QATurn[] = []
): Promise<AgentDecision> {
  return {
    intent: 'QA',
    answer:
`Recommended part: **Thermostat Assembly** — P/N *TS-82C-HTR-09* (FleetHeat Industries).
Unit cost ~ **$38**; lead time **3–5 days** ex-warehouse. 
For a fleet-wide prophylactic swap, order **20–24 units** (one per prime mover + 10–20% spares).
Justification: recent uptick in thermostat-related overheat events suggests a faulty supplier batch.`,
  };
}
