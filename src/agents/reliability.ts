// src/agents/reliability.ts
import { getFailures, getVehicles, getCondition, getWorkOrders } from '../data/adapter';
import type { QATurn, AgentDecision, FailureRecord } from '../types';

// Static demo week anchor (local midnight)
const DEMO_ANCHOR = new Date('2025-08-22T00:00:00');

// Local YYYY-MM-DD
function ymdLocal(d: Date) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}
function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

// ------- Pack builder (no getDemoWeekStart dependency) -------
export function buildReliabilityPack(windowRecentDays = 21, windowTotalDays = 180) {
  const anchor = DEMO_ANCHOR; // first day in your demo week
  const recentStart = new Date(anchor);
  recentStart.setDate(anchor.getDate() - clamp(windowRecentDays, 7, 60));
  const totalStart = new Date(anchor);
  totalStart.setDate(anchor.getDate() - clamp(windowTotalDays, 30, 365));

  const vehicles = getVehicles(20);
  const failures = getFailures();
  const condition = getCondition();
  const workorders = getWorkOrders();

  // Basic derived signals the LLM can lean on (trending & clusters)

  // 1) recent vs previous window by vehicle/subsystem
  const recent = failures.filter(f => new Date(f.date) >= recentStart && new Date(f.date) < anchor);
  const prevStart = new Date(recentStart);
  prevStart.setDate(recentStart.getDate() - clamp(windowRecentDays, 7, 60));
  const previous = failures.filter(f => new Date(f.date) >= prevStart && new Date(f.date) < recentStart);

  function key(vId: string, sub: string) { return `${vId}::${sub}`; }
  const countBy = (arr: FailureRecord[]) => {
    const m = new Map<string, number>();
    for (const f of arr) {
      const k = key(f.vehicleId, f.subsystem);
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  };
  const rCounts = countBy(recent);
  const pCounts = countBy(previous);

  const increasing: Array<{ vehicleId: string; subsystem: string; last: number; prev: number; pctChange: number }> = [];
  for (const [k, last] of rCounts) {
    const prev = pCounts.get(k) ?? 0;
    if (last > 0 && last > prev) {
      const [vehicleId, subsystem] = k.split('::');
      const pct = prev === 0 ? 100 : Math.round(((last - prev) / Math.max(1, prev)) * 100);
      increasing.push({ vehicleId, subsystem, last, prev, pctChange: pct });
    }
  }
  increasing.sort((a, b) => b.pctChange - a.pctChange);

  // 2) simple clustering hints (e.g., thermostat across fleet)
  const thermoRecent = recent.filter(f => /thermo/i.test(f.failureMode) || /thermo/i.test(f.partId ?? ''));
  const thermostatVehicles = Array.from(new Set(thermoRecent.map(f => f.vehicleId)));

  // 3) potential ECU/control-unit intermittent marker:
  const ecuPatternVehicles = (() => {
    const byV = new Map<string, Set<string>>();
    for (const f of recent) {
      const s = (f.subsystem || '').toLowerCase();
      if (s.includes('elect') || s.includes('engine')) {
        const set = byV.get(f.vehicleId) ?? new Set<string>();
        set.add(s);
        byV.set(f.vehicleId, set);
      }
    }
    // "intermittent & cross-domain" heuristic: both electrical and engine in recent window
    return Array.from(byV.entries())
      .filter(([, set]) => set.has('electrical') && set.has('engine'))
      .map(([v]) => v);
  })();

  return {
    meta: {
      anchorISO: anchor.toISOString(),
      recentWindowDays: clamp(windowRecentDays, 7, 60),
      totalWindowDays: clamp(windowTotalDays, 30, 365),
      recentStartYMD: ymdLocal(recentStart),
      previousStartYMD: ymdLocal(prevStart),
    },
    vehicles,
    failures,
    condition,
    workorders,
    derived: {
      increasingByVehicleSubsystem: increasing.slice(0, 25),
      thermostatSpike: {
        countRecent: thermoRecent.length,
        vehicles: thermostatVehicles,
      },
      ecuIntermittentCandidates: ecuPatternVehicles,
    },
    guidance: [
      'Use RCM reasoning: identify functional failures → failure modes → effects → consequences → proactive tasks.',
      'Look for monotonic increases in failures in recent window vs prior.',
      'Identify repeated/related modes on the same vehicle (common-cause).',
      'Note cross-vehicle spikes indicating part-quality or environmental issues (e.g., thermostat batch).',
      'Suggest inspection or PM design updates with clear rationale and affected scope.',
    ],
  };
}

// ------- LLM call for reliability analysis -------
export async function analyzeReliabilityWithLLM(
  question: string,
  pack: ReturnType<typeof buildReliabilityPack>,
  history: QATurn[] = [],
): Promise<AgentDecision> {
  const apiKey = import.meta.env.VITE_OPENAI_API_KEY as string | undefined;

  // Compact the pack a little to avoid oversize payloads
  const slimPack = {
    meta: pack.meta,
    derived: pack.derived,
    // include only essential columns for failures
    failures: pack.failures.map(f => ({
      id: f.id, v: f.vehicleId, s: f.subsystem, m: f.failureMode, d: f.date, p: f.partId
    })).slice(0, 1200), // cap
    // light include
    vehicles: pack.vehicles.map(v => ({ id: v.id, status: v.status, criticality: v.criticality })),
  };

  const sys = [
    'You are the Reliability Agent for a heavy-vehicle fleet.',
    'Use reliability engineering knowledge (Weibull basics, trend analysis, common-cause, RCM logic).',
    'Be specific: point to vehicle IDs, subsystems, dates, counts, and suggest actionable next steps (inspections, PM changes).',
    'Prefer concise bullets. If you infer a likely root cause (e.g., thermostat batch), say why.'
  ].join(' ');

  const messages = [
    { role: 'system', content: sys },
    ...history.map(h => ({ role: h.role, content: h.text })),
    {
      role: 'user',
      content: [
        'Question:', question,
        '\n\nContext JSON (trimmed):\n',
        JSON.stringify(slimPack)
      ].join(' ')
    }
  ];

  // If no key, return a heuristic (still useful)
  if (!apiKey) {
    const inc = pack.derived.increasingByVehicleSubsystem.slice(0, 5)
      .map(x => `- ${x.vehicleId} / ${x.subsystem}: last ${x.last}, prev ${x.prev} (Δ ${x.pctChange}%)`).join('\n');
    const thermo = pack.derived.thermostatSpike;
    const hints: string[] = [];
    if (inc) hints.push('Increasing failures (recent vs prior window):\n' + inc);
    if (thermo.countRecent > 0) {
      hints.push(`Thermostat spike across ${thermo.vehicles.length} vehicles (recent count ${thermo.countRecent}). Consider batch/quality issue.`);
    }
    if (pack.derived.ecuIntermittentCandidates.length) {
      hints.push(`Intermittent ECU-like pattern on: ${pack.derived.ecuIntermittentCandidates.join(', ')}.`);
    }
    return { intent: 'QA', answer: hints.join('\n\n') || 'No strong reliability signal detected.' };
  }

  try {
    const resp = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4.1-mini',
        messages,
        temperature: 0.2,
      })
    });

    if (!resp.ok) {
      const t = await resp.text();
      return { intent: 'QA', answer: `Reliability analysis failed: ${t.slice(0, 300)}` };
    }
    const data = await resp.json();
    const text =
      data?.output_text ??
      data?.choices?.[0]?.message?.content ??
      JSON.stringify(data);

    return { intent: 'QA', answer: String(text) };
  } catch (err: any) {
    return { intent: 'QA', answer: `Reliability analysis error: ${err?.message ?? String(err)}` };
  }
}

// ------- fun hello fact -------
const RELIABILITY_FACTS = [
  'RCM tip: If a failure has low consequence but frequent occurrence, consider condition-based tasks over fixed-interval PM.',
  'Trend hint: A spike clustered on “cooling/thermostat” across vehicles often points to a batch/quality issue rather than random wear.',
  'Weibull basics: β>1 suggests wear-out (increasing failure rate); β≈1 suggests random failures; β<1 suggests infant mortality.',
  'Common-cause check: Repeated failures on the same subsystem after maintenance may indicate task-induced issues or wrong intervals.',
  'Inspection design: Short, targeted inspections during low-utilisation windows reduce downtime without heavy labour demand.',
];
export function helloReliabilityFact() {
  return RELIABILITY_FACTS[Math.floor(Math.random() * RELIABILITY_FACTS.length)];
}
