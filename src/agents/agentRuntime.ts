// src/agents/agentRuntime.ts
import type { AgentDecision, PlanContext, QATurn, SchedulerPolicy } from '../types';

/* ============== general helpers ============== */
function extractJSON(text: string): any | null {
  const fence = /```json\s*([\s\S]*?)```/i.exec(text);
  if (fence) { try { return JSON.parse(fence[1]); } catch {} }
  const fb = text.indexOf('{'); const lb = text.lastIndexOf('}');
  if (fb >= 0 && lb > fb) { try { return JSON.parse(text.slice(fb, lb + 1)); } catch {} }
  try { return JSON.parse(text); } catch {}
  return null;
}

function toLocalISO(d: Date) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString();
}

const MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
function parseDateLoose(s: string, defaultYear = 2025): Date | null {
  const txt = s.trim().replace(/[,]/g, '').toLowerCase();

  const mA = /^(\d{1,2})\s+([a-z]{3,9})(?:\s+(\d{2,4}))?$/.exec(txt); // 22 aug [2025]
  if (mA) {
    const dd = +mA[1];
    const mi = MONTHS.findIndex(m => m === mA[2].slice(0, 3));
    const yy = mA[3] ? +mA[3] : defaultYear;
    if (mi >= 0) { const d = new Date(yy, mi, dd); d.setHours(0,0,0,0); return isNaN(d.getTime()) ? null : d; }
  }

  const mB = /^([a-z]{3,9})\s+(\d{1,2})(?:\s+(\d{2,4}))?$/.exec(txt); // aug 22 [2025]
  if (mB) {
    const mi = MONTHS.findIndex(m => m === mB[1].slice(0, 3));
    const dd = +mB[2];
    const yy = mB[3] ? +mB[3] : defaultYear;
    if (mi >= 0) { const d = new Date(yy, mi, dd); d.setHours(0,0,0,0); return isNaN(d.getTime()) ? null : d; }
  }

  const mC = /^(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?$/.exec(txt); // 22/8[/2025]
  if (mC) {
    const dd = +mC[1], mm = +mC[2] - 1, yy = mC[3] ? +mC[3] : defaultYear;
    const d = new Date(yy, mm, dd); d.setHours(0,0,0,0); return isNaN(d.getTime()) ? null : d;
  }

  const iso = new Date(s);
  if (!isNaN(iso.getTime())) { iso.setHours(0,0,0,0); return iso; }
  return null;
}

function parseTimeLoose(s: string): { h: number; m: number } | null {
  const txt = s.trim().toLowerCase();
  const mer = /(am|pm)\s*$/.exec(txt)?.[1] as 'am'|'pm'|undefined;
  const core = txt.replace(/\s*(am|pm)\s*$/i, '');
  const hm = /^(\d{1,2})(?::(\d{2}))?$/.exec(core);
  if (!hm) return null;
  let h = +hm[1], m = hm[2] ? +hm[2] : 0;
  if (mer === 'am' && h === 12) h = 0;
  if (mer === 'pm' && h < 12) h += 12;
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return { h, m };
}

function normWoId(s: string)  { const n = s.replace(/\D+/g, ''); return `WO-${n.padStart(3, '0')}`; }
function normOpsId(s: string) { const n = s.replace(/\D+/g, ''); return `OPS-${n}`; }

/** shrink the pack for the LLM */
function trimPack(pack: any) {
  const out: any = {};
  if (pack?.overview) out.overview = pack.overview;
  if (Array.isArray(pack?.vehicles)) out.vehicles = pack.vehicles.map((v:any)=>({id:v.id,status:v.status,criticality:v.criticality})).slice(0,200);
  if (Array.isArray(pack?.workorders)) out.workorders = pack.workorders.map((w:any)=>({id:w.id,vehicleId:w.vehicleId,title:w.title,type:w.type,priority:w.priority,status:w.status,start:w.start,end:w.end,hours:w.hours,requiredSkills:w.requiredSkills})).slice(0,800);
  if (Array.isArray(pack?.ops)) out.ops = pack.ops.map((t:any)=>({id:t.id,vehicleId:t.vehicleId,title:t.title,start:t.start,end:t.end,demandHours:t.demandHours})).slice(0,800);
  if (pack?.resources) out.resources = { technicians:(pack.resources.technicians||[]).map((t:any)=>({id:t.id,name:t.name,skills:t.skills})), availability:(pack.resources.availability||[]).slice(0,1000) };
  if (Array.isArray(pack?.clashes)) out.clashes = pack.clashes.slice(0,400);
  if (pack?.guidance) out.guidance = pack.guidance;
  return out;
}

/** map synonyms → engine mutation names/fields your store expects */
function mapToEngineOps(muts: any[]): any[] {
  return (muts || []).map(m => {
    const opRaw = String(m.op || m.OP || m.action || '').toUpperCase();
    const copy: any = { ...m };
    if ('startISO' in copy && !('start' in copy)) copy.start = copy.startISO;
    if ('endISO'   in copy && !('end'   in copy)) copy.end   = copy.endISO;

    if (opRaw === 'MOVE_WORKORDER' || opRaw === 'MOVE_WO')        copy.op = 'MOVE_WO';
    else if (opRaw === 'CANCEL_WORKORDER' || opRaw === 'CANCEL_WO') copy.op = 'CANCEL_WO';
    else if (opRaw === 'ADD_WORKORDER' || opRaw === 'ADD_WO')      copy.op = 'ADD_WO';
    else if (opRaw === 'MOVE_OPS')                                  copy.op = 'MOVE_OPS';
    else if (opRaw === 'CANCEL_OPS')                                copy.op = 'CANCEL_OPS';
    else if (opRaw === 'ADD_TECH' || opRaw === 'ADD_TECHNICIAN')   copy.op = 'ADD_TECH';
    else if (opRaw === 'SET_AVAIL' || opRaw === 'SET_AVAILABILITY') copy.op = 'SET_AVAIL';
    else copy.op = opRaw;
    return copy;
  });
}

/* ============== deterministic command parser (pre-LLM) ============== */
function quickParse(userText: string, pack: any): AgentDecision | null {
  const t = userText.trim();

  // MOVE WO-###
  {
    const m = /move\s+wo[-\s]?(\d+)\s+(?:to|at|start(?:\s+at)?)\s+([0-2]?\d(?::\d{2})?\s*(?:am|pm)?)\s+(?:on\s+)?([a-z]{3,9}\s+\d{1,2}(?:,\s*\d{2,4})?|\d{1,2}\s+[a-z]{3,9}(?:\s+\d{2,4})?|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?)/i.exec(t);
    if (m) {
      const id = normWoId(m[1]);
      const time = parseTimeLoose(m[2]); const date = parseDateLoose(m[3], 2025);
      if (!time || !date) return { intent: 'QA', answer: 'I couldn’t parse the time/date. Try: “Move WO-011 to 09:00 on 22 Aug”.' };
      const start = new Date(date); start.setHours(time.h, time.m, 0, 0);
      const exists = (pack?.workorders || []).some((w:any) => w.id === id);
      if (!exists) return { intent: 'QA', answer: `I can’t find ${id}. Check the ID and try again.` };
      return { intent: 'MUTATE', answer: `Moving ${id} to ${start.toLocaleString()}.`, mutations: mapToEngineOps([{ op: 'MOVE_WO', id, start: toLocalISO(start) }]) } as any;
    }
  }

  // CANCEL WO-###
  {
    const m = /(cancel|delete)\s+wo[-\s]?(\d+)/i.exec(t);
    if (m) {
      const id = normWoId(m[2]);
      const exists = (pack?.workorders || []).some((w:any) => w.id === id);
      if (!exists) return { intent: 'QA', answer: `I can’t find ${id}.` };
      return { intent: 'MUTATE', answer: `Cancelling ${id}.`, mutations: mapToEngineOps([{ op: 'CANCEL_WO', id }]) } as any;
    }
  }

  // MOVE OPS-###
  {
    const m = /move\s+ops[-\s]?(\d+)\s+(?:to|at)\s+([0-2]?\d(?::\d{2})?\s*(?:am|pm)?)\s+(?:on\s+)?([a-z]{3,9}\s+\d{1,2}(?:,\s*\d{2,4})?|\d{1,2}\s+[a-z]{3,9}(?:\s+\d{2,4})?|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?)/i.exec(t);
    if (m) {
      const id = normOpsId(m[1]);
      const time = parseTimeLoose(m[2]); const date = parseDateLoose(m[3], 2025);
      if (!time || !date) return { intent: 'QA', answer: 'I couldn’t parse the time/date for the OPS move.' };
      const start = new Date(date); start.setHours(time.h, time.m, 0, 0);
      const exists = (pack?.ops || []).some((o:any) => o.id === id);
      if (!exists) return { intent: 'QA', answer: `I can’t find ${id}.` };
      return { intent: 'MUTATE', answer: `Moving ${id} to ${start.toLocaleString()}.`, mutations: mapToEngineOps([{ op: 'MOVE_OPS', id, start: toLocalISO(start) }]) } as any;
    }
  }

  // CANCEL OPS-###
  {
    const m = /(cancel|delete)\s+ops[-\s]?(\d+)/i.exec(t);
    if (m) {
      const id = normOpsId(m[2]);
      const exists = (pack?.ops || []).some((o:any) => o.id === id);
      if (!exists) return { intent: 'QA', answer: `I can’t find ${id}.` };
      return { intent: 'MUTATE', answer: `Cancelling ${id}.`, mutations: mapToEngineOps([{ op: 'CANCEL_OPS', id }]) } as any;
    }
  }

  // Vehicle-scoped reflow (PLAN)
  if (/for\s+v0*\d{1,3}/i.test(t) && /move\s+all\s+maintenance/i.test(t)) {
    const vMatch = /for\s+(v0*\d{1,3})/i.exec(t);
    if (!vMatch) return null;
    const v = vMatch[1].toUpperCase();
    const dMatch = /to\s+([a-z]{3,9}\s+\d{1,2}|\d{1,2}\s+[a-z]{3,9}|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?)/i.exec(t);
    const date = dMatch ? parseDateLoose(dMatch[1], 2025) : null;
    const policy: SchedulerPolicy = { businessHours: [8, 17], opsShiftDays: 1, avoidOpsOverlap: true, forVehicle: v };
    const answer = date
      ? `Proposing for ${v}: maintenance 08:00–17:00 on/around ${date.toDateString()}, shift ops ±1 day, avoid overlaps.`
      : `Proposing for ${v}: maintenance 08:00–17:00, shift ops ±1 day, avoid overlaps.`;
    return { intent: 'PLAN', answer, policy } as any;
  }

  // Global optimization (PLAN)
  if (/(08[:\.]?00|8\s*am).*(17[:\.]?00|5\s*pm)/i.test(t) && /(ops|operat)/i.test(t)) {
    const policy: SchedulerPolicy = { businessHours: [8, 17], opsShiftDays: 1, avoidOpsOverlap: /overlap/i.test(t) };
    return { intent: 'PLAN', answer: 'Proposing 08:00–17:00 maintenance; shift ops ±1 day; avoid overlaps.', policy } as any;
  }

  return null;
}

/* ============== public API ============== */
export async function analyzeWithLLM(
  userText: string,
  knowledgePack: any,
  history: QATurn[] = [],
  planCtx?: PlanContext
): Promise<AgentDecision> {
  const pack = trimPack(knowledgePack || {});
  const quick = quickParse(userText, pack);
  if (quick) return quick;

  const apiKey = import.meta.env.VITE_OPENAI_API_KEY as string | undefined;
  if (!apiKey) return { intent: 'QA', answer: 'No API key configured. Set VITE_OPENAI_API_KEY to enable scheduling.' };

  const SYSTEM = [
    'You are the Scheduler Agent for a heavy-vehicle fleet.',
    'Return exactly ONE JSON object:',
    '{ "intent":"PLAN"|"MUTATE"|"QA", "answer":string, "policy":{ "businessHours":[number,number]|null, "opsShiftDays":number|null, "avoidOpsOverlap":boolean|null, "forVehicle":string|null }|null, "mutations":[ /* MOVE_WO, CANCEL_WO, MOVE_OPS, CANCEL_OPS, ADD_WO, ADD_TECH, SET_AVAIL */ ] }',
    'No prose outside JSON.',
  ].join('\n');

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
    { role: 'user', content: `User request:\n${userText}\n\nPlan context (counts only):\n${JSON.stringify(ctx)}\n\nKnowledge (trimmed):\n${JSON.stringify(pack)}` },
  ];

  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini', temperature: 0.2, messages }),
    });
    if (!resp.ok) return { intent: 'QA', answer: `Scheduler LLM error: ${(await resp.text()).slice(0, 400)}` };

    const data = await resp.json();
    const content: string = data?.choices?.[0]?.message?.content ?? '';
    const parsed = extractJSON(content);

    let intent: 'PLAN' | 'MUTATE' | 'QA' = 'QA';
    let answer: string | undefined;
    let policy: SchedulerPolicy | undefined;
    let mutations: any[] | undefined;

    if (parsed && typeof parsed === 'object') {
      intent = (String(parsed.intent || 'QA').toUpperCase() as any);
      answer = typeof parsed.answer === 'string' ? parsed.answer : undefined;

      if (parsed.policy && typeof parsed.policy === 'object') {
        const p: any = {};
        if (Array.isArray(parsed.policy.businessHours)) p.businessHours = parsed.policy.businessHours;
        if (typeof parsed.policy.opsShiftDays === 'number') p.opsShiftDays = parsed.policy.opsShiftDays;
        if (typeof parsed.policy.avoidOpsOverlap === 'boolean') p.avoidOpsOverlap = parsed.policy.avoidOpsOverlap;
        if (typeof parsed.policy.forVehicle === 'string') p.forVehicle = parsed.policy.forVehicle;
        if (Object.keys(p).length) policy = p;
      }

      if (Array.isArray(parsed.mutations) && parsed.mutations.length) {
        mutations = mapToEngineOps(parsed.mutations);
      }
    } else {
      intent = 'PLAN';
      answer = 'Optimizing 08:00–17:00; shift ops ±1 day; avoid overlaps.';
      policy = { businessHours: [8, 17], opsShiftDays: 1, avoidOpsOverlap: true };
    }

    const base: AgentDecision = { intent, answer };
    if (policy) (base as any).policy = policy;
    if (mutations) (base as any).mutations = mutations;
    return base;
  } catch (err: any) {
    return { intent: 'QA', answer: `Scheduler LLM request failed: ${err?.message ?? String(err)}` };
  }
}

/** Friendly hello for the Scheduler card */
export function helloSchedulerFact() {
  const facts = [
    'Try: “Optimize 08:00–17:00; shift ops ±1 day; avoid overlaps.”',
    'Say: “Move WO-011 to 09:00 on 22 Aug.”',
    'You can: “Cancel OPS-103 on Thu.” or “For V005, reflow maintenance to 22 Aug.”',
  ];
  return facts[Math.floor(Math.random() * facts.length)];
}
