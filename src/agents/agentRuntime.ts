// src/agents/agentRuntime.ts
import type { QATurn, AgentDecision, PlanContext } from '../types';
import { buildKnowledgePack, type KnowledgePack } from './context';

const OPENAI_API_BASE =
  (import.meta.env?.VITE_OPENAI_API_BASE as string) || 'https://api.openai.com/v1';
const OPENAI_API_KEY = import.meta.env?.VITE_OPENAI_API_KEY as string | undefined;
const OPENAI_MODEL =
  (import.meta.env?.VITE_OPENAI_MODEL as string) || 'gpt-4o-mini';

// --- Robust extraction for Responses API and fallbacks ---
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

async function callOpenAI(input: string, temperature = 0.2, maxTokens = 900): Promise<string> {
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
  return text || 'I could not derive an answer from the model.';
}

// --- Helpers: parse simple date phrases for the static week (22–28 Aug 2025) ---
const WEEK_START_ISO = '2025-08-22T00:00:00';
const WEEK_START = new Date(WEEK_START_ISO);
const DAY_NAME: Record<string, number> = { fri:0, sat:1, sun:2, mon:3, tue:4, wed:5, thu:6 };
function toYMD(offset: number) {
  const d = new Date(WEEK_START.getTime() + offset * 86400000);
  return d.toISOString().slice(0, 10);
}
function parseTimeToken(tok: string): [number, number] | null {
  const t = tok.trim().toLowerCase();
  // "9am", "9:30am", "14:15"
  const m1 = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
  if (m1) {
    let hh = Number(m1[1]);
    const mm = Number(m1[2] ?? '0');
    const ap = m1[3];
    if (ap === 'pm' && hh < 12) hh += 12;
    if (ap === 'am' && hh === 12) hh = 0;
    return [hh, mm];
  }
  const m2 = t.match(/^(\d{1,2}):(\d{2})$/);
  if (m2) return [Number(m2[1]), Number(m2[2])];
  const m3 = t.match(/^(\d{1,2})$/);
  if (m3) return [Number(m3[1]), 0];
  return null;
}
function parseDayOrDateToken(tok: string): number | null {
  const t = tok.trim().toLowerCase();
  if (DAY_NAME[t] !== undefined) return DAY_NAME[t];
  const m = t.match(/^(\d{1,2})\s*(aug|august)$/);
  if (m) {
    const day = Number(m[1]);
    const base = new Date('2025-08-22T00:00:00');
    const idx = day - 22;
    if (idx >= 0 && idx <= 6) return idx;
  }
  return null;
}

/**
 * Normalize & lightly validate LLM mutations:
 * - Uppercase known IDs (WO-xxx, OPS-xxx, Vxxx)
 * - Fill start/end from simple natural tokens in `userText` if missing
 * - Clamp to the static week and business hours when underspecified
 * - Drop unknown ops (anything not in the allowed list)
 */
