// src/agents/agentRuntime.ts
import type { AgentDecision, PlanContext, QATurn } from '../types';

/* ================= Utilities ================ */
function extractJSON(text: string): any | null {
  const fence = /```json\s*([\s\S]*?)```/i.exec(text);
  if (fence) { try { return JSON.parse(fence[1]); } catch {} }
  const fb = text.indexOf('{');
  const lb = text.lastIndexOf('}');
  if (fb >= 0 && lb > fb) {
    const maybe = text.slice(fb, lb + 1);
    try { return JSON.parse(maybe); } catch {}
  }
  try { return JSON.parse(text); } catch {}
  return null;
}

function trimPack(pack: any) {
  const out: any = {};
  if (pack?.meta) out.meta = pack.meta;
  if (pack?.overview) out.overview = pack.overview;

  if (Array.isArray(pack?.vehicles)) {
    out.vehicles = pack.vehicles.map((v: any) => ({
      id: v.id, status: v.status, criticality: v.criticality
    })).slice(0, 200);
  }
  if (Array.isArray(pack?.workorders)) {
    out.workorders = pack.workorders.map((w: any) => ({
      id: w.id, vehicleId: w.vehicleId, title: w.title, type: w.type,
      priority: w.priority, status: w.status, start: w.start, end: w.end,
      hours: w.hours, requiredSkills: w.requiredSkills
    })).slice(0, 800);
  }
  if (Array.isArray(pack?.ops)) {
    out.ops = pack.ops.map((t: any) => ({
      id: t.id, vehicleId: t.vehicleId, title: t.title,
      start: t.start, end: t.end, demandHours: t.demandHours
    })).slice(0, 800);
  }
  if (Array.isArray(pack?.clashes)) out.clashes = pack.clashes.slice(0, 400);
  if (pack?.resources) {
    const r = pack.resources;
    out.resources = {
      technicians: (r.technicians || []).map((t: any) => ({ id: t.id, name: t.name, skills: t.skills })),
      availability: (r.availability || []).slice(0, 1000),
    };
  }
  if (pack?.guidance) out.guidance = pack.guidance;
  return out;
}

// Local “naive timezone” ISO (matches how your app renders dates)
function toISO(d: Date) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString();
}

