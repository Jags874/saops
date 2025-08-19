// src/pages/Dashboard.tsx
import { useEffect, useMemo, useState } from 'react';
import { getVehicles, getWorkOrders, getOpsTasks } from '../data/adapter';
import VehicleGallery from '../components/VehicleGallery';
import GanttWeek from '../components/GanttWeek';
import WorkOrdersModal from '../components/WorkOrdersModal';
import { applyMutationsToPlan } from '../data/mutatePlan';
import { Kpi } from '../components/Kpis';
import Agents from '../components/Agents';
import type { AgentKey, SchedulerPolicy, ReportQuery, QATurn, AgentDecision, PlanContext } from '../types';
import ResourceSummary from '../components/ResourceSummary';
import DemandSummary from '../components/DemandSummary';
import { proposeSchedule } from '../agents/scheduler';
import AgentConsole from '../components/AgentConsole';
import { analyzeWithLLM, helloSchedulerFact } from '../agents/agentRuntime';
import { buildKnowledgePack } from '../agents/context';
import { buildReliabilityPack, analyzeReliabilityWithLLM, helloReliabilityFact } from '../agents/reliability';
import { buildPartsPack, analyzePartsWithLLM } from '../agents/parts';
import { reseedGenericTechnicians } from '../data/resourceStore';
import DemoFooter from '../components/DemoFooter';

/** ========= Local helpers (duration preserving, date range parsing) ========= */

// Local-ISO writer (no trailing 'Z')
function isoLocal(d: Date): string {
  const t = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return t.toISOString().replace('Z', '');
}
function addHours(d: Date, hrs: number) {
  return new Date(d.getTime() + hrs * 3_600_000);
}
function setHMS(d: Date, h: number, m = 0, s = 0, ms = 0) {
  const x = new Date(d);
  x.setHours(h, m, s, ms);
  return x;
}
function clampStartPreservingDuration(start: Date, durationH: number, open = 9, close = 17) {
  const dayOpen = setHMS(start, open);
  const dayClose = setHMS(start, close);
  const latestStart = addHours(dayClose, -durationH);

  let s = start < dayOpen ? dayOpen : start;
  if (s > latestStart) {
    const nextDay = new Date(start);
    nextDay.setDate(nextDay.getDate() + 1);
    s = setHMS(nextDay, open);
  }
  const e = addHours(s, durationH);
  return { s, e };
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11
};
function parseDayLocal(y: number, mZero: number, d: number) {
  return new Date(y, mZero, d, 0, 0, 0, 0);
}
function parseNaturalRange(text: string): { startLocalISO: string; endLocalISO: string } | null {
  const t = text.toLowerCase();

  // "22–28 aug 2025" / "22-28 aug 2025"
  let m = t.match(/(\d{1,2})\s*[-–]\s*(\d{1,2})\s*([a-z]+)\s*(20\d{2})/i);
  if (m) {
    const d1 = parseInt(m[1], 10);
    const d2 = parseInt(m[2], 10);
    const month = MONTHS[m[3].slice(0, 3)];
    const year = parseInt(m[4], 10);
    if (Number.isInteger(month)) {
      const start = parseDayLocal(year, month, d1);
      const end = parseDayLocal(year, month, d2 + 1); // end exclusive
      return { startLocalISO: isoLocal(start), endLocalISO: isoLocal(end) };
    }
  }

  // "22/8/2025 – 28/8/2025"
  m = t.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](20\d{2})\s*[-–]\s*(\d{1,2})[\/\-](\d{1,2})[\/\-](20\d{2})/);
  if (m) {
    const d1 = parseInt(m[1], 10), mo1 = parseInt(m[2], 10) - 1, y1 = parseInt(m[3], 10);
    const d2 = parseInt(m[4], 10), mo2 = parseInt(m[5], 10) - 1, y2 = parseInt(m[6], 10);
    const start = parseDayLocal(y1, mo1, d1);
    const end = parseDayLocal(y2, mo2, d2 + 1);
    return { startLocalISO: isoLocal(start), endLocalISO: isoLocal(end) };
  }

  return null;
}
function insideWindow(d: Date, startISO?: string, endISO?: string) {
  if (!startISO && !endISO) return true;
  const t = +d;
  if (startISO && t < +new Date(startISO)) return false;
  if (endISO && t >= +new Date(endISO)) return false;
  return true;
}

