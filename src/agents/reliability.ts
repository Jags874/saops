// src/agents/reliability.ts
import type { AgentDecision, QATurn } from '../types';
import { getFailures, getVehicles, getDemoWeekStart } from '../data/adapter';

// --- helpers: parse date fields flexibly as local wall-clock ---
function parseWhen(x: any): Date | null {
  const s = String(x ?? '');
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  const [, y, mo, d, hh = '00', mm = '00', ss = '00'] = m;
  const dt = new Date(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mm), Number(ss), 0);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

// narrow fields safely across the two failure shapes we’ve used
function fVehicleId(f: any): string {
  return String(f.vehicleId ?? f.asset_id ?? f.assetId ?? '');
}
function fDate(f: any): Date | null {
  return parseWhen(f.date ?? f.failureDate ?? f.failure_date);
}
function fSubsystem(f: any): string {
  return String(f.subsystem ?? '').toLowerCase();
}
function fPart(f: any): string {
  return String(f.part ?? f.part_id ?? f.partID ?? '').toLowerCase();
}
function fMode(f: any): string {
  return String(f.failure_mode ?? f.mode ?? '').toLowerCase();
}

// Random fact for the “Hello Reliability Agent” button
const FACTS = [
  'Trend rule: repeated same-subsystem failures in short intervals suggest design or maintenance issues.',
  'Quick check: compare last 60 days vs previous 60 days to spot batch or seasonal effects.',
  'RCM tip: before adding a PM, prove the failure is predictable and worth the intervention.',
  'Beware maintenance-induced failures after major overhauls—watch failure modes right after service.',
];
export function helloReliabilityFact(): string {
  return FACTS[Math.floor(Math.random() * FACTS.length)];
}

/**
 * Build a compact pack the model (or heuristics) can use:
 * - vehicles
 * - recent failures (<= daysBack from the demo anchor)
 * - simple trend summaries per vehicle and fleet thermostat spike check
 */
export function buildReliabilityPack(weeksBack = 26, daysBack = 180) {
  const anchorISO = getDemoWeekStart(); // '2025-08-22T00:00:00Z'
  const anchor = new Date(anchorISO);
  // define windows relative to anchor (local)
  const recentStart = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - daysBack, 0, 0, 0, 0);
  const last60Start  = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - 60, 0, 0, 0, 0);
  const prev60Start  = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - 120, 0, 0, 0, 0);

  const vehicles = getVehicles();
  const failuresAll = (getFailures?.() ?? []).filter((f: any) => {
    const dt = fDate(f);
    return dt && dt >= recentStart && dt <= anchor;
  });

  // per-vehicle counts and 3-week window change
  const byVehicle = new Map<string, { total: number; bySubsystem: Record<string, number> }>();
  const last21ByV = new Map<string, number>();
  const prev21ByV = new Map<string, number>();
  const last21Start = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - 21, 0, 0, 0, 0);
  const prev21Start = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - 42, 0, 0, 0, 0);

  // fleet thermostat spike
  let fleetThermoLast60 = 0, fleetThermoPrev60 = 0;

  // repeated/related per vehicle (same subsystem or part)
  const repeats: Record<string, { subsystem?: string; part?: string; count: number }[]> = {};

  // temp grouping for repeats
  const groupByVSub = new Map<string, number>();
  const groupByVPart = new Map<string, number>();

  for (const f of failuresAll) {
    const vid = fVehicleId(f);
    if (!vid) continue;
    const dt = fDate(f)!;
    const sub = fSubsystem(f);
    const part = fPart(f);
    const mode = fMode(f);

    // per-vehicle rollup
    const rec = byVehicle.get(vid) ?? { total: 0, bySubsystem: {} };
    rec.total += 1;
    if (sub) rec.bySubsystem[sub] = (rec.bySubsystem[sub] ?? 0) + 1;
    byVehicle.set(vid, rec);

    // 3-week windows
    if (dt >= last21Start) last21ByV.set(vid, (last21ByV.get(vid) ?? 0) + 1);
    else if (dt >= prev21Start && dt < last21Start) prev21ByV.set(vid, (prev21ByV.get(vid) ?? 0) + 1);

    // thermostat fleet spike (cooling + thermostat in part/mode)
    const looksThermo = sub.includes('cool') && (part.includes('thermo') || mode.includes('thermo'));
    if (looksThermo) {
      if (dt >= last60Start) fleetThermoLast60 += 1;
      else if (dt >= prev60Start && dt < last60Start) fleetThermoPrev60 += 1;
    }

    // for repeats
    if (sub) {
      const k = `${vid}|sub|${sub}`;
      groupByVSub.set(k, (groupByVSub.get(k) ?? 0) + 1);
    }
    if (part) {
      const k = `${vid}|part|${part}`;
      groupByVPart.set(k, (groupByVPart.get(k) ?? 0) + 1);
    }
  }

  // materialize repeats where count >= 2
  for (const [k, n] of groupByVSub.entries()) {
    if (n < 2) continue;
    const [vid, , sub] = k.split('|');
    repeats[vid] = repeats[vid] ?? [];
    repeats[vid].push({ subsystem: sub, count: n });
  }
  for (const [k, n] of groupByVPart.entries()) {
    if (n < 2) continue;
    const [vid, , part] = k.split('|');
    repeats[vid] = repeats[vid] ?? [];
    repeats[vid].push({ part, count: n });
  }

  // increasing list
  const increasing: { vehicleId: string; last3w: number; prev3w: number; pctChange: number }[] = [];
  const allVehicleIds = new Set<string>([...byVehicle.keys(), ...last21ByV.keys(), ...prev21ByV.keys()]);
  for (const vid of allVehicleIds) {
    const a = last21ByV.get(vid) ?? 0;
    const b = prev21ByV.get(vid) ?? 0;
    if (a >= 2 && (b === 0 || a > b)) {
      const pct = b === 0 ? 100 : Math.round(((a - b) / Math.max(1, b)) * 100);
      increasing.push({ vehicleId: vid, last3w: a, prev3w: b, pctChange: pct });
    }
  }
  increasing.sort((x, y) => y.pctChange - x.pctChange || y.last3w - x.last3w);

  const thermoSpike = {
    last60: fleetThermoLast60,
    prev60: fleetThermoPrev60,
    uptick: fleetThermoLast60 > fleetThermoPrev60
  };

  return {
    anchor: anchorISO,
    horizonDays: daysBack,
    vehicles: vehicles.map(v => ({ id: v.id, status: v.status })),
    failuresRecent: failuresAll.length,
    byVehicle: Array.from(byVehicle.entries()).map(([vehicleId, v]) => ({ vehicleId, total: v.total, bySubsystem: v.bySubsystem })),
    increasing,
    repeats,
    thermostatFleet: thermoSpike
  };
}