// Parse “22 Aug”, “Aug 22”, “22/8”, “22-08-2025”, etc. Defaults to year 2025.
const MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
function parseDateLoose(s: string, defaultYear = 2025): Date | null {
  const txt = s.trim().replace(/[,]/g, '').toLowerCase();
  // 1) DD MMM (22 aug) or MMM DD (aug 22)
  const mA = /^(\d{1,2})\s+([a-z]{3,9})(?:\s+(\d{2,4}))?$/.exec(txt);
  if (mA) {
    const dd = +mA[1];
    const mi = MONTHS.findIndex(m => m === mA[2].slice(0,3));
    const yy = mA[3] ? +mA[3] : defaultYear;
    if (mi >= 0) { const d = new Date(yy, mi, dd); d.setHours(0,0,0,0); return isNaN(d.getTime())?null:d; }
  }
  const mB = /^([a-z]{3,9})\s+(\d{1,2})(?:\s+(\d{2,4}))?$/.exec(txt);
  if (mB) {
    const mi = MONTHS.findIndex(m => m === mB[1].slice(0,3));
    const dd = +mB[2];
    const yy = mB[3] ? +mB[3] : defaultYear;
    if (mi >= 0) { const d = new Date(yy, mi, dd); d.setHours(0,0,0,0); return isNaN(d.getTime())?null:d; }
  }
  // 2) DD/MM(/YYYY) or DD-MM(-YYYY)
  const mC = /^(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?$/.exec(txt);
  if (mC) {
    const dd = +mC[1], mm = +mC[2] - 1, yy = mC[3] ? +mC[3] : defaultYear;
    const d = new Date(yy, mm, dd); d.setHours(0,0,0,0); return isNaN(d.getTime())?null:d;
  }
  // 3) ISO-ish
  const iso = new Date(s);
  if (!isNaN(iso.getTime())) { iso.setHours(0,0,0,0); return iso; }
  return null;
}

function parseTimeLoose(s: string): { h: number; m: number } | null {
  const txt = s.trim().toLowerCase();
  const mer = /(am|pm)\s*$/.exec(txt)?.[1] as 'am' | 'pm' | undefined;
  const core = txt.replace(/\s*(am|pm)\s*$/i, '');
  const hm = /^(\d{1,2})(?::(\d{2}))?$/.exec(core);
  if (!hm) return null;
  let h = +hm[1], m = hm[2] ? +hm[2] : 0;
  if (mer === 'am') { if (h === 12) h = 0; }
  else if (mer === 'pm') { if (h < 12) h += 12; }
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return { h, m };
}

/** Try to directly understand common edit commands and return MUTATE. */
function quickParseEdits(userText: string): AgentDecision | null {
  const t = userText.trim();

  // MOVE WORKORDER  e.g. "move WO-011 to 09:00 on 22 Aug"
  {
    const m = /move\s+wo[-\s]?(\d+)\s+(?:to|at|start(?:\s+at)?)\s+([0-2]?\d(?::\d{2})?\s*(?:am|pm)?)\s+(?:on\s+)?([a-z]{3,9}\s+\d{1,2}(?:,\s*\d{2,4})?|\d{1,2}\s+[a-z]{3,9}(?:\s+\d{2,4})?|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?)/i.exec(t);
    if (m) {
      const id = `WO-${m[1].padStart(3,'0')}`;
      const time = parseTimeLoose(m[2]);
      const date = parseDateLoose(m[3], 2025);
      if (time && date) {
        const start = new Date(date); start.setHours(time.h, time.m, 0, 0);
        const answer = `Moving work order ${id} to ${start.toLocaleString()}.`;
        return ({ intent: 'MUTATE', answer } as any) as AgentDecision & { mutations: any[] };
      }
    }
  }

  // CANCEL WORKORDER  "cancel WO-011"
  {
    const m = /(cancel|delete)\s+wo[-\s]?(\d+)/i.exec(t);
    if (m) {
      const id = `WO-${m[2].padStart(3,'0')}`;
      return ({ intent: 'MUTATE', answer: `Cancelling work order ${id}.`, mutations: [{ op: 'CANCEL_WORKORDER', id }] } as any) as AgentDecision;
    }
  }

  // MOVE OPS  "move OPS-101 to 20:00 on 23 Aug"
  {
    const m = /move\s+ops[-\s]?(\d+)\s+(?:to|at)\s+([0-2]?\d(?::\d{2})?\s*(?:am|pm)?)\s+(?:on\s+)?([a-z]{3,9}\s+\d{1,2}(?:,\s*\d{2,4})?|\d{1,2}\s+[a-z]{3,9}(?:\s+\d{2,4})?|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?)/i.exec(t);
    if (m) {
      const id = `OPS-${m[1]}`;
      const time = parseTimeLoose(m[2]);
      const date = parseDateLoose(m[3], 2025);
      if (time && date) {
        const start = new Date(date); start.setHours(time.h, time.m, 0, 0);
        return ({ intent: 'MUTATE', answer: `Moving ops ${id} to ${start.toLocaleString()}.`, mutations: [{ op: 'MOVE_OPS', id, startISO: toISO(start) }] } as any) as AgentDecision;
      }
    }
  }

  // CANCEL OPS  "cancel OPS-101"
  {
    const m = /(cancel|delete)\s+ops[-\s]?(\d+)/i.exec(t);
    if (m) {
      const id = `OPS-${m[2]}`;
      return ({ intent: 'MUTATE', answer: `Cancelling ops ${id}.`, mutations: [{ op: 'CANCEL_OPS', id }] } as any) as AgentDecision;
    }
  }

  // GLOBAL OPTIMIZATION PLAN
  if (/08[:\.]?00|8\s*am/i.test(t) && /17[:\.]?00|5\s*pm/i.test(t) && /(ops|operat)/i.test(t)) {
    const policy = { businessHours: [8, 17], opsShiftDays: 1, avoidOpsOverlap: /overlap/i.test(t) };
    return ({ intent: 'PLAN', answer: 'Proposing day-time maintenance, ops shifted ±1 day with no overlaps.', policy } as any) as AgentDecision;
  }

  return null;
}

/* =================== Public API =================== */
export async function analyzeWithLLM(
  userText: string,
  knowledgePack: any,
  history: QATurn[] = [],
  planCtx?: PlanContext
): Promise<AgentDecision> {
  // 1) Try deterministic quick commands first (instant MUTATE/PLAN)
  const quick = quickParseEdits(userText);
  if (quick) {
    // If it was a MOVE_* without startISO computed (WO case), compute now:
    if ((quick as any).intent === 'MUTATE' && !(quick as any).mutations) {
      // We crafted only the answer above — now produce concrete mutation with parsed ISO.
      // Re-run a minimal parse dedicated to WO move to emit startISO.
      const m = /move\s+wo[-\s]?(\d+)\s+(?:to|at|start(?:\s+at)?)\s+([0-2]?\d(?::\d{2})?\s*(?:am|pm)?)\s+(?:on\s+)?([a-z]{3,9}\s+\d{1,2}(?:,\s*\d{2,4})?|\d{1,2}\s+[a-z]{3,9}(?:\s+\d{2,4})?|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?)/i.exec(userText);
      if (m) {
        const id = `WO-${m[1].padStart(3,'0')}`;
        const time = parseTimeLoose(m[2]);
        const date = parseDateLoose(m[3], 2025);
        if (time && date) {
          const start = new Date(date); start.setHours(time.h, time.m, 0, 0);
          return ({ intent: 'MUTATE', answer: (quick as any).answer, mutations: [{ op: 'MOVE_WORKORDER', id, startISO: toISO(start) }] } as any) as AgentDecision;
        }
      }
    }
    return quick;
  }

  // 2) Otherwise, call the LLM with your structured JSON contract
  const apiKey = import.meta.env.VITE_OPENAI_API_KEY as string | undefined;
  const SYSTEM = [
    'You are the Scheduler Agent for a heavy-vehicle fleet.',
    'Always respond with ONE JSON object, schema:',
    '{ "intent":"PLAN"|"MUTATE"|"QA", "answer":string, "policy":{ "businessHours":[number,number]|null, "opsShiftDays":number|null, "avoidOpsOverlap":boolean|null, "forVehicle":string|null }|null, "mutations":[ /* see docs */ ] }',
    'No prose outside JSON.',
  ].join('\n');

  const trimmed = trimPack(knowledgePack || {});
  const ctx = planCtx
    ? {
        lastAccepted: planCtx.lastAccepted
          ? { moved: planCtx.lastAccepted.moved, scheduled: planCtx.lastAccepted.scheduled, unscheduled: planCtx.lastAccepted.unscheduled }
          : null,
        preview: planCtx.preview
          ? { moved: planCtx.preview.moved, scheduled: planCtx.preview.scheduled, unscheduled: planCtx.preview.unscheduled }
          : null,
      }
    : null;

  const messages = [
    { role: 'system', content: SYSTEM },
    ...history.map(h => ({ role: h.role, content: h.text })),
    { role: 'user', content: ['User request:\n', userText.trim(), '\n\nPlan context (counts only):\n', JSON.stringify(ctx), '\n\nKnowledge (trimmed):\n', JSON.stringify(trimmed)].join('') },
  ];

  if (!apiKey) {
    return { intent: 'QA', answer: 'Connect an API key to enable full scheduling.' };
  }

  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini', temperature: 0.2, messages }),
    });
    if (!resp.ok) {
      const t = await resp.text();
      return { intent: 'QA', answer: `Scheduler LLM error: ${t.slice(0, 400)}` };
    }
    const data = await resp.json();
    const content: string = data?.choices?.[0]?.message?.content ?? '';
    const parsed = extractJSON(String(content));

    // Normalize & cast to fit your AgentDecision
    let intent: 'PLAN' | 'MUTATE' | 'QA' = 'QA';
    let answer: string | undefined;
    let policy: any | undefined;
    let mutations: any[] | undefined;

    if (parsed && typeof parsed === 'object') {
      const rawIntent = String(parsed.intent || 'QA').toUpperCase();
      intent = (rawIntent === 'PLAN' || rawIntent === 'MUTATE' || rawIntent === 'QA') ? rawIntent : 'QA';
      answer = typeof parsed.answer === 'string' ? parsed.answer : undefined;
      if (parsed.policy && typeof parsed.policy === 'object') {
        const bh = Array.isArray(parsed.policy.businessHours) ? parsed.policy.businessHours : null;
        const sd = typeof parsed.policy.opsShiftDays === 'number' ? parsed.policy.opsShiftDays : null;
        const ao = typeof parsed.policy.avoidOpsOverlap === 'boolean' ? parsed.policy.avoidOpsOverlap : null;
        const fv = typeof parsed.policy.forVehicle === 'string' ? parsed.policy.forVehicle : null;
        if (bh || sd !== null || ao !== null || fv) {
          policy = { ...(bh ? { businessHours: bh } : {}), ...(sd !== null ? { opsShiftDays: sd } : {}), ...(ao !== null ? { avoidOpsOverlap: ao } : {}), ...(fv ? { forVehicle: fv } : {}) };
        }
      }
      if (Array.isArray(parsed.mutations) && parsed.mutations.length) {
        mutations = parsed.mutations;
      }
    } else {
      // Model ignored schema — give a sensible PLAN
      intent = 'PLAN';
      answer = 'Optimizing 08:00–17:00; shift ops ±1 day; avoid overlaps.';
      policy = { businessHours: [8, 17], opsShiftDays: 1, avoidOpsOverlap: true };
    }

    const base: AgentDecision = { intent, answer };
    const extended = { ...base } as any;
    if (policy) extended.policy = policy;
    if (mutations) extended.mutations = mutations;
    return extended as AgentDecision;
  } catch (err: any) {
    return { intent: 'QA', answer: `Scheduler LLM request failed: ${err?.message ?? String(err)}` };
  }
}

/** Friendly hello */
export function helloSchedulerFact() {
  const facts = [
    'Try: “Optimize 08:00–17:00; shift ops ±1 day; avoid overlaps.”',
    'Say: “Move WO-011 to 09:00 on 22 Aug.”',
    'I can cancel ops: “Cancel OPS-103 on Wed.”',
  ];
  return facts[Math.floor(Math.random() * facts.length)];
}