function normalizeMutations(
  muts: any[] | undefined,
  userText: string,
  pack: KnowledgePack
): any[] | undefined {
  if (!Array.isArray(muts) || !muts.length) return muts;

  const allowed = new Set([
    'ADD_WORKORDER','MOVE_WORKORDER','CANCEL_WORKORDER','UPDATE_WORKORDER',
    'MOVE_OPS','CANCEL_OPS','ADD_OPS',
    'ADD_TECH','REMOVE_TECH','SET_AVAILABILITY',
    'ASSUME_PART_AVAILABLE'
  ]);

  // quick userText parse: look for time & day tokens
  const tokens = userText.split(/[\s,]+/);
  let pickedDay: number | null = null;
  let pickedTime: [number, number] | null = null;
  for (const t of tokens) {
    if (pickedDay === null) {
      const d = parseDayOrDateToken(t);
      if (d !== null) pickedDay = d;
    }
    if (!pickedTime) {
      const tm = parseTimeToken(t);
      if (tm) pickedTime = tm;
    }
  }

  const bh = pack.businessHours || [8, 17];

  const knownWO = new Set(pack.idSets.workorderIds);
  const knownOPS = new Set(pack.idSets.opsIds);
  const knownVEH = new Set(pack.idSets.vehicleIds);

  const toISO = (dayIdx: number, hh: number, mm: number) => {
    const d = new Date(WEEK_START.getTime() + dayIdx * 86400000);
    d.setHours(hh, mm, 0, 0);
    return d.toISOString().slice(0,19);
  };

  const fixed = muts
    .filter(m => m && allowed.has(String(m.op || m.OP || '').toUpperCase()))
    .map(m => {
      const op = String(m.op || m.OP).toUpperCase();

      const out: any = { op };

      // normalize IDs
      if (m.id) out.id = String(m.id).toUpperCase();
      if (m.opsId) out.opsId = String(m.opsId).toUpperCase();
      if (m.vehicleId) out.vehicleId = String(m.vehicleId).toUpperCase();

      // pick duration/hours if provided
      if (typeof m.hours === 'number') out.hours = m.hours;

      // copy common fields
      for (const k of ['title','priority','type','requiredSkills']) {
        if (m[k] !== undefined) out[k] = m[k];
      }

      // choose start/end
      const haveStart = typeof m.start === 'string' && m.start.includes('T');
      const haveEnd   = typeof m.end === 'string' && m.end.includes('T');

      if (haveStart) out.start = m.start;
      if (haveEnd) out.end = m.end;

      // if missing start/end but day/time tokens present, compose them
      if ((op === 'MOVE_WORKORDER' || op === 'MOVE_OPS' || op === 'ADD_WORKORDER' || op === 'ADD_OPS') && (!haveStart || !haveEnd)) {
        const dIdx = pickedDay ?? 0; // default to day 0 if the user didn’t specify
        const [hStart, mStart] = pickedTime ?? [bh[0], 0];
        const hrs = Number(m.hours ?? out.hours ?? 1);
        const startISO = toISO(dIdx, hStart, mStart);
        const endISO = toISO(dIdx, Math.min(23, hStart + Math.max(1, Math.ceil(hrs))), mStart);
        out.start = out.start ?? startISO;
        out.end   = out.end   ?? endISO;
      }

      // Basic ID existence checks — don’t drop, but mark unknown so UI can message user
      if (op.includes('WORKORDER') && out.id && !knownWO.has(out.id)) {
        out._unknownId = true;
      }
      if (op.includes('OPS') && out.opsId && !knownOPS.has(out.opsId)) {
        out._unknownId = true;
      }
      if (out.vehicleId && !knownVEH.has(out.vehicleId)) {
        out._unknownVehicle = true;
      }

      return out;
    });

  return fixed.length ? fixed : undefined;
}

// Extract first JSON object from a model answer
function extractFirstJSON(text: string): any | null {
  const fence = /```(?:json)?\s*([\s\S]*?)\s*```/i;
  const m = text.match(fence);
  const raw = m ? m[1] : text;
  try {
    return JSON.parse(raw);
  } catch {
    const obj = text.match(/\{[\s\S]*\}/);
    if (obj) {
      try { return JSON.parse(obj[0]); } catch {}
    }
    return null;
  }
}

const SCHEDULER_FACTS = [
  'Tip: scheduling inside business hours reduces overtime cost and improves technician utilization.',
  'Tasks with part constraints can be sequenced after deliveries to minimize idle time.',
  'Bundling PM with related corrective tasks saves setup/teardown time.',
  'Avoid scheduling multiple long tasks on the same asset right before peak demand.',
  'Reserve slack time for urgent corrective maintenance—micro-buffers help absorb variability.',
];
export function helloSchedulerFact() {
  return SCHEDULER_FACTS[Math.floor(Math.random() * SCHEDULER_FACTS.length)];
}

/**
 * Central LLM entry for the Scheduler agent.
 * - Builds a rich prompt with goals, history, plan context, and knowledge pack.
 * - Asks the model to return strict JSON (intent/mutations/answer).
 * - Post-processes mutations to normalize IDs & timestamps, avoiding hard-coded business logic.
 */
