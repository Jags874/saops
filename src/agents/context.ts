// src/agents/context.ts
import type { WorkOrder, OpsTask, Vehicle } from '../types';
import { getOpsTasks, getVehicles } from '../data/adapter';
import { computeClashes } from './scheduler';

/**
 * Static demo anchor (requested): first day shown is 22 Aug 2025.
 * We keep this here so agents can normalize dates consistently.
 */
export const WEEK_START_ISO = '2025-08-22T00:00:00';

type KnowledgePack = {
  meta: {
    weekStartISO: string;     // "2025-08-22T00:00:00"
    horizonDays: number;      // e.g. 7
  };
  vehiclesLite: Array<Pick<Vehicle, 'id' | 'status'>>;
  workorders: WorkOrder[];
  opsTasks: OpsTask[];
  facts: {
    clashCount: number;
    clashes: Array<{
      vehicleId: string;
      woId: string;
      opsId: string;
      woStart: string;
      woEnd: string;
      opsStart: string;
      opsEnd: string;
    }>;
  };
};

/**
 * Build the agent knowledge pack. The Dashboard calls this with:
 *   buildKnowledgePack({ horizonDays, baseWorkorders })
 * We keep the same signature and *also* bring in ops tasks here.
 */
export function buildKnowledgePack(opts: {
  horizonDays: number;
  baseWorkorders: WorkOrder[];
}): KnowledgePack {
  const { horizonDays, baseWorkorders } = opts;

  // Pull this week’s ops tasks internally (no Dashboard signature change)
  const ops = getOpsTasks(horizonDays);

  // Super-light vehicle surface for the LLM
  const vehiclesLite = getVehicles(20).map(v => ({ id: v.id, status: v.status }));

  // Precompute WO vs Ops overlaps (exact, deterministic facts)
  const overlap = computeClashes(baseWorkorders, ops);

  return {
    meta: { weekStartISO: WEEK_START_ISO, horizonDays },
    vehiclesLite,
    workorders: baseWorkorders,
    opsTasks: ops,
    facts: {
      clashCount: overlap.total,
      clashes: overlap.clashes.slice(0, 250), // cap for prompt size
    },
  };
}
