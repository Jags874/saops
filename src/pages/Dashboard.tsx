// src/pages/Dashboard.tsx
import { useEffect, useMemo, useState } from 'react';
import { getVehicles, getWorkOrders, getOpsTasks } from '../data/adapter';
import VehicleGallery from '../components/VehicleGallery';
import GanttWeek from '../components/GanttWeek';
import { Kpi } from '../components/Kpis';
import WorkOrdersModal from '../components/WorkOrdersModal';
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
import { reseedGenericTechnicians, applyMutations, getResourceSnapshot } from '../data/resourceStore';
import DemoFooter from '../components/DemoFooter';


type StatusFilter = 'ALL' | 'AVAILABLE' | 'DUE' | 'DOWN';

type PlanSnapshot = {
  workorders: ReturnType<typeof getWorkOrders>;
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
  // Seed simplified tech model once (Mechanic/AutoElec, smaller team)
  useEffect(() => { reseedGenericTechnicians(); }, []);

  // Base data
  const vehicles = useMemo(() => getVehicles(20), []);
  const [workorders, setWorkorders] = useState(() => getWorkOrders());
  const opsTasks = useMemo(() => getOpsTasks(7), []);

  // UI state
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | null>(null);

  const [woOpen, setWoOpen] = useState(false);
  const [modalIgnoreVehicle, setModalIgnoreVehicle] = useState(false);
  const [focusedWorkOrderId, setFocusedWorkOrderId] = useState<string | null>(null);

  // Planning state
  const [preview, setPreview] = useState<PlanSnapshot | null>(null);
  const [planHistory, setPlanHistory] = useState<PlanSnapshot[]>([]); // keep last ~6

  // Active agent + hello injection
  const [activeAgent, setActiveAgent] = useState<AgentKey>('scheduler');
  const [helloMessage, setHelloMessage] = useState<string | undefined>(undefined);
  const [helloNonce, setHelloNonce] = useState<number>(0);

  // Derived KPIs
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

  const visibleWorkorders = useMemo(() => {
    const base = baseWorkorders.filter(w => visibleVehicleIds.has(w.vehicleId));
    return selectedVehicleId ? base.filter(w => w.vehicleId === selectedVehicleId) : base;
  }, [baseWorkorders, visibleVehicleIds, selectedVehicleId]);

  const visibleOpsTasks = useMemo(() => {
    const base = opsTasks.filter(t => visibleVehicleIds.has(t.vehicleId));
    return selectedVehicleId ? base.filter(t => t.vehicleId === selectedVehicleId) : base;
  }, [opsTasks, visibleVehicleIds, selectedVehicleId]);

  const outstandingForModal = useMemo(() => {
    const source = baseWorkorders;
    if (focusedWorkOrderId) {
      const item = source.find(w => w.id === focusedWorkOrderId);
      return item ? [item] : [];
    }
    const base = source
      .filter(w => w.status === 'Open' || w.status === 'Scheduled' || w.status === 'In Progress')
      .filter(w => visibleVehicleIds.has(w.vehicleId));
    return (!modalIgnoreVehicle && selectedVehicleId) ? base.filter(w => w.vehicleId === selectedVehicleId) : base;
  }, [baseWorkorders, focusedWorkOrderId, selectedVehicleId, visibleVehicleIds, modalIgnoreVehicle]);

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

  // ====== Agent hooks ======

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

  const agentSuggest = async (policy?: SchedulerPolicy) => {
    const res = proposeSchedule(workorders, opsTasks, policy);
    const snap: PlanSnapshot = {
      workorders: res.workorders,
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
    const accepted: PlanSnapshot = { ...preview, status: 'accepted', when: new Date().toISOString() };
    setPlanHistory(prev => [...prev.slice(-5), accepted]);
    setPreview(null);
  };

  const agentReject = () => { setPreview(null); };

  function woIndex(list: ReturnType<typeof getWorkOrders>) {
    return new Map(list.map(w => [w.id, w]));
  }
  function isScheduled(w?: { status?: string; start?: string }) {
    return !!(w && w.status === 'Scheduled' && w.start);
  }

  const agentReport = async (q: ReportQuery) => {
    const plan = preview ?? planHistory.at(-1) ?? null;
    const planWorkorders = plan?.workorders ?? workorders;
    const idx = new Map(planWorkorders.map((w, i) => [w.id, i]));
    const pick = (ids: string[]) =>
      ids.map(id => planWorkorders[idx.get(id)!]).filter(Boolean).map(w => `${w.id} — ${w.title} (${w.vehicleId})`).slice(0, 50);

    if (q.kind === 'DELTA') {
      if (planHistory.length < 2) {
        return 'I only have one accepted plan so far — accept another proposal, then I can compare changes.';
      }
      const nBack = Math.max(1, Math.min(q.nBack ?? 1, planHistory.length - 1));
      const newer = planHistory.at(-1)!;
      const older = planHistory.at(-1 - nBack)!;

      const A = woIndex(older.workorders);
      const B = woIndex(newer.workorders);

      const moved: string[] = [];
      const newlyScheduled: string[] = [];
      const becameUnscheduled: string[] = [];

      const ids = new Set<string>([...A.keys(), ...B.keys()]);
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
      if (plan) {
        const items = pick(plan.movedIds);
        return items.length
          ? `${plan.status === 'preview' ? 'Moved in the current proposal' : 'Moved in the last accepted plan'}:\n- ${items.join('\n- ')}`
          : 'No maintenance tasks were moved in this context.';
      } else {
        return 'I don’t have a baseline to determine what moved. Ask me to “suggest a new schedule” and accept it first.';
      }
    }

    if (q.kind === 'SCHEDULED_FOR_VEHICLE' && q.vehicleId) {
      if (plan) {
        const scheduledForV = planWorkorders
          .filter(w => w.vehicleId === q.vehicleId && (plan.scheduledIds.includes(w.id) || plan.movedIds.includes(w.id)))
          .map(w => `${w.id} — ${w.title}: ${new Date(w.start!).toLocaleString()} → ${new Date(w.end!).toLocaleTimeString()}`);
        return scheduledForV.length
          ? `Scheduled for ${q.vehicleId} (${plan.status === 'preview' ? 'proposal' : 'accepted plan'}):\n- ${scheduledForV.join('\n- ')}`
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

  // Handle hello buttons on cards
  const helloFromCard = (agent: AgentKey) => {
    setActiveAgent(agent);
    const msg =
      agent === 'scheduler'   ? helloSchedulerFact() :
      agent === 'reliability' ? helloReliabilityFact() :
      `Hello 👋 — I’m the Parts Interpreter. Tell me a fault symptom and I’ll suggest parts to check.`;
    setHelloMessage(msg);
    setHelloNonce(Date.now());
  };

  const agentTitle =
    activeAgent === 'scheduler'   ? 'Scheduler Agent' :
    activeAgent === 'reliability' ? 'Reliability Agent' :
                                     'Parts Interpreter';

  // Apply MUTATE instructions coming from the Scheduler Agent
  const handleDecisionSideEffects = (d: AgentDecision) => {
    if (d.intent === 'MUTATE' && d.mutations?.length) {
      const notes = applyMutations(d.mutations);
      // After resource/parts changes, re-run a quick proposal to reflect capacity/parts
      // (User can still say "accept" to apply)
      agentSuggest(undefined);
      return (d.answer ? d.answer + '\n' : '') + `Applied changes:\n- ${notes.join('\n- ')}`;
    }
    return d.answer ?? undefined;
  };

  return (
    <div className="p-4 md:p-6 lg:p-8 grid grid-cols-1 lg:[grid-template-columns:1fr_18rem] gap-6">
      <div className="space-y-6">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Kpi title="No Outstanding Maintenance" value={clear} />
          <Kpi title="Outstanding Maintenance" value={due} />
          <Kpi title="Broken / In Workshop" value={down} />
          <Kpi
            title="Outstanding Work Orders"
            value={outstanding.length}
            sub="Click to view details"
            onClick={() => { setFocusedWorkOrderId(null); setModalIgnoreVehicle(false); setWoOpen(true); }}
          />
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
          title={agentTitle}
          hasPreview={!!preview}
          onSuggest={agentSuggest}
          onAccept={agentAccept}
          onReject={agentReject}
          onReport={agentReport}
          onDecide={async (text, history) => {
            const decision = await agentDecide(text, history);
            // If scheduler asked to mutate resources/parts, apply them here:
            const maybeMsg = handleDecisionSideEffects(decision);
            return maybeMsg ? { ...decision, intent: decision.intent === 'MUTATE' ? 'QA' : decision.intent, answer: maybeMsg } : decision;
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
                <button onClick={agentReject} className="px-3 py-1.5 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-100 text-sm">Reject</button>
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
          onTaskClick={(woId) => { setFocusedWorkOrderId(woId); setModalIgnoreVehicle(true); setWoOpen(true); }}
        />
      </div>

      <VehicleGallery vehicles={visibleVehicles} selectedId={selectedVehicleId} onSelect={setSelectedVehicleId} />

      <WorkOrdersModal
        open={woOpen}
        onClose={() => { setWoOpen(false); setModalIgnoreVehicle(false); setFocusedWorkOrderId(null); }}
        workorders={outstandingForModal}
      />
      <DemoFooter />    
    </div>
  );
}
