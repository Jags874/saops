// src/agents/agentRuntime.ts
import type { AgentDecision, QATurn, PlanContext } from '../types';
import { buildKnowledgePack, WEEK_START_ISO } from './context';

// ----------------- OpenAI call helper (Responses API) -----------------
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
      temperature: 0.2,
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

// ----------------- Date helpers (anchor: 22 Aug 2025) -----------------
const MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
function pad(n: number) { return String(n).padStart(2, '0'); }

function firstISOOrNull(s?: string): string | null {
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) {
    const d = new Date(s);
    if (isNaN(d.getTime())) return null;
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
  }
  const t = s.trim().toLowerCase().replace(/\s+/g, ' ');
  let m = t.match(/(\d{4})-(\d{2})-(\d{2})[ t](\d{1,2}):(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}T${pad(+m[4])}:${m[5]}:00`;

  const anchorYear = new Date(WEEK_START_ISO).getFullYear();
  m = t.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*on)?\s*(\d{1,2})\s*([a-z]{3,})/i);
  if (m) {
    let hh = +m[1]; const mm = m[2] ? +m[2] : 0; const ap = m[3];
    const day = +m[4]; const monTxt = m[5].slice(0,3);
    const mi = MONTHS.indexOf(monTxt);
    if (ap) { const apL = ap.toLowerCase(); if (apL === 'pm' && hh < 12) hh += 12; if (apL === 'am' && hh === 12) hh = 0; }
    if (mi >= 0 && day >= 1 && day <= 31) return `${anchorYear}-${pad(mi+1)}-${pad(day)}T${pad(hh)}:${pad(mm)}:00`;
  }
  m = t.match(/(\d{1,2})\s*([a-z]{3,})\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (m) {
    const day = +m[1]; const mi = MONTHS.indexOf(m[2].slice(0,3));
    let hh = +m[3]; const mm = m[4] ? +m[4] : 0; const ap = m[5];
    const anchorYear2 = new Date(WEEK_START_ISO).getFullYear();
    if (ap) { const apL = ap.toLowerCase(); if (apL === 'pm' && hh < 12) hh += 12; if (apL === 'am' && hh === 12) hh = 0; }
    if (mi >= 0 && day >= 1 && day <= 31) return `${anchorYear2}-${pad(mi+1)}-${pad(day)}T${pad(hh)}:${pad(mm)}:00`;
  }
  const d = new Date(s); if (!isNaN(d.getTime())) return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
  return null;
}

function hoursBetweenISO(start: string, end: string): number {
  const s = new Date(start).getTime(); const e = new Date(end).getTime();
  if (!isFinite(s) || !isFinite(e) || e <= s) return 1;
  return (e - s) / 36e5;
}

function ymd(d: Date) { return d.toISOString().slice(0,10); }
function startOfDayISO(iso: string) {
  const d = new Date(iso); d.setHours(0,0,0,0);
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T00:00:00`;
}
function addDaysISO(iso: string, days: number) {
  const d = new Date(iso); d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}

// ----------------- Deterministic fallbacks -----------------
function detectMoveWorkOrder(text: string) {
  const m = text.match(/move\s+(wo[-\s]?(\d+))/i);
  if (!m) return null;
  const woId = `WO-${m[2]}`;
  const when = text.match(/(?:to|at|start(?:ing)? (?:at)?)\s+([^.,\n]+)$/i)?.[1] ?? text;
  const iso = firstISOOrNull(when);
  return { woId, startISO: iso };
}

function isNightShiftOps(text: string) {
  return /(move|shift|reschedul\w*).*(all\s+)?ops?(\s+tasks?)?.*(night|evening|20:00|after.*hours)/i.test(text);
}

function isOptimizeWeek(text: string) {
  return /(optimi[sz]e|plan|reflow|re-arrange).*(week|this week)/i.test(text) &&
         /(business\s*hours|08:00|9:00|day)/i.test(text) &&
         /(ops|operations).*(\+|-|±|plus|minus|shift).*(day|days)/i.test(text);
}

