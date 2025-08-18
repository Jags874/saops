// src/pages/Dashboard.tsx
import { useEffect, useMemo, useState } from 'react';
import { getVehicles, getWorkOrders, getOpsTasks } from '../data/adapter';
import VehicleGallery from '../components/VehicleGallery';
import GanttWeek from '../components/GanttWeek';
import { Kpi } from '../components/Kpis';
import WorkOrdersModal from '../components/WorkOrdersModal';
import Agents from '../components/Agents';
import type {
  AgentKey,
  ReportQuery,
  QATurn,
  AgentDecision,
  PlanContext,
  WorkOrder,
  OpsTask
} from '../types';
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

// Narrow policy expected by your scheduler
type SimplePolicy = { businessHours?: [number, number] };

// ---- helpers ----
function inferPolicyFromText(text: string): SimplePolicy | undefined {
  const t = text.toLowerCase();
  let bh: [number, number] | undefined;
  const m1 = t.match(/(\d{1,2})(?::?00)?\s*(am|pm)?\s*[–-]\s*(\d{1,2})(?::?00)?\s*(am|pm)?/i);
  if (m1) {
    let s = parseInt(m1[1], 10);
    let e = parseInt(m1[3], 10);
    const am1 = m1[2]?.toLowerCase();
    const am2 = m1[4]?.toLowerCase();
    if (am1 === 'pm' && s < 12) s += 12;
    if (am1 === 'am' && s === 12) s = 0;
    if (am2 === 'pm' && e < 12) e += 12;
    if (am2 === 'am' && e === 12) e = 0;
    bh = [Math.min(23, Math.max(0, s)), Math.min(23, Math.max(0, e))] as [number, number];
  }
  if (!bh && /business hours|day shift|08:00|8am/.test(t)) bh = [8, 17];
  return bh ? { businessHours: bh } : undefined;
}

