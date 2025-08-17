// src/agents/agentRuntime.ts
import type { AgentDecision, QATurn } from '../types';

/* =========================================================
   Scheduler Agent: lightweight NL → MUTATE actions
   - ADD_WORKORDER (create & schedule)
   - CANCEL_OPS_TASK (by id or by conflictsWith: WO-…)
   Anchored to the static demo week starting 22 Aug 2025.
   ========================================================= */

const DAY_MS = 86_400_000;
// Static anchor: 2025-08-22 local week. We compute calendar math off UTC
// then emit local "wall-clock" ISO strings without timezone suffix.
const DEMO_START_UTC = Date.UTC(2025, 7, 22, 0, 0, 0); // Aug is 7

function pad2(n: number) { return String(n).padStart(2, '0'); }
function ymdLocal(d: Date) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function localIso(ymd: string, hh = 8, mm = 0) {
  return `${ymd}T${pad2(hh)}:${pad2(mm)}:00`; // local, no Z
}
function pickDayYMD(dayOffset = 1) {
  const d = new Date(DEMO_START_UTC + dayOffset * DAY_MS);
  // Build a local YMD
  const ymd = ymdLocal(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0));
  return ymd;
}

// --- Tiny natural-language helpers (best-effort, robust to phrasing) ---
function extractVehicleId(text: string): string | null {
  const m = text.toUpperCase().match(/\bV(\d{3})\b/);
  return m ? `V${m[1]}` : null;
}
function extractHours(text: string): number | null {
  const m = text.match(/(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\b/i);
  return m ? Math.max(0.25, parseFloat(m[1])) : null;
}
function extractPriority(text: string): 'Low' | 'Medium' | 'High' | 'Critical' | null {
  if (/critical/i.test(text)) return 'Critical';
  if (/high/i.test(text)) return 'High';
  if (/medium|med\b/i.test(text)) return 'Medium';
  if (/low/i.test(text)) return 'Low';
  return null;
}
function extractWhen(text: string): { start: string; end: string } {
  // Defaults: tomorrow 08:00 for 1h
  let dayOffset = /today/i.test(text) ? 0
    : /day after tomorrow|in\s*2\s*days/i.test(text) ? 2
    : /tomorrow/i.test(text) ? 1
    : 1;

  const hours = extractHours(text) ?? 1;

  // Optional crude time extraction (e.g., "at 10", "10:30", "10am")
  let hh = 8, mm = 0;
  const t1 = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (t1) {
    hh = parseInt(t1[1], 10);
    mm = t1[2] ? parseInt(t1[2]) : 0;
    const ampm = (t1[3] || '').toLowerCase();
    if (ampm === 'pm' && hh < 12) hh += 12;
    if (ampm === 'am' && hh === 12) hh = 0;
  }

  const ymd = pickDayYMD(dayOffset);
  const start = localIso(ymd, hh, mm);
  const end = localIso(ymd, hh + Math.floor(hours), (mm + (hours % 1) * 60) % 60);
  return { start, end };
}

function titleFromText(text: string): string {
  // Prefer explicit, else fall back to Thermostat Inspection for this demo
  if (/thermostat/i.test(text)) return 'Thermostat Inspection';
  if (/inspection/i.test(text)) return 'Inspection';
  if (/service/i.test(text)) return 'Service';
  if (/diagnos/i.test(text)) return 'Diagnostics';
  return 'Thermostat Inspection';
}
function skillsFromText(text: string): string[] {
  if (/elect/i.test(text)) return ['AutoElec'];
  if (/mechanic|mech/i.test(text)) return ['Mechanic'];
  // Default skill for this demo
  return ['Mechanic'];
}
function priorityFromText(text: string): 'Low' | 'Medium' | 'High' | 'Critical' {
  return extractPriority(text) ?? 'Medium';
}
function typeFromText(text: string): 'Preventive' | 'Corrective' {
  if (/prevent/i.test(text)) return 'Preventive';
  if (/correct|react/i.test(text)) return 'Corrective';
  // For inspections we prefer Preventive in this demo flow
  return /inspection/i.test(text) ? 'Preventive' : 'Corrective';
}
function subsystemFromText(text: string): string | undefined {
  if (/thermostat|cool/i.test(text)) return 'cooling';
  if (/engine/i.test(text)) return 'engine';
  if (/transmission|gear/i.test(text)) return 'transmission';
  if (/elect/i.test(text)) return 'electrical';
  return undefined;
}

// Random fun fact for the hello button
const FACTS = [
  'Tip: pack maintenance into low-demand windows before ops tasks land.',
  'You can ask me to “cancel the ops task that conflicts with WO-…”.',
  'Try “Create and schedule a 1-hour Thermostat Inspection for V012 tomorrow 8am.”',
  'I can add work orders and immediately propose a new plan — just say “schedule an inspection for V007”.',
];
export function helloSchedulerFact(): string {
  return FACTS[Math.floor(Math.random() * FACTS.length)];
}

/**
 * Main entry used by Dashboard for the Scheduler agent.
 * Returns QA (text only), SUGGEST (policy), or MUTATE (list of mutations).
 */
export async function analyzeWithLLM(
  userText: string,
  _knowledgePack: any,
  _history: QATurn[] = [],
  _planCtx?: any
): Promise<AgentDecision> {
  // ---- 1) Create & schedule an inspection work order ----
  // e.g. "create/schedule/add ... inspection ... for V012 ... [tomorrow 8am] [1h] [mechanic] [medium]"
  if (/(create|add|schedule).*(inspection|service|diagnos)/i.test(userText)) {
    const vehicleId = extractVehicleId(userText) ?? 'V012'; // default useful demo id
    const hours = extractHours(userText) ?? 1;
    const { start, end } = extractWhen(userText);
    const title = titleFromText(userText);
    const reqSkills = skillsFromText(userText);
    const prio = priorityFromText(userText);
    const subsystem = subsystemFromText(userText);

    // Generate a readable id — stable per vehicle+title within demo week
    const base = `${title}`.replace(/\s+/g, '').toUpperCase().slice(0, 12);
    const id = `WO-${base}-${vehicleId}`;

    // NOTE: we include BOTH 'op' and 'type', and cast as any[] to satisfy differing type defs
    const mutations = [
      {
        op: 'ADD_WORKORDER',
        type: 'ADD_WORKORDER',
        workorder: {
          id,
          vehicleId,
          title,
          type: typeFromText(userText),
          priority: prio,
          requiredSkills: reqSkills,
          hours,
          start,
          end,
          status: 'Scheduled',
          subsystem
        }
      }
    ] as any[];

    return {
      intent: 'MUTATE',
      answer: `Created and scheduled **${id}** on ${vehicleId}: ${title} (${hours}h, ${prio}, ${reqSkills.join('/')}). I’ll propose an updated plan.`,
      mutations
    };
  }

  // ---- 2) Cancel operational task that conflicts with a WO ----
  // e.g. "cancel the ops task that conflicts with WO-INSPECT-V012"
  if (/cancel.*(op|ops).*(task)/i.test(userText) && /wo[- ]?[a-z0-9]+/i.test(userText)) {
    const wo = userText.match(/wo[- ]?[a-z0-9]+/i)?.[0].replace(/\s+/g, '').toUpperCase();

    const mutations = [
      wo
        ? { op: 'CANCEL_OPS_TASK', type: 'CANCEL_OPS_TASK', conflictsWith: wo }
        : { op: 'CANCEL_OPS_TASK', type: 'CANCEL_OPS_TASK' }
    ] as any[];

    return {
      intent: 'MUTATE',
      answer: `I’ll cancel the operational task that conflicts with **${wo ?? 'the specified WO'}** and refresh the schedule.`,
      mutations
    };
  }

  // ---- 3) Direct cancel by ops id ----
  // e.g. "cancel OP-1234"
  if (/cancel\b.*\bop[- ]?\d+/i.test(userText)) {
    const opId = userText.match(/\bop[- ]?\d+/i)?.[0].replace(' ', '').toUpperCase();

    const mutations = [
      { op: 'CANCEL_OPS_TASK', type: 'CANCEL_OPS_TASK', id: opId }
    ] as any[];

    return {
      intent: 'MUTATE',
      answer: `Cancelling operational task **${opId}** and updating the plan.`,
      mutations
    };
  }

  // ---- 4) Guidance (fallback) ----
  return {
    intent: 'QA',
    answer:
`I can modify the plan. Try:
• “Create and schedule a 1-hour Thermostat Inspection for V012 tomorrow 8am (Medium, Mechanic).”
• “Cancel the operational task that conflicts with WO-THERMOSTATINS-V012.”`
  };
}
