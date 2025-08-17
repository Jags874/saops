// src/data/adapter.ts
import type {
  Vehicle, WorkOrder, OpsTask, PMTask, FailureRecord, DemandRecord,
  Technician, AvailabilitySlot, ConditionSnapshot, Priority, WoType, Skill
} from '../types';

// ---------- helpers ----------
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const iso = (d: Date) => d.toISOString();
const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));
function addHours(d: Date, h: number) { const x = new Date(d); x.setHours(x.getHours() + h); return x; }
function atHour(d: Date, h: number) { const x = new Date(d); x.setHours(h, 0, 0, 0); return x; }
function randInt(a: number, b: number) { return Math.floor(Math.random() * (b - a + 1)) + a; }
function choice<T>(arr: T[]) { return arr[randInt(0, arr.length - 1)]; }

// Stable module caches so data doesn't change every render
let VEHICLES: Vehicle[] | null = null;
let PM: PMTask[] | null = null;
let FAILURES: FailureRecord[] | null = null;
let TECHS: Technician[] | null = null;
let AVAIL: AvailabilitySlot[] | null = null;

// Ops/WO are regenerated for recent horizons but with stable seed per session
let OPS_CACHE = new Map<number, OpsTask[]>(); // key = days
let WO_CACHE: WorkOrder[] | null = null;

// ---------- generators ----------
export function getVehicles(count = 20): Vehicle[] {
  if (VEHICLES) return VEHICLES.slice(0, count);
  const baseImg = '/assets/prime-mover.png';

  const all: Vehicle[] = Array.from({ length: 20 }).map((_, i) => {
    const id = `V${String(i + 1).padStart(3, '0')}`;
    // skew to busy fleet: majority AVAILABLE/DUE, a few DOWN
    const statusPool: Vehicle['status'][] = (i % 9 === 0 || i % 13 === 0) ? ['DOWN'] :
      (i % 3 === 0 ? ['DUE'] : ['AVAILABLE']);
    const status = statusPool[0];

    return {
      id,
      status,
      image: baseImg,
      model: i % 2 === 0 ? 'Kenworth T610' : 'Volvo FH16',
      year: 2019 + (i % 6),
      criticality: (i % 5 === 0) ? 'High' : (i % 2 === 0 ? 'Medium' : 'Low'),
      odometerKm: 300_000 + i * 12_500,
      engineHours: 8_000 + i * 350,
    };
  });

  VEHICLES = all;
  return VEHICLES.slice(0, count);
}

export function getPMTasks(): PMTask[] {
  if (PM) return PM;
  const pm: PMTask[] = [
    { id: 'PM-ENG-500h', title: 'Engine Inspection', subsystem: 'engine', interval: '500h', estimatedHours: 4, requiredSkills: ['Mechanic'] },
    { id: 'PM-BRK-30k', title: 'Brake Inspection', subsystem: 'brakes', interval: '30000km', estimatedHours: 3, requiredSkills: ['Mechanic'] },
    { id: 'PM-TRANS-10w', title: 'Transmission Check', subsystem: 'transmission', interval: '10w', estimatedHours: 3, requiredSkills: ['Mechanic'] },
    { id: 'PM-COOL-90d', title: 'Cooling System Service', subsystem: 'cooling', interval: '90d', estimatedHours: 2, requiredSkills: ['Mechanic'] },
    { id: 'PM-ELEC-180d', title: 'Electrical System Audit', subsystem: 'electrical', interval: '180d', estimatedHours: 2, requiredSkills: ['AutoElec'] },
  ];
  PM = pm;
  return PM;
}

