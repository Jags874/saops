// src/agents/reliability.ts
import type { QATurn, AgentDecision } from '../types';
import { getVehicles, getWorkOrders, getPMTasks, getFailures } from '../data/adapter';

// … keep the rest exactly as in my last message …

export type ReliabilityPack = {
  about: { role: string; guidance: string[]; schemaNotes: string[] };
  window: { generatedAt: string; weeksIncluded: number; lookbackDays: number };
  datasets: {
    vehicles: Array<{ id: string; model?: string; year?: number; criticality?: string | number }>;
    workorders: Array<{ id: string; vehicleId: string; type: string; subsystem?: string; status: string; created?: string }>;
    pm: Array<{ id: string; title: string; subsystem?: string; interval?: string }>;
    failures: Array<{ vehicleId: string; subsystem: string; failure_mode?: string; date: string }>;
    weeklyFailureSeries: Array<{ vehicleId: string; weekStart: string; count: number }>;
    repeatedFailures: Array<{ vehicleId: string; subsystem?: string; failure_mode?: string; count: number }>;
    relatedBySubsystem: Array<{ subsystem: string; vehicles: string[]; count: number }>;
    emergingFailures: Array<{ failure_mode?: string; first_seen: string; vehicles: string[] }>;
    trendSignals: Array<{ vehicleId: string; last3: number; prev3: number; pctChange: number }>;
    mtbfByVehicle: Array<{ vehicleId: string; failures: number; spanDays: number; mtbfDays: number }>;
    pmCoverageGaps: Array<{ subsystem: string; hasPM: boolean; notes: string }>;
  };
};

function startOfWeek(d: Date) {
  const x = new Date(d); const day = x.getDay(); // 0=Sun
  const diff = (day + 6) % 7; // Monday start
  x.setDate(x.getDate() - diff); x.setHours(0,0,0,0);
  return x;
}
const ymd = (d: Date) => d.toISOString().slice(0,10);
const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));