export async function analyzeWithLLM(
  userText: string,
  pack: ReturnType<typeof buildKnowledgePack>,
  history: QATurn[] = [],
  planCtx?: PlanContext
): Promise<AgentDecision> {
  const hist = history.slice(-8).map(h => `${h.role.toUpperCase()}: ${h.text}`).join('\n');
  const ctxSummary = planCtx
    ? [
        planCtx.lastAccepted
          ? `LAST_ACCEPTED: moved=${planCtx.lastAccepted.moved}, scheduled=${planCtx.lastAccepted.scheduled}, unscheduled=${planCtx.lastAccepted.unscheduled}`
          : 'LAST_ACCEPTED: none',
        planCtx.preview
          ? `PREVIEW: moved=${planCtx.preview.moved}, scheduled=${planCtx.preview.scheduled}, unscheduled=${planCtx.preview.unscheduled}`
          : 'PREVIEW: none',
      ].join('\n')
    : 'NO_PLAN_CONTEXT';

  const safePack = JSON.stringify(pack).slice(0, 120_000);

  const sys = `
You are a Maintenance Scheduler Agent for a fleet.
You can either propose a whole-week plan (intent="PROPOSE") or output precise mutations (intent="MUTATE").
Respect these rules:
- Avoid overlapping operations on the same vehicle.
- If asked, keep maintenance inside business hours (${pack.businessHours?.[0]}–${pack.businessHours?.[1]} local).
- Honor explicit user instructions (IDs & times), and don't hallucinate IDs.
- If an ID is unknown, state that clearly in the "answer".

ALLOWED MUTATIONS (JSON objects inside "mutations"):
- { "op":"ADD_WORKORDER", "vehicleId":"V005", "title":"Thermostat Inspection", "priority":"Medium", "type":"PM|CM", "requiredSkills":["Mechanic"], "hours":1, "start":"YYYY-MM-DDTHH:MM:SS", "end":"YYYY-MM-DDTHH:MM:SS" }
- { "op":"MOVE_WORKORDER", "id":"WO-011", "start":"YYYY-MM-DDTHH:MM:SS", "end":"YYYY-MM-DDTHH:MM:SS" }
- { "op":"CANCEL_WORKORDER", "id":"WO-011" }
- { "op":"UPDATE_WORKORDER", "id":"WO-011", "title":"...", "priority":"High", "hours":2, "requiredSkills":["AutoElec"] }

- { "op":"MOVE_OPS", "opsId":"OPS-123", "start":"YYYY-MM-DDTHH:MM:SS", "end":"YYYY-MM-DDTHH:MM:SS" }
- { "op":"CANCEL_OPS", "opsId":"OPS-123" }
- { "op":"ADD_OPS", "vehicleId":"V010", "title":"Backhaul", "start":"YYYY-MM-DDTHH:MM:SS", "end":"YYYY-MM-DDTHH:MM:SS" }

- { "op":"ADD_TECH", "id":"T-NEW", "skills":["Mechanic"], "perDayHours":8 }
- { "op":"REMOVE_TECH", "id":"T-02" }
- { "op":"SET_AVAILABILITY", "techId":"T-01", "date":"YYYY-MM-DD", "hours":4 }

- { "op":"ASSUME_PART_AVAILABLE", "part_name":"Thermostat", "quantity":10, "date":"YYYY-MM-DD" }

OUTPUT CONTRACT:
Return a single fenced block:
\`\`\`json
{
  "intent": "QA" | "MUTATE" | "PROPOSE",
  "answer": "short human explanation",
  "mutations": [ ... zero or more of the ALLOWED MUTATIONS ... ]
}
\`\`\`
If the user asks to “optimize the whole week”, set intent="PROPOSE" and explain policy. If they target specific IDs/dates, prefer intent="MUTATE" with only those changes.
`;

  const prompt = [
    sys.trim(),
    `\nHISTORY (most recent first):\n${hist || '(none)'}\n`,
    `\nPLAN_CONTEXT:\n${ctxSummary}\n`,
    `\nKNOWLEDGE_PACK_JSON:\n${safePack}\n`,
    `\nUSER:\n${userText}\nPlease return only the fenced JSON as specified.`,
  ].join('\n');

  const text = await callOpenAI(prompt, 0.2, 900);
  const obj = extractFirstJSON(text);

  if (obj && (obj.intent === 'QA' || obj.intent === 'MUTATE' || obj.intent === 'PROPOSE')) {
    const normalized = normalizeMutations(obj.mutations, userText, pack);
    const decision: AgentDecision = {
      intent: obj.intent,
      answer: typeof obj.answer === 'string' ? obj.answer : undefined,
      mutations: normalized,
    };
    return decision;
  }

  return { intent: 'QA', answer: text?.trim() || 'I could not derive an answer.' };
}