export function getFailures(): FailureRecord[] {
  if (FAILURES) return FAILURES;

  const vehicles = getVehicles(20);
  const subsystems = ['engine', 'brakes', 'transmission', 'cooling', 'electrical'] as const;

  // 180-day history; add anomalies: V003, V007 higher repeat rate
  const now = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() - 180);

  const out: FailureRecord[] = [];
  for (const v of vehicles) {
    const baseCount = (v.id === 'V003' || v.id === 'V007') ? 18 : randInt(5, 12);
    for (let i = 0; i < baseCount; i++) {
      const day = new Date(start);
      day.setDate(start.getDate() + randInt(0, 179));
      const subsystem = (v.id === 'V003' ? 'brakes' : v.id === 'V007' ? 'cooling' : choice(subsystems as unknown as string[]));
      const failure_mode =
        subsystem === 'brakes' ? choice(['pad wear', 'caliper stick', 'line leak']) :
        subsystem === 'cooling' ? choice(['hose leak', 'pump failure', 'thermostat']) :
        choice(['sensor', 'seal', 'fatigue', 'overheat']);

      out.push({
        vehicleId: v.id,
        subsystem,
        failure_mode,
        date: iso(day),
        downtime_hours: randInt(2, 12),
      });
    }
  }
  FAILURES = out.sort((a, b) => a.date.localeCompare(b.date));
  return FAILURES;
}

export function getTechnicians(): Technician[] {
  if (TECHS) return TECHS;
  // 6 techs total (scarce), generic skills
  TECHS = [
    { id: 'techA', name: 'Alex',  skills: ['Mechanic'], depot: 'Depot A' },
    { id: 'techB', name: 'Bailey',skills: ['Mechanic'], depot: 'Depot A' },
    { id: 'techC', name: 'Casey', skills: ['Mechanic'], depot: 'Depot B' },
    { id: 'techD', name: 'Drew',  skills: ['Mechanic'], depot: 'Depot B' },
    { id: 'techE', name: 'Eden',  skills: ['AutoElec'], depot: 'Depot A' },
    { id: 'techF', name: 'Flynn', skills: ['AutoElec'], depot: 'Depot B' },
  ];
  return TECHS;
}

export function getAvailability(): AvailabilitySlot[] {
  if (AVAIL) return AVAIL;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const techs = getTechnicians();

  const slots: AvailabilitySlot[] = [];
  for (let d = 0; d < 14; d++) {
    const when = new Date(today); when.setDate(when.getDate() + d);
    const date = ymd(when);
    for (const t of techs) {
      // one random short day per tech to create constraints
      const hours = (d % randInt(5, 8) === 0) ? 4 : 8;
      slots.push({ technicianId: t.id, date, hours });
    }
  }
  AVAIL = slots;
  return AVAIL;
}

// Generate dense transport demand: 4–20h ops tasks per vehicle, many hours per day
export function getOpsTasks(days = 7): OpsTask[] {
  if (OPS_CACHE.has(days)) return OPS_CACHE.get(days)!;

  const vehicles = getVehicles(20);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const tasks: OpsTask[] = [];

  for (const v of vehicles) {
    for (let d = 0; d < days; d++) {
      const startDay = new Date(today); startDay.setDate(startDay.getDate() + d);

      // 1–3 trips per day per vehicle, 4–20h total
      const trips = randInt(1, 3);
      let remaining = randInt(8, 16); // dense usage target
      for (let t = 0; t < trips; t++) {
        const chunk = clamp(randInt(4, 10), 2, remaining);
        remaining = Math.max(0, remaining - chunk);
        const sHour = randInt(5, 20 - chunk); // between 05:00 and (20 - chunk)
        const s = atHour(startDay, sHour);
        const e = addHours(s, chunk);
        tasks.push({
          id: `OP-${v.id}-${d}-${t}`,
          vehicleId: v.id,
          title: 'Transport Task',
          start: iso(s),
          end: iso(e),
          hours: chunk,
        });
        if (remaining <= 0) break;
      }
    }
  }

  OPS_CACHE.set(days, tasks);
  return tasks;
}

export function getDemandHistory(days = 7): DemandRecord[] {
  // Aggregate ops hours by day (fleet total)
  const ops = getOpsTasks(days);
  const byDay = new Map<string, number>();
  for (const t of ops) {
    const day = t.start.slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + (t.hours ?? 0));
  }
  return Array.from(byDay.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, hours]) => ({ date, hours }));
}