export function buildReliabilityPack(weeks = 26, lookbackDays = 180): ReliabilityPack {
  const generatedAt = new Date().toISOString();

  const vehicles = getVehicles(20).map(v => ({
    id: v.id, model: (v as any).model, year: (v as any).year, criticality: (v as any).criticality
  }));

  const wos = getWorkOrders().map(w => ({
    id: w.id, vehicleId: w.vehicleId, type: w.type, subsystem: (w as any).subsystem, status: w.status, created: (w as any).created
  }));

  const pm = getPMTasks().map((p: any, i: number) => ({
    id: p.id ?? `PM-${String(i + 1).padStart(3, '0')}`,
    title: p.title ?? p.description ?? 'PM Task',
    subsystem: p.subsystem,
    interval: p.interval ?? p.frequency
  }));

  // Failures: extend history window (± lookback)
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - lookbackDays);
  const failuresRaw = getFailures()
    .map((f: any) => ({
      vehicleId: String(f.vehicleId ?? f.asset_id ?? ''),
      subsystem: String(f.subsystem ?? 'unknown'),
      failure_mode: f.failure_mode ? String(f.failure_mode) : undefined,
      date: String(f.failure_date ?? f.date ?? new Date().toISOString())
    }))
    .filter((f: any) => new Date(f.date) >= cutoff);

  // Weekly series (last `weeks`)
  const now = new Date(); const endWeek = startOfWeek(now);
  const start = new Date(endWeek); start.setDate(start.getDate() - (weeks - 1) * 7);
  const byVWeek = new Map<string, number>();
  for (const f of failuresRaw) {
    const dt = new Date(f.date);
    if (dt < start) continue;
    const wk = ymd(startOfWeek(dt));
    const key = `${f.vehicleId}|${wk}`;
    byVWeek.set(key, (byVWeek.get(key) || 0) + 1);
  }
  const weeklyFailureSeries: ReliabilityPack['datasets']['weeklyFailureSeries'] = [];
  for (const [key, count] of byVWeek.entries()) {
    const [vehicleId, weekStart] = key.split('|');
    weeklyFailureSeries.push({ vehicleId, weekStart, count });
  }

  // Repeated failures per vehicle/mode (count >= 2)
  const repKey = (r: typeof failuresRaw[number]) => `${r.vehicleId}|${r.subsystem}|${r.failure_mode ?? 'UNK'}`;
  const repCount = new Map<string, number>();
  for (const r of failuresRaw) repCount.set(repKey(r), (repCount.get(repKey(r)) || 0) + 1);
  const repeatedFailures = Array.from(repCount.entries())
    .filter(([, c]) => c >= 2)
    .map(([k, c]) => {
      const [vehicleId, subsystem, failure_mode] = k.split('|');
      return { vehicleId, subsystem, failure_mode: failure_mode === 'UNK' ? undefined : failure_mode, count: c };
    });

  // Related failures across vehicles by subsystem (co-occurrence)
  const bySub = new Map<string, Set<string>>();
  for (const r of failuresRaw) {
    const set = bySub.get(r.subsystem) ?? new Set<string>();
    set.add(r.vehicleId);
    bySub.set(r.subsystem, set);
  }
  const relatedBySubsystem = Array.from(bySub.entries())
    .map(([subsystem, set]) => ({ subsystem, vehicles: Array.from(set), count: set.size }))
    .filter(x => x.count >= 3) // only interesting if seen on 3+ vehicles
    .sort((a,b) => b.count - a.count);

  // Emerging failures (first seen in last 30 days)
  const cutoff30 = new Date(); cutoff30.setDate(cutoff30.getDate() - 30);
  const firstSeen = new Map<string, { first: Date; vehicles: Set<string> }>();
  for (const r of failuresRaw) {
    const mode = r.failure_mode ?? `subsys:${r.subsystem}`;
    const cur = firstSeen.get(mode) ?? { first: new Date('2100-01-01'), vehicles: new Set<string>() };
    const d = new Date(r.date);
    if (d < cur.first) cur.first = d;
    cur.vehicles.add(r.vehicleId);
    firstSeen.set(mode, cur);
  }
  const emergingFailures = Array.from(firstSeen.entries())
    .filter(([, v]) => v.first >= cutoff30)
    .map(([mode, v]) => ({ failure_mode: mode.startsWith('subsys:') ? undefined : mode, first_seen: ymd(v.first), vehicles: Array.from(v.vehicles) }));

  // Trend signals: last 3 vs prev 3 weeks per vehicle
  const weeksList: string[] = [];
  for (let i = 0; i < weeks; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i * 7);
    weeksList.push(ymd(d));
  }
  const seriesByV = new Map<string, number[]>();
  for (const v of vehicles) seriesByV.set(v.id, Array(weeks).fill(0));
  for (const row of weeklyFailureSeries) {
    const idx = weeksList.indexOf(row.weekStart);
    if (idx >= 0) seriesByV.get(row.vehicleId)![idx] = row.count;
  }
  const trendSignals: ReliabilityPack['datasets']['trendSignals'] = [];
  for (const [vehicleId, arr] of seriesByV.entries()) {
    if (weeks < 6) continue;
    const last3 = arr.slice(-3).reduce((a,b)=>a+b,0);
    const prev3 = arr.slice(-6,-3).reduce((a,b)=>a+b,0);
    const pct = prev3 === 0 ? (last3 > 0 ? 100 : 0) : ((last3 - prev3) / Math.max(1, prev3)) * 100;
    trendSignals.push({ vehicleId, last3, prev3, pctChange: Math.round(pct * 10) / 10 });
  }

  // MTBF (rough) in days over lookback
  const spanDays = clamp(lookbackDays, 1, 365);
  const byVid = new Map<string, number>();
  for (const f of failuresRaw) byVid.set(f.vehicleId, (byVid.get(f.vehicleId) || 0) + 1);
  const mtbfByVehicle = vehicles.map(v => {
    const failures = byVid.get(v.id) || 0;
    const mtbfDays = failures ? Math.round((spanDays / failures) * 10) / 10 : spanDays;
    return { vehicleId: v.id, failures, spanDays, mtbfDays };
  });

  // PM coverage gaps (subsystems with failures but no PM)
  const pmSubs = new Set(pm.filter(p => p.subsystem).map(p => String(p.subsystem)));
  const failSubs = new Set(failuresRaw.map(f => f.subsystem));
  const pmCoverageGaps = Array.from(failSubs).map(sub => ({
    subsystem: sub,
    hasPM: pmSubs.has(sub),
    notes: pmSubs.has(sub) ? 'PM present' : 'No PM task covering this subsystem'
  }));

  return {
    about: {
      role: 'You are the Reliability Agent: detect trends, repeated/related failures, and recommend PM design changes using RCM principles.',
      guidance: [
        'Thresholds: flag vehicles with last3 >= 2 and pctChange >= 50%.',
        'Repeated failures: count >= 2 on same vehicle & subsystem/mode.',
        'Related failures: same subsystem on 3+ vehicles → common cause or design/usage issue.',
        'Emerging modes: first seen in last 30 days.',
        'RCM mapping: propose on-condition tasks, redesigns, interval changes.',
        'Quantify impact: reference IDs, counts, % change, and PM coverage gaps.',
      ],
      schemaNotes: [
        'weeklyFailureSeries {vehicleId, weekStart, count}',
        'trendSignals {vehicleId, last3, prev3, pctChange}',
        'emergingFailures: first_seen in last 30 days',
        'pmCoverageGaps: subsystems lacking PM',
      ],
    },
    window: { generatedAt, weeksIncluded: weeks, lookbackDays },
    datasets: {
      vehicles,
      workorders: wos,
      pm,
      failures: failuresRaw,
      weeklyFailureSeries,
      repeatedFailures,
      relatedBySubsystem,
      emergingFailures,
      trendSignals,
      mtbfByVehicle,
      pmCoverageGaps,
    }
  };
}