// Compute “move ops to 20:00” mutations with ±1 day spillover (no overlaps per vehicle)
function computeNightMoves(pack: ReturnType<typeof buildKnowledgePack>, startHour = 20) {
  const weekStart = WEEK_START_ISO.slice(0,10); // "2025-08-22"
  const horizon = pack.meta.horizonDays ?? 7;
  const byVehicle = new Map<string, any[]>();
  for (const t of pack.opsTasks) {
    const opsId = (t as any).opsId ?? (t as any).opsID ?? t.id;
    if (!opsId || !t.vehicleId) continue;
    const s = t.start, e = t.end;
    const hours = (s && e) ? hoursBetweenISO(s, e) : 3;
    const dayISO = s ? startOfDayISO(s) : `${weekStart}T00:00:00`;
    const arr = byVehicle.get(t.vehicleId) ?? [];
    arr.push({ opsId, vehicleId: t.vehicleId, dayISO, hours });
    byVehicle.set(t.vehicleId, arr);
  }

  const mutations: any[] = [];
  for (const [vid, rows] of byVehicle.entries()) {
    // For each vehicle, map of dayIndex -> occupied segments (so we stack)
    const occupied = new Map<number, Array<{start:number; end:number}>>();

    function placeOnDay(dayIdx: number, hours: number): { startISO: string; endISO: string } | null {
      if (dayIdx < 0 || dayIdx >= horizon) return null;
      const day = new Date(`${weekStart}T00:00:00`);
      day.setDate(day.getDate() + dayIdx);
      const startISO = `${day.getFullYear()}-${pad(day.getMonth()+1)}-${pad(day.getDate())}T${pad(startHour)}:00:00`;
      const durMs = hours * 36e5;
      // stack if something already placed this night
      const segs = occupied.get(dayIdx) ?? [];
      let cursor = new Date(startISO).getTime();
      if (segs.length) {
        // push to the end of last segment (simple stacking)
        const last = segs[segs.length-1];
        cursor = Math.max(cursor, last.end);
      }
      const end = cursor + durMs;
      // cap within same night: allow up to 23:59
      const hardEnd = new Date(`${day.getFullYear()}-${pad(day.getMonth()+1)}-${pad(day.getDate())}T23:59:00`).getTime();
      if (end > hardEnd) return null; // too long to fit tonight
      segs.push({ start: cursor, end });
      occupied.set(dayIdx, segs);
      const sISO = new Date(cursor).toISOString().slice(0,19);
      const eISO = new Date(end).toISOString().slice(0,19);
      return { startISO: sISO, endISO: eISO };
    }

    function dayIndexFromISO(dayISO: string): number {
      const base = new Date(`${weekStart}T00:00:00`);
      const cur  = new Date(dayISO);
      const dif  = Math.round((cur.getTime() - base.getTime()) / 86400000);
      return Math.max(0, Math.min(horizon-1, dif));
    }

    for (const r of rows) {
      const baseIdx = dayIndexFromISO(r.dayISO);
      // try base day, then +1, then -1
      const choices = [baseIdx, baseIdx+1, baseIdx-1].filter((x, i, a) => a.indexOf(x) === i);
      let placed = null as null | { startISO: string; endISO: string };
      for (const idx of choices) {
        placed = placeOnDay(idx, r.hours);
        if (placed) break;
      }
      if (!placed) {
        // last resort: scan week forwards
        for (let j = 0; j < horizon; j++) {
          placed = placeOnDay(j, r.hours);
          if (placed) break;
        }
      }
      if (placed) {
        mutations.push({
          op: 'MOVE_OPS',
          opsId: r.opsId,
          vehicleId: vid,
          startISO: placed.startISO,
          endISO:   placed.endISO
        });
      }
    }
  }
  return mutations;
}