// Normalize to local ISO (no Z) “YYYY-MM-DDTHH:mm:ss”
function normalizeLocalISO(input?: string): string | null {
  if (!input) return null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(input) && !/Z$/.test(input)) return input.slice(0, 19);
  const d = new Date(input);
  if (isNaN(d.getTime())) return null;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const HH = String(d.getHours()).padStart(2, '0');
  const MM = String(d.getMinutes()).padStart(2, '0');
  const SS = String(d.getSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${HH}:${MM}:${SS}`;
}

function durationMs(start?: string, end?: string, hoursFallback?: number) {
  if (start && end) {
    const s = new Date(start).getTime();
    const e = new Date(end).getTime();
    if (isFinite(s) && isFinite(e) && e > s) return e - s;
  }
  return Math.max(3600000, Math.round((hoursFallback ?? 1) * 3600000));
}

// Fallback-safe ops id getter (supports opsId, opsID, id)
function opsKey(x: OpsTask): string {
  const any = x as any;
  return String(any.opsId ?? any.opsID ?? any.id ?? '');
}

// Build a preview snapshot from a *new* workorder array vs an *old* baseline
function buildPreviewSnapshot(
  oldWos: WorkOrder[],
  newWos: WorkOrder[],
  opts?: { moved?: string[]; scheduled?: string[]; unscheduled?: string[]; summary?: string[] }
): PlanSnapshot {
  const idxOld = new Map(oldWos.map(w => [w.id, w]));
  const moved: string[] = [];
  const newlyScheduled: string[] = [];
  const nowUnscheduled: string[] = [];

  const ids = new Set<string>([...oldWos.map(w => w.id), ...newWos.map(w => w.id)]);
  for (const id of ids) {
    const a = idxOld.get(id);
    const b = newWos.find(w => w.id === id);
    const aSched = !!(a && a.status === 'Scheduled' && a.start);
    const bSched = !!(b && b.status === 'Scheduled' && b.start);
    if (aSched && bSched) {
      if (a!.start !== b!.start || a!.end !== b!.end) moved.push(id);
    } else if (!aSched && bSched) {
      newlyScheduled.push(id);
    } else if (aSched && !bSched) {
      nowUnscheduled.push(id);
    }
  }

  return {
    workorders: newWos,
    summary: opts?.summary ?? [],
    moved: moved.length,
    scheduled: newlyScheduled.length,
    unscheduled: nowUnscheduled.length,
    movedIds: moved,
    scheduledIds: newlyScheduled,
    unscheduledIds: nowUnscheduled,
    when: new Date().toISOString(),
    status: 'preview',
  };
}

// ============ Component ============

export default function Dashboard() {
  // Seed simplified tech model once
  useEffect(() => { reseedGenericTechnicians(); }, []);

  // Base data
  const vehicles = useMemo(() => getVehicles(20), []);
  const [workorders, setWorkorders] = useState(() => getWorkOrders());
  const [opsTasks, setOpsTasks] = useState<OpsTask[]>(() => getOpsTasks(7)); // stateful so we can mutate

  // UI state
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | null>(null);

  const [woOpen, setWoOpen] = useState(false);
  const [modalIgnoreVehicle, setModalIgnoreVehicle] = useState(false);
  const [focusedWorkOrderId, setFocusedWorkOrderId] = useState<string | null>(null);

  // Planning state
  const [preview, setPreview] = useState<PlanSnapshot | null>(null);
  const [planHistory, setPlanHistory] = useState<PlanSnapshot[]>([]);

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
      // NOTE: do not pass opsTasks here unless your buildKnowledgePack signature supports it
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

  const agentSuggest = async (policy?: SimplePolicy) => {
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

  // onSuggest wrapper for AgentConsole signature (policy?: unknown)
  const onSuggestWrapper = async (policy?: unknown) => {
    let narrowed: SimplePolicy | undefined = undefined;
    if (policy && typeof policy === 'object') {
      const p = policy as Partial<SimplePolicy>;
      if (
        p.businessHours &&
        Array.isArray(p.businessHours) &&
        p.businessHours.length === 2 &&
        typeof p.businessHours[0] === 'number' &&
        typeof p.businessHours[1] === 'number'
      ) {
        narrowed = { businessHours: [p.businessHours[0], p.businessHours[1]] };
      }
    }
    return agentSuggest(narrowed);
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

  // ====== Apply agent mutations LOCALLY to preview (so Gantt updates immediately) ======
  type GenericMutation = {
    op: string;
    id?: string;       // WO id or Ops id (fallback)
    woId?: string;
    opsId?: string;
    vehicleId?: string;
    startISO?: string;
    endISO?: string;
    hours?: number;
    title?: string;
    priority?: string;
    type?: string;     // 'PM' | 'CM' etc.
    requiredSkills?: string[];
  };

  const applyMutationsLocally = (mutations: GenericMutation[]) => {
    const baseline = preview ? preview.workorders : workorders;
    const wos = baseline.map(w => ({ ...w }));
    let ops = opsTasks.map(t => ({ ...t }));

    const summary: string[] = [];
    const movedIdsManual: string[] = [];
    const scheduledIdsManual: string[] = [];
    const unscheduledIdsManual: string[] = [];

    const idOr = (m: GenericMutation) => m.woId || m.opsId || m.id;

    for (const m of mutations) {
      const op = (m.op || '').toUpperCase();

      if (op === 'MOVE_WORKORDER') {
        const id = m.woId || m.id;
        if (!id) { summary.push('MOVE_WORKORDER: missing id'); continue; }
        const w = wos.find(x => x.id === id);
        if (!w) { summary.push(`MOVE_WORKORDER: ${id} not found`); continue; }
        const sLocal = normalizeLocalISO(m.startISO);
        if (!sLocal) { summary.push(`MOVE_WORKORDER: ${id} invalid start`); continue; }
        const dur = durationMs(w.start, w.end, w.hours);
        const eLocal = normalizeLocalISO(new Date(new Date(sLocal).getTime() + dur).toISOString())!;
        w.start = sLocal;
        w.end = eLocal;
        w.status = 'Scheduled';
        movedIdsManual.push(id);
        summary.push(`Moved ${id} → ${sLocal.slice(11,16)}`);
      }

      else if (op === 'MOVE_OPS' || op === 'MOVE_OP') {
        const oid = idOr(m);
        if (!oid) { summary.push('MOVE_OPS: missing opsId'); continue; }
        const t = ops.find(x => opsKey(x) === oid);
        if (!t) { summary.push(`MOVE_OPS: ${oid} not found`); continue; }
        const sLocal = normalizeLocalISO(m.startISO);
        if (!sLocal) { summary.push(`MOVE_OPS: ${oid} invalid start`); continue; }
        const dur = durationMs(t.start, t.end, undefined);
        const eLocal = normalizeLocalISO(new Date(new Date(sLocal).getTime() + dur).toISOString())!;
        t.start = sLocal;
        t.end = eLocal;
        summary.push(`Moved Ops ${oid} → ${sLocal.slice(0,16).replace('T',' ')}`);
      }

      else if (op === 'CANCEL_OPS') {
        const oid = idOr(m);
        if (!oid) { summary.push('CANCEL_OPS: missing id'); continue; }
        const before = ops.length;
        ops = ops.filter(x => opsKey(x) !== oid);
        const removed = before - ops.length;
        summary.push(removed ? `Cancelled Ops ${oid}` : `CANCEL_OPS: ${oid} not found`);
      }

      else if (op === 'ADD_WORKORDER') {
        const vid = m.vehicleId;
        if (!vid) { summary.push('ADD_WORKORDER: missing vehicleId'); continue; }
        const newId = m.id || m.woId || `WO-${Math.floor(100 + Math.random()*900)}`;
        const sLocal = normalizeLocalISO(m.startISO) || '2025-08-22T09:00:00';
        const dur = Math.max(1, Math.round((m.hours ?? 1)));
        const eLocal = normalizeLocalISO(new Date(new Date(sLocal).getTime() + dur*3600000).toISOString())!;
        const w: WorkOrder = {
          id: newId,
          vehicleId: vid,
          title: m.title || 'Inspection',
          type: (m.type as any) || 'CM',
          priority: (m.priority as any) || 'Medium',
          status: 'Scheduled',
          hours: dur,
          start: sLocal,
          end: eLocal,
          subsystem: undefined,
          //partId: undefined,               // NOTE: partId (not partID)
          requiredSkills: (m.requiredSkills as any) || ['Mechanic'],
          requiredParts: [],
          requiredTools: [],
          description: 'Added by Scheduler Agent',
        };
        wos.push(w);
        scheduledIdsManual.push(newId);
        summary.push(`Created ${newId} on ${vid} (${w.title})`);
      }

      else if (op === 'CANCEL_WORKORDER') {
        const id = m.woId || m.id;
        if (!id) { summary.push('CANCEL_WORKORDER: missing id'); continue; }
        const w = wos.find(x => x.id === id);
        if (!w) { summary.push(`CANCEL_WORKORDER: ${id} not found`); continue; }
        // mark as closed in preview
        w.status = 'Closed';
        unscheduledIdsManual.push(id);
        summary.push(`Cancelled ${id}`);
      }

      else {
        summary.push(`Unknown mutation ${op} — ignored`);
      }
    }

    // Build preview and surface immediately
    const snap = buildPreviewSnapshot(preview ? preview.workorders : workorders, wos, {
      moved: movedIdsManual,
      scheduled: scheduledIdsManual,
      unscheduled: unscheduledIdsManual,
      summary,
    });
    setPreview(snap);
    setOpsTasks(ops); // reflect ops changes too
    return summary;
  };

  const handleDecisionSideEffects = (d: AgentDecision) => {
    if (d.intent === 'MUTATE' && d.mutations?.length) {
      const notes = applyMutationsLocally(d.mutations as any);
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
          onSuggest={async (policy?: unknown) => {
            let narrowed: SimplePolicy | undefined;
            if (policy && typeof policy === 'object' && (policy as any).businessHours) {
              const bh = (policy as any).businessHours;
              if (Array.isArray(bh) && bh.length === 2 && typeof bh[0] === 'number' && typeof bh[1] === 'number') {
                narrowed = { businessHours: [bh[0], bh[1]] };
              }
            }
            return agentSuggest(narrowed);
          }}
          onAccept={agentAccept}
          onReject={agentReject}
          onReport={agentReport}
          onDecide={async (text, history) => {
            const decision = await agentDecide(text, history);
            if (decision.intent === 'MUTATE') {
              const msg = handleDecisionSideEffects(decision);
              return { intent: 'QA', answer: msg ?? 'Applied the requested changes.' };
            }
            const looksLikeOptimize = /optimi[sz]e|re-?schedule|plan( the)? week|optimize the schedule/i.test(text);
            if (looksLikeOptimize) {
              const policy = inferPolicyFromText(text);
              const res = await agentSuggest(policy);
              const msg = decision.answer
                ? `${decision.answer}\n\nProposed schedule ready — moved ${res.moved}, scheduled ${res.scheduled}, unscheduled ${res.unscheduled}.`
                : `Proposed schedule ready — moved ${res.moved}, scheduled ${res.scheduled}, unscheduled ${res.unscheduled}.`;
              return { intent: 'QA', answer: msg };
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