// Local policy shape used by page + scheduler
export type PolicyExt = {
  businessHours?: [number, number];
  windowStartISO?: string;
  windowEndISO?: string;
};

// post-process a preview to respect business hours + window, preserving duration
function adjustPlanToPolicy(
  plan: { workorders: any[]; opsTasks: any[] },
  policy: PolicyExt
) {
  const [open, close] = policy.businessHours ?? [9, 17];

  const fix = (item: any) => {
    if (!item.start || !item.end) return;
    const start = new Date(item.start);
    const end = new Date(item.end);
    if (isNaN(+start) || isNaN(+end)) return;

    // rebase to window start @ open if outside window
    let s = start;
    if (!insideWindow(s, policy.windowStartISO, policy.windowEndISO) && policy.windowStartISO) {
      s = setHMS(new Date(policy.windowStartISO), open);
    }

    const durationH = Math.max(0.25, (+end - +start) / 3_600_000);
    const { s: s2, e: e2 } = clampStartPreservingDuration(s, durationH, open, close);
    item.start = isoLocal(s2);
    item.end = isoLocal(e2);
  };

  plan.workorders.forEach(fix);
  plan.opsTasks.forEach(fix);
  return plan;
}

/* ============================= Component ============================= */

type StatusFilter = 'ALL' | 'AVAILABLE' | 'DUE' | 'DOWN';

type PlanSnapshot = {
  workorders: ReturnType<typeof getWorkOrders>;
  opsTasks: ReturnType<typeof getOpsTasks>;
  summary: string[];
  moved: number;
  scheduled: number;
  unscheduled: number;
  movedIds: string[];
  scheduledIds: string[];
  unscheduledIds: string[];
  when: string; // ISO timestamp
  status: 'accepted' | 'preview';
};