// Work orders: mix of scheduled & open; include requiredSkills & parts with partId
export function getWorkOrders(): WorkOrder[] {
  if (WO_CACHE) return WO_CACHE;

  const vehicles = getVehicles(20);
  const pm = getPMTasks();
  const now = new Date(); now.setHours(0, 0, 0, 0);

  const makeWO = (
    id: string,
    vehicleId: string,
    title: string,
    type: WoType,
    priority: Priority,
    hours: number,
    subsystem?: string,
    requiredSkills?: Skill[],
    scheduled?: { dayOffset: number; startHour: number }
  ): WorkOrder => {
    let start: string | undefined;
    let end: string | undefined;
    let status: WorkOrder['status'] = 'Open';
    if (scheduled) {
      const s = new Date(now); s.setDate(s.getDate() + scheduled.dayOffset);
      const ss = atHour(s, scheduled.startHour);
      const ee = addHours(ss, hours);
      start = iso(ss); end = iso(ee);
      status = 'Scheduled';
    }
    return {
      id, vehicleId, title, type, priority, status, subsystem, hours,
      requiredSkills: requiredSkills && requiredSkills.length ? requiredSkills : (subsystem === 'electrical' ? ['AutoElec'] : ['Mechanic']),
      parts: subsystem === 'cooling' ? [{ partId: 'P-221', qty: 1 }] :
             subsystem === 'brakes' ? [{ partId: 'P-201', qty: 1 }] : undefined,
      created: iso(addHours(now, -randInt(24, 24 * 14))),
      start, end
    };
  };

  const out: WorkOrder[] = [];
  // A few PM per vehicle + some corrective
  let counter = 1;
  for (const v of vehicles) {
    // Preventive
    for (let i = 0; i < 1; i++) {
      const p = pm[randInt(0, pm.length - 1)];
      out.push(makeWO(
        `WO-${String(counter++).padStart(3, '0')}`,
        v.id,
        p.title,
        'Preventive',
        choice<Priority>(['High', 'Medium', 'Low']),
        p.estimatedHours ?? 2,
        p.subsystem,
        p.requiredSkills,
        // half of PM scheduled within next 7 days
        Math.random() < 0.5 ? { dayOffset: randInt(0, 6), startHour: randInt(6, 18) } : undefined
      ));
    }

    // Corrective (based on failures bias)
    const bias = (v.id === 'V003' ? 'brakes' : v.id === 'V007' ? 'cooling' : choice(['engine','brakes','transmission','cooling','electrical']));
    const correctiveCount = randInt(1, 2);
    for (let j = 0; j < correctiveCount; j++) {
      const h = randInt(2, 6);
      out.push(makeWO(
        `WO-${String(counter++).padStart(3, '0')}`,
        v.id,
        `Corrective for ${bias}`,
        'Corrective',
        choice<Priority>(['Critical', 'High', 'Medium']),
        h,
        bias,
        bias === 'electrical' ? ['AutoElec'] : ['Mechanic'],
        // some open, some scheduled
        Math.random() < 0.4 ? { dayOffset: randInt(0, 6), startHour: randInt(6, 20 - h) } : undefined
      ));
    }
  }

  // Mark a few as in progress / closed for variety
  for (const w of out.slice(0, 5)) w.status = 'In Progress';
  for (const w of out.slice(5, 8)) w.status = 'Closed';

  WO_CACHE = out;
  return WO_CACHE;
}

export function getConditions(): ConditionSnapshot[] {
  const vehicles = getVehicles(20);
  const subsystems = ['engine', 'brakes', 'transmission', 'cooling', 'electrical'];
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const snaps: ConditionSnapshot[] = [];
  for (let d = 0; d < 7; d++) {
    const when = new Date(today); when.setDate(when.getDate() - d);
    const date = iso(when);
    for (const v of vehicles) {
      const bands: Record<string, 'Good' | 'Fair' | 'Poor'> = {};
      for (const s of subsystems) {
        const r = Math.random();
        bands[s] = r < 0.7 ? 'Good' : r < 0.9 ? 'Fair' : 'Poor';
      }
      // Make V003 brakes & V007 cooling slightly worse
      if (v.id === 'V003') bands['brakes'] = Math.random() < 0.6 ? 'Poor' : bands['brakes'];
      if (v.id === 'V007') bands['cooling'] = Math.random() < 0.6 ? 'Poor' : bands['cooling'];

      snaps.push({ vehicleId: v.id, date, bands });
    }
  }
  return snaps;
}