// ----------------- Public: scheduler brain -----------------
export async function analyzeWithLLM(
  userText: string,
  pack: ReturnType<typeof buildKnowledgePack>,
  history: QATurn[],
  planCtx?: PlanContext
): Promise<AgentDecision> {

  // 0) Deterministic special intents
  if (isNightShiftOps(userText) || isOptimizeWeek(userText)) {
    const muts = computeNightMoves(pack, 20);
    const note = isOptimizeWeek(userText)
      ? 'Moved ops to nights (±1 day) to open business hours. Click “Suggest” to reflow maintenance into 08:00–17:00.'
      : 'Moved ops to nights (±1 day) per request.';
    return { intent: 'MUTATE', mutations: muts, answer: note };
  }

  // 1) Deterministic fallback for “move WO-011 …”
  const mv = detectMoveWorkOrder(userText);
  if (mv) {
    if (!mv.startISO) {
      return { intent: 'QA', answer: `I understood the work order (${mv.woId}) but couldn’t parse the new start. Try “Move ${mv.woId} to 2025-08-22T08:00”.` };
    }
    return { intent: 'MUTATE', mutations: [{ op: 'MOVE_WORKORDER', woId: mv.woId, startISO: mv.startISO }] };
  }

  // 2) Ask the model — with clear policy to *not* block creates due to conflicts
  const sys = `
You are a Scheduler Agent for a transport fleet.

You may respond in two ways:
1) Natural-language answer (short), OR
2) A JSON with "mutations" only (see schema). Do NOT include extra keys.

Schema:
{
  "mutations": [
    {
      "op": "MOVE_WORKORDER" | "ADD_WORKORDER" | "CANCEL_WORKORDER" | "MOVE_OPS" | "CANCEL_OPS",
      "woId": "WO-011",
      "opsId": "OPS-001",
      "vehicleId": "V012",
      "startISO": "YYYY-MM-DDTHH:mm:ss",
      "endISO":   "YYYY-MM-DDTHH:mm:ss",
      "hours": 1.5,
      "title": "Thermostat Inspection",
      "type": "CM" | "PM",
      "priority": "High" | "Medium" | "Low",
      "requiredSkills": ["Mechanic"]
    }
  ],
  "explanation": "short rationale"
}

Rules:
- Anchor week starts at ${WEEK_START_ISO.slice(0,10)} — normalize partial times like "8:00 on 22 Aug" to ISO (no timezone suffix).
- Never refuse to ADD_WORKORDER because of a conflict; create it anyway. Conflict resolution is separate.
- Treat provided workorders/ops tasks as the current truth (e.g., if WO-011 shows 14:00, use that).
- If the user says “optimize/reschedule/plan the week”, prefer to move ops to **20:00** and allow ±1 day shifting to free 08:00–17:00 for maintenance, then say: “Click **Suggest** to reflow maintenance.”`;

  const facts = {
    meta: pack.meta,
    workorders: pack.workorders.map(w => ({
      id: w.id, vehicleId: w.vehicleId, title: w.title, status: w.status,
      start: w.start, end: w.end, hours: w.hours, type: w.type, priority: w.priority
    })),
    opsTasks: pack.opsTasks.map(t => ({
      id: (t as any).opsId ?? (t as any).opsID ?? t.id,
      vehicleId: t.vehicleId, title: t.title, start: t.start, end: t.end
    })),
    overlaps: pack.facts,
    planCtx
  };

  const prompt = `${sys}

--- DATA ---
${JSON.stringify(facts, null, 2)}

--- HISTORY ---
${history.map(h => `${h.role.toUpperCase()}: ${h.text}`).join('\n')}

--- USER ---
${userText}

Respond with either a short answer or a JSON "mutations" block.`;

  const raw = await callOpenAI(prompt);

  // Try to extract "mutations" JSON
  const jsonMatch = raw.match(/\{[\s\S]*"mutations"[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]);
      const muts = Array.isArray(obj.mutations) ? obj.mutations : [];
      for (const m of muts) {
        if (typeof m.startISO === 'string') m.startISO = firstISOOrNull(m.startISO);
        if (typeof m.endISO === 'string')   m.endISO   = firstISOOrNull(m.endISO);
      }
      return { intent: 'MUTATE', mutations: muts, answer: obj.explanation || undefined };
    } catch {
      // fall through to text
    }
  }

  // Otherwise return whatever the model said
  return { intent: 'QA', answer: raw };
}

// Friendly hello
export function helloSchedulerFact(): string {
  return 'Hello 👋 — Scheduler Agent ready. I can move WOs, cancel ops, or shift all ops to 20:00 (±1 day) so you can reflow maintenance into 08:00–17:00.';
}