export default function Dashboard() {
  useEffect(() => { reseedGenericTechnicians(); }, []);

  // Base data (ops in state so agent edits are visible). IMPORTANT: no UI clamping here.
  const vehicles = useMemo(() => getVehicles(20), []);
  const [workorders, setWorkorders] = useState(() => getWorkOrders());
  const [opsTasks, setOpsTasks] = useState(() => getOpsTasks(7));

  // UI state
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | null>(null);
  const [selectedWoId, setSelectedWoId] = useState<string | null>(null);

  const [preview, setPreview] = useState<PlanSnapshot | null>(null);
  const [planHistory, setPlanHistory] = useState<PlanSnapshot[]>([]);

  const [activeAgent, setActiveAgent] = useState<AgentKey>('scheduler');
  const [helloMessage, setHelloMessage] = useState<string | undefined>(undefined);
  const [helloNonce, setHelloNonce] = useState<number>(0);

  // KPIs
  const outstanding = useMemo(
    () => workorders.filter(w => w.status === 'Open' || w.status === 'Scheduled' || w.status === 'In Progress'),
    [workorders]
  );
  const backlogHrs = useMemo(() => Math.round(outstanding.reduce((s, w) => s + (w.hours ?? 0), 0)), [outstanding]);

  const clear = useMemo(() => vehicles.filter(v => v.status === 'AVAILABLE').length, [vehicles]);
  const due   = useMemo(() => vehicles.filter(v => v.status === 'DUE').length, [vehicles]);
  const down  = useMemo(() => vehicles.filter(v => v.status === 'DOWN').length, [vehicles]);

  // Filtering
  const visibleVehicles = useMemo(
    () => (statusFilter === 'ALL' ? vehicles : vehicles.filter(v => v.status === statusFilter)),
    [vehicles, statusFilter]
  );
  const visibleVehicleIds = useMemo(() => new Set(visibleVehicles.map(v => v.id)), [visibleVehicles]);

  const baseWorkorders = preview ? preview.workorders : workorders;
  const baseOps = preview ? preview.opsTasks : opsTasks;

  const visibleWorkorders = useMemo(() => {
    const base = baseWorkorders.filter(w => visibleVehicleIds.has(w.vehicleId));
    return selectedVehicleId ? base.filter(w => w.vehicleId === selectedVehicleId) : base;
  }, [baseWorkorders, visibleVehicleIds, selectedVehicleId]);

  const visibleOpsTasks = useMemo(() => {
    const base = baseOps.filter(t => visibleVehicleIds.has(t.vehicleId));
    return selectedVehicleId ? base.filter(t => t.vehicleId === selectedVehicleId) : base;
  }, [baseOps, visibleVehicleIds, selectedVehicleId]);

  // UI helper
  const chip = (label: string, val: StatusFilter) => (
    <button
      key={val}
      onClick={() => setStatusFilter(val)}
      className={[
        'px-3 py-1 rounded-md text-xs ring-1 transition',
        statusFilter === val
          ? 'bg-sky-500/20 text-sky-200 ring-sky-500/40'
          : 'bg-slate-800/60 text-slate-300 ring-slate-700 hover:bg-slate-800'
      ].join(' ')}
    >
      {label}
    </button>
  );

  /* ================= Agent hooks ================= */

  const agentDecide = async (text: string, history: QATurn[]): Promise<AgentDecision> => {
    if (activeAgent === 'scheduler') {
      const baseWos = preview ? preview.workorders : workorders;
      const pack = buildKnowledgePack({ horizonDays: 7, baseWorkorders: baseWos });

      const planCtx: PlanContext = {
        lastAccepted: planHistory.at(-1) ? {
          when: planHistory.at(-1)!.when,
          moved: planHistory.at(-1)!.moved,
          scheduled: planHistory.at(-1)!.scheduled,
          unscheduled: planHistory.at(-1)!.unscheduled,
          movedIds: planHistory.at(-1)!.movedIds,
          scheduledIds: planHistory.at(-1)!.scheduledIds,
          unscheduledIds: planHistory.at(-1)!.unscheduledIds,
        } : undefined,
        preview: preview ? {
          when: preview.when,
          moved: preview.moved,
          scheduled: preview.scheduled,
          unscheduled: preview.unscheduled,
          movedIds: preview.movedIds,
          scheduledIds: preview.scheduledIds,
          unscheduledIds: preview.unscheduledIds,
        } : undefined
      };

      // Return decision only; we'll apply side-effects in onDecide
      return await analyzeWithLLM(text, pack, history, planCtx);
    }

    if (activeAgent === 'reliability') {
      const relPack = buildReliabilityPack(26, 180);
      return await analyzeReliabilityWithLLM(text, relPack, history);
    }

    if (activeAgent === 'parts') {
      const partsPack = buildPartsPack();
      return await analyzePartsWithLLM(text, partsPack, history);
    }

    return { intent: 'QA', answer: `The ${activeAgent} agent isn’t wired up yet — try Scheduler, Reliability, or Parts.` };
  };

  // NOTE: widen the type locally (we always cast from LLM anyway)
  const agentSuggest = async (policy?: PolicyExt) => {
    const res = proposeSchedule(baseWorkorders, baseOps, policy as SchedulerPolicy);

    // post-process to respect window + hours & preserve durations
    const adjusted = adjustPlanToPolicy(
      { workorders: res.workorders, opsTasks: res.opsTasks },
      {
        businessHours: (policy?.businessHours ?? [9, 17]),
        windowStartISO: policy?.windowStartISO,
        windowEndISO: policy?.windowEndISO,
      }
    );

    const snap: PlanSnapshot = {
      workorders: adjusted.workorders,
      opsTasks: adjusted.opsTasks,
      summary: res.rationale,
      moved: res.moved,
      scheduled: res.scheduled,
      unscheduled: res.unscheduled,
      movedIds: res.movedIds,
      scheduledIds: res.scheduledIds,
      unscheduledIds: res.unscheduledIds,
      when: new Date().toISOString(),
      status: 'preview',
    };
    setPreview(snap);
    setSelectedVehicleId(null);
    return { moved: res.moved, scheduled: res.scheduled, unscheduled: res.unscheduled, notes: res.rationale };
  };

  const agentAccept = () => {
    if (!preview) return;
    setWorkorders(preview.workorders);
    setOpsTasks(preview.opsTasks);
    const accepted: PlanSnapshot = { ...preview, status: 'accepted', when: new Date().toISOString() };
    setPlanHistory(prev => [...prev.slice(-5), accepted]);
    setPreview(null);
  };

  const agentReject = () => { setPreview(null); };

  const agentReport = async (q: ReportQuery) => {
    const plan = preview ?? planHistory.at(-1) ?? null;
    const planWorkorders = plan?.workorders ?? workorders;
    const idx = new Map(planWorkorders.map((w, i) => [w.id, i]));
    const pick = (ids: string[]) =>
      ids.map(id => planWorkorders[idx.get(id)!]).filter(Boolean).map(w => `${w.id} — ${w.title} (${w.vehicleId})`).slice(0, 50);

    if (q.kind === 'DELTA') {
      if (planHistory.length < 2) return 'I only have one accepted plan so far — accept another proposal, then I can compare changes.';
      const nBack = Math.max(1, Math.min(q.nBack ?? 1, planHistory.length - 1));
      const newer = planHistory.at(-1)!;
      const older = planHistory.at(-1 - nBack)!;

      const woIndex = (list: ReturnType<typeof getWorkOrders>) => new Map(list.map(w => [w.id, w]));
      const A = woIndex(older.workorders);
      const B = woIndex(newer.workorders);

      const moved: string[] = [];
      const newlyScheduled: string[] = [];
      const becameUnscheduled: string[] = [];

      const ids = new Set<string>([...A.keys(), ...B.keys()]);
      const isScheduled = (w?: { status?: string; start?: string }) => !!(w && w.status === 'Scheduled' && w.start);

      for (const id of ids) {
        const a = A.get(id);
        const b = B.get(id);
        const aSched = isScheduled(a);
        const bSched = isScheduled(b);
        if (aSched && bSched) {
          if (a!.start !== b!.start || a!.end !== b!.end) moved.push(id);
        } else if (!aSched && bSched) {
          newlyScheduled.push(id);
        } else if (aSched && !bSched) {
          becameUnscheduled.push(id);
        }
      }

      const fmt = (arr: string[], title: string) =>
        arr.length
          ? `\n${title}:\n- ${arr.slice(0, 40).map(id => {
              const w = B.get(id) ?? A.get(id)!;
              return `${id} — ${w.title} (${w.vehicleId})`;
            }).join('\n- ')}${arr.length > 40 ? `\n- …and ${arr.length - 40} more` : ''}`
          : '';

      return [
        `Changes since previous accepted plan (baseline: ${older.when.slice(0,16).replace('T',' ')})`,
        fmt(moved, 'Moved'),
        fmt(newlyScheduled, 'Newly scheduled'),
        fmt(becameUnscheduled, 'No longer scheduled')
      ].filter(Boolean).join('\n');
    }

    if (q.kind === 'UNSCHEDULED') {
      if (plan) {
        const items = pick(plan.unscheduledIds);
        return items.length
          ? `${plan.status === 'preview' ? 'Couldn’t be scheduled in the current proposal' : 'Currently unscheduled (last accepted plan)'}:\n- ${items.join('\n- ')}`
          : 'All maintenance tasks are scheduled within the selected context.';
      } else {
        const items = workorders
          .filter(w => (w.status === 'Open' || !w.start) && w.status !== 'Closed')
          .map(w => `${w.id} — ${w.title} (${w.vehicleId})`);
        return items.length
          ? `Currently unscheduled (no proposal context):\n- ${items.join('\n- ')}`
          : 'All visible work orders appear to be scheduled.';
      }
    }

    if (q.kind === 'MOVED') {
      const plan = planHistory.at(-1);
      if (plan) {
        const items = pick(plan.movedIds);
        return items.length
          ? `Moved in the last accepted plan:\n- ${items.join('\n- ')}`
          : 'No maintenance tasks were moved in this context.';
      }
      return 'I don’t have a baseline to determine what moved. Ask me to “suggest a new schedule” and accept it first.';
    }

    if (q.kind === 'SCHEDULED_FOR_VEHICLE' && q.vehicleId) {
      const plan = planHistory.at(-1);
      if (plan) {
        const scheduledForV = plan.workorders
          .filter(w => w.vehicleId === q.vehicleId && (plan.scheduledIds.includes(w.id) || plan.movedIds.includes(w.id)))
          .map(w => `${w.id} — ${w.title}: ${new Date(w.start!).toLocaleString()} → ${new Date(w.end!).toLocaleTimeString()}`);
        return scheduledForV.length
          ? `Scheduled for ${q.vehicleId} (accepted plan):\n- ${scheduledForV.join('\n- ')}`
          : `No changes for ${q.vehicleId} in this context.`;
      } else {
        const scheduledForV = workorders
          .filter(w => w.vehicleId === q.vehicleId && w.status === 'Scheduled')
          .map(w => `${w.id} — ${w.title}: ${new Date(w.start!).toLocaleString()} → ${new Date(w.end!).toLocaleTimeString()}`);
        return scheduledForV.length
          ? `Currently scheduled for ${q.vehicleId}:\n- ${scheduledForV.join('\n- ')}`
          : `No scheduled maintenance found for ${q.vehicleId}.`;
      }
    }

    const sched = workorders.filter(w => w.status === 'Scheduled').length;
    const uns   = workorders.filter(w => w.status === 'Open' || !w.start).length;
    return `Summary (current state): ~${sched} scheduled, ~${uns} unscheduled.`;
  };

  // hello buttons
  const helloFromCard = (agent: AgentKey) => {
    setActiveAgent(agent);
    const msg =
      agent === 'scheduler'   ? helloSchedulerFact() :
      agent === 'reliability' ? helloReliabilityFact() :
      `Hello 👋 — I’m the Parts Interpreter. Tell me a fault symptom and I’ll suggest parts to check.`;
    setHelloMessage(msg);
    setHelloNonce(Date.now());
  };

  return (
    <div className="p-4 md:p-6 lg:p-8 grid grid-cols-1 lg:[grid-template-columns:1fr_18rem] gap-6">
      <div className="space-y-6">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Kpi title="No Outstanding Maintenance" value={clear} onClick={() => setStatusFilter('AVAILABLE')} />
          <Kpi title="Outstanding Maintenance" value={due} onClick={() => setStatusFilter('DUE')} />
          <Kpi title="Broken / In Workshop" value={down} onClick={() => setStatusFilter('DOWN')} />
          <Kpi title="Outstanding Work Orders" value={outstanding.length} />
          <Kpi title="Maintenance Backlog (hrs)" value={backlogHrs} />
        </div>

        <Agents
          vehiclesClear={clear}
          vehiclesDue={due}
          vehiclesDown={down}
          woOutstanding={outstanding.length}
          active={activeAgent}
          onSelect={(a) => setActiveAgent(a)}
          onHello={helloFromCard}
        />

        <AgentConsole
          title={activeAgent === 'scheduler' ? 'Scheduler Agent' : activeAgent === 'reliability' ? 'Reliability Agent' : 'Parts Interpreter'}
          hasPreview={!!preview}
          onSuggest={(pol?: SchedulerPolicy) => agentSuggest(pol as unknown as PolicyExt)}
          onAccept={agentAccept}
          onReject={() => setPreview(null)}
          onReport={agentReport}
          onDecide={async (text, history) => {
            const decision = await agentDecide(text, history);

            // MUTATE → apply immediately
            if (decision.intent === 'MUTATE' && (decision as any).mutations?.length) {
              const baseWos = preview ? preview.workorders : workorders;
              const baseOps = preview ? preview.opsTasks   : opsTasks;

              const { workorders: wo2, opsTasks: op2, notes } =
                applyMutationsToPlan(baseWos, baseOps, (decision as any).mutations, { businessHours: [9,17] });

              setWorkorders(wo2);
              setOpsTasks(op2);
              setPreview(null);

              return {
                ...decision,
                intent: 'QA',
                answer: (decision.answer ? decision.answer + '\n' : '') +
                        (notes.length ? `Applied changes:\n- ${notes.join('\n- ')}` : 'Applied changes.'),
              };
            }

            // PLAN → parse range from the *user text*, augment policy, then propose + preview
            if (decision.intent === 'PLAN' && (decision as any).policy) {
              const pol: PolicyExt = { ...(decision as any).policy };

              // parse "22–28 Aug 2025" / "22/8/2025–28/8/2025"
              const range = parseNaturalRange(text);
              if (range) {
                pol.windowStartISO = range.startLocalISO;
                pol.windowEndISO   = range.endLocalISO;
              }
              if (!pol.businessHours) pol.businessHours = [9,17];

              await agentSuggest(pol);
              return { ...decision, answer: decision.answer ?? 'Proposed a new plan.' };
            }

            return decision;
          }}
          helloMessage={helloMessage}
          helloNonce={helloNonce}
        />

        {preview && (
          <div className="rounded-xl border border-emerald-700 bg-emerald-900/30 p-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-slate-100 text-sm font-semibold">
                  Proposed schedule ready — {preview.moved} moved, {preview.scheduled} scheduled, {preview.unscheduled} could not be placed
                </div>
                <details className="mt-1 text-xs text-slate-300">
                  <summary className="cursor-pointer text-slate-200">Agent notes</summary>
                  <ul className="list-disc ml-5 mt-1 space-y-1">
                    {preview.summary.slice(0, 10).map((line, i) => <li key={i}>{line}</li>)}
                    {preview.summary.length > 10 && <li>…and {preview.summary.length - 10} more</li>}
                  </ul>
                </details>
              </div>
              <div className="flex gap-2 shrink-0">
                <button onClick={agentAccept} className="px-3 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-sm">Accept</button>
                <button onClick={() => setPreview(null)} className="px-3 py-1.5 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-100 text-sm">Reject</button>
              </div>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <DemandSummary />
          <ResourceSummary />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="text-xs text-slate-400 mr-1">Filter:</div>
          {chip('All', 'ALL')}
          {chip('Available', 'AVAILABLE')}
          {chip('Due', 'DUE')}
          {chip('Down', 'DOWN')}
          {selectedVehicleId && (
            <button onClick={() => setSelectedVehicleId(null)} className="ml-2 text-xs text-sky-400 hover:underline">
              Clear vehicle filter
            </button>
          )}
        </div>

        {selectedVehicleId && (
          <div className="text-sm">
            <span className="inline-flex items-center gap-2 rounded-md border border-slate-800 bg-slate-900/70 px-3 py-1 text-slate-200">
              Gantt focused on <strong className="ml-1">{selectedVehicleId}</strong>
            </span>
          </div>
        )}

        <GanttWeek
          vehicles={visibleVehicles}
          workorders={visibleWorkorders}
          opsTasks={visibleOpsTasks}
          onTaskClick={(id) => setSelectedWoId(id)}
        />

        {/* single, page-level modal */}
        <WorkOrdersModal
          open={!!selectedWoId}
          onClose={() => setSelectedWoId(null)}
          workorders={workorders.filter(w => w.id === selectedWoId)}
        />
      </div>

      <VehicleGallery vehicles={visibleVehicles} selectedId={selectedVehicleId} onSelect={setSelectedVehicleId} />
      <DemoFooter />
    </div>
  );
}