export async function analyzeReliabilityWithLLM(
  question: string,
  pack: ReliabilityPack,
  history: QATurn[] = []
): Promise<AgentDecision> {
  const key = import.meta.env.VITE_OPENAI_API_KEY;
  if (!key) return { intent: 'QA', answer: 'VITE_OPENAI_API_KEY missing. Add it in .env.local and restart.' };

  const SYSTEM = [
    'You are the Reliability Agent for a heavy-vehicle fleet.',
    'Use Reliability-Centered Maintenance (RCM) principles and classical reliability analysis.',
    'Given the reliability pack, do ALL of the following as relevant:',
    ' • Identify vehicles with increasing failure rate (use trendSignals thresholds: last3 >= 2 AND pctChange >= 50%).',
    ' • List repeated/related failures: same vehicle & subsystem/mode with count >= 2; and cross-vehicle “relatedBySubsystem” clusters.',
    ' • Flag emerging failure modes (emergingFailures).',
    ' • Note PM coverage gaps for failing subsystems (pmCoverageGaps.hasPM=false).',
    ' • Recommend actionable next steps: RCFA candidates, PM changes (on-condition, interval adjust), parts stocking, or redesign.',
    'Be specific: include IDs (V###, WO-###), subsystem names, counts, % change, and why it matters.',
    'Prefer 3–7 bullets grouped by theme with short titles.',
  ].join('\n');

  const RESPONSE = [
    'Return ONLY this JSON (no extra text):',
    '```json',
    '{ "intent": "QA",',
    '  "answer": "• Increasing rate: V007 (last3=3, prev3=0, +100%); V003 (...)\n• Repeated failures: V007/brakes (3x) → RCFA; ...\n• Emerging: EGR valve seen on V012/V015 in last 30d → add on-condition check\n• PM gap: Cooling lacks PM despite 4 failures → add leak/pressure check\n• Next actions: ..."}',
    '```'
  ].join('\n');

  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'system', content: RESPONSE },
    { role: 'user', content: `RELIABILITY_PACK:\n\`\`\`json\n${JSON.stringify(pack)}\n\`\`\`` },
    { role: 'user', content: `HISTORY:\n\`\`\`json\n${JSON.stringify(history.slice(-6))}\n\`\`\`` },
    { role: 'user', content: `QUESTION:\n${question}` },
  ] as const;

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini', messages, temperature: 0.2 })
  });
  const data = await resp.json();
  if (!resp.ok || data?.error) {
    return { intent: 'QA', answer: `Model error: ${data?.error?.message ?? resp.statusText}` };
  }

  const text = String(data?.choices?.[0]?.message?.content ?? '').trim();
  const fence = text.match(/```json\s*([\s\S]*?)```/i);
  const raw = fence ? fence[1] : text;
  let obj: any; try { obj = JSON.parse(raw); } catch { obj = {}; }

  const answer = typeof obj?.answer === 'string' && obj.answer.trim() ? obj.answer.trim() : 'I could not derive a reliability answer.';
  return { intent: 'QA', answer };
}

const TIPS = [
  'Increasing rate: check last 3 vs prior 3 weeks and quantify % change.',
  'Related failures across vehicles suggest design/usage causes — start with most common subsystem.',
  'PM gap: failing subsystem with no PM → add on-condition checks.',
  'RCM: prefer detectability (on-condition) over time-based tasks for random failures.',
  'Parts lead time + high criticality → stock spares.',
];
export function helloReliabilityFact(): string {
  const t = TIPS[Math.floor(Math.random() * TIPS.length)];
  return `Hello 👋 — I’m the Reliability Agent. Tip: ${t}`;
}