/**
 * Simple, deterministic analyzer (no UI changes, agents-only).
 * It uses the pack to answer the common questions you demo.
 */
export async function analyzeReliabilityWithLLM(
  userText: string,
  pack: any,
  _history: QATurn[] = []
): Promise<AgentDecision> {
  const q = userText.toLowerCase();

  // Increasing rates
  if (/(increasing|high rate|spike|rising)/i.test(userText)) {
    const top = (pack.increasing as any[] ?? []).slice(0, 5);
    if (!top.length) {
      return { intent: 'QA', answer: 'I don’t see a clear increase by vehicle in the last 3 weeks vs prior 3 weeks.' };
    }
    const lines = top.map(v => `- ${v.vehicleId}: ${v.last3w} vs ${v.prev3w} (Δ ${v.pctChange}%)`);
    const thermo = pack.thermostatFleet?.uptick
      ? `\nFleet-wide thermostat uptick last 60d (${pack.thermostatFleet.last60}) vs prior 60d (${pack.thermostatFleet.prev60}).`
      : '';
    return {
      intent: 'QA',
      answer: `Vehicles with increasing failure rates (last 3w vs prior 3w):\n${lines.join('\n')}${thermo}`
    };
  }

  // Repeated / related failures
  if (/(repeated|repeat|related)/i.test(q)) {
    const r = pack.repeats ?? {};
    const keys = Object.keys(r);
    if (!keys.length) return { intent: 'QA', answer: 'No repeated or related failures stood out in the recent window.' };
    const parts = keys.slice(0, 6).map(k => {
      const items = (r[k] as any[]).map(x => x.subsystem ? `${x.subsystem}×${x.count}` : `${x.part}×${x.count}`);
      return `- ${k}: ${items.join(', ')}`;
    });
    return { intent: 'QA', answer: `Repeated / related failures by vehicle:\n${parts.join('\n')}` };
  }

  // Root cause around thermostat
  if (/(root cause|why|cause).*thermostat|thermostat.*(root cause|why|cause)/i.test(q) || /thermostat uptick|thermostat spike/i.test(q)) {
    const t = pack.thermostatFleet;
    const note = t?.uptick
      ? `We see a thermostat uptick (last 60d ${t.last60} vs prior 60d ${t.prev60}).`
      : `Thermostat signals are present but not clearly above baseline.`;
    return {
      intent: 'QA',
      answer:
`${note}
Likely hypothesis: faulty supplier batch (marginal opening temp or weak wax charge).
Quick confirmatory action:
- Sample 1–2 vehicles of similar build for **Thermostat Inspection** (lot code & opening temp check).
- Cross-check recent part GRNs for the same supplier/lot.`
    };
  }

  // General fallback / guidance
  return {
    intent: 'QA',
    answer:
`Ask me things like:
- “Any vehicles with increasing failure rates in the last 6 months?”
- “Any repeated or related failures we should look into?”
- “What’s the likely root cause behind the thermostat uptick, and a quick action to confirm?”`
  };
}
