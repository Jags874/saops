// scripts/fixData.js
// Enforce dataset consistency rules:
// - AVAILABLE: only Low priority open/scheduled/in-progress WOs
// - DUE: only Low/Medium; must have a scheduled PM within the 7-day window
// - DOWN: must have at least one High priority Corrective WO
//
// It reads JSONs from src/data/fake and writes back workorders.json.

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const F = (p) => path.join(ROOT, 'src', 'data', 'fake', p);

function readJson(file) {
  return JSON.parse(fs.readFileSync(F(file), 'utf-8'));
}
function writeJson(file, obj) {
  fs.writeFileSync(F(file), JSON.stringify(obj, null, 2));
  console.log('wrote', file);
}

function iso(d) {
  return d.toISOString();
}
function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function toDate(x) {
  return new Date(x);
}
function inWindow(dt, start, days = 7) {
  const end = new Date(start);
  end.setDate(start.getDate() + days);
  return dt >= start && dt < end;
}

function capPriorityByStatus(vehicleStatus, priority) {
  const order = ['Low', 'Medium', 'High', 'Critical'];
  const idx = order.includes(priority) ? order.indexOf(priority) : 1;
  if (vehicleStatus === 'AVAILABLE') return 'Low';
  if (vehicleStatus === 'DUE') return idx > order.indexOf('Medium') ? 'Medium' : priority;
  return priority; // DOWN unchanged
}

// Find a non-overlapping night slot for this vehicle/day if possible
function findNightSlotNoOps(opsForVehicle, dayStart, hours) {
  // try from 19:00..(23:00 - hours)
  const base = new Date(dayStart);
  base.setHours(19, 0, 0, 0);
  for (let h = 19; h <= 23 - hours; h++) {
    const s = new Date(dayStart); s.setHours(h, 0, 0, 0);
    const e = new Date(s); e.setHours(e.getHours() + hours);
    const clash = opsForVehicle.some(t => {
      const ts = toDate(t.start), te = toDate(t.end);
      return s < te && ts < e; // overlap
    });
    if (!clash) return { start: s, end: e };
  }
  // fallback: schedule even if overlapping at 19:00
  return { start: base, end: new Date(base.getTime() + hours * 3600 * 1000) };
}

function main() {
  const vehicles = readJson('vehicles.json');
  const workorders = readJson('workorders.json');
  const pm = readJson('pm.json');
  const ops = readJson('ops_tasks.json');

  // Determine dataset's "week 0" from earliest ops start
  const minStart = ops.length ? ops.map(t => toDate(t.start)).reduce((a, b) => a < b ? a : b) : new Date();
  const week0 = startOfDay(minStart);

  // Index helpers
  const woByVehicle = new Map();
  for (const w of workorders) {
    const k = w.vehicleId;
    if (!woByVehicle.has(k)) woByVehicle.set(k, []);
    woByVehicle.get(k).push(w);
  }
  const opsByVehicleByDay = new Map();
  for (const t of ops) {
    const k = t.vehicleId;
    const d = startOfDay(toDate(t.start)).toISOString().slice(0, 10);
    const key = `${k}:${d}`;
    if (!opsByVehicleByDay.has(key)) opsByVehicleByDay.set(key, []);
    opsByVehicleByDay.get(key).push(t);
  }

  // Unique WO id generator
  const existingIds = new Set(workorders.map(w => w.id));
  function nextId() {
    let i = 1;
    while (true) {
      const id = `WO-${String(i).padStart(3, '0')}`;
      if (!existingIds.has(id)) { existingIds.add(id); return id; }
      i++;
    }
  }

  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const subsToSkill = (s) => (s === 'electrical' ? ['AutoElec'] : ['Mechanic']);

  let adjustedPriorities = 0;
  let createdDuePM = 0;
  let createdDownCM = 0;

  for (const v of vehicles) {
    const vId = v.id;
    const vStatus = v.status; // AVAILABLE | DUE | DOWN
    const wos = woByVehicle.get(vId) || [];

    // 1) Cap priorities for non-Closed WOs
    for (const w of wos) {
      if (w.status === 'Closed') continue;
      const before = w.priority;
      const after = capPriorityByStatus(vStatus, before);
      if (after !== before) {
        w.priority = after;
        adjustedPriorities++;
      }
    }

    // 2) DUE → ensure a scheduled PM inside 7-day window starting week0
    if (vStatus === 'DUE') {
      const hasScheduledPM = wos.some(w =>
        w.type === 'Preventive' &&
        (w.status === 'Scheduled' || w.status === 'In Progress') &&
        w.start && inWindow(toDate(w.start), week0, 7)
      );
      if (!hasScheduledPM) {
        const p = pick(pm);
        const hours = Number(p.estimatedHours ?? 2);
        let placed = null;

        // Try each day within 0..6
        for (let d = 0; d < 7 && !placed; d++) {
          const day = new Date(week0); day.setDate(week0.getDate() + d);
          const key = `${vId}:${day.toISOString().slice(0,10)}`;
          const opsForDay = opsByVehicleByDay.get(key) || [];
          const slot = findNightSlotNoOps(opsForDay, day, hours);
          placed = slot;
        }
        if (!placed) {
          const day = week0;
          const slot = findNightSlotNoOps([], day, hours);
          placed = slot;
        }

        const nw = {
          id: nextId(),
          vehicleId: vId,
          title: p.title,
          type: 'Preventive',
          priority: 'Medium', // allowed for DUE
          status: 'Scheduled',
          subsystem: p.subsystem,
          hours,
          requiredSkills: p.requiredSkills && p.requiredSkills.length ? p.requiredSkills : subsToSkill(p.subsystem),
          created: iso(new Date(week0.getTime() - 3 * 86400000)),
          start: iso(placed.start),
          end: iso(placed.end),
        };
        workorders.push(nw);
        wos.push(nw);
        createdDuePM++;
      }
    }

    // 3) DOWN → ensure at least one High priority Corrective WO
    if (vStatus === 'DOWN') {
      const hasHighCM = wos.some(w =>
        w.type === 'Corrective' &&
        (w.priority === 'High' || w.priority === 'Critical') &&
        (w.status === 'Open' || w.status === 'Scheduled' || w.status === 'In Progress')
      );
      if (!hasHighCM) {
        const subs = ['engine','brakes','transmission','cooling','electrical'];
        const sub = pick(subs);
        const hours = Math.max(4, Math.min(8, Math.round(Math.random() * 6) + 2));

        // Start at day 0 morning; “In Progress”
        const s = new Date(week0); s.setHours(9,0,0,0);
        const e = new Date(s); e.setHours(e.getHours() + hours);

        const nw = {
          id: nextId(),
          vehicleId: vId,
          title: `Restore to service - ${sub}`,
          type: 'Corrective',
          priority: 'High',
          status: 'In Progress',
          subsystem: sub,
          hours,
          requiredSkills: subsToSkill(sub),
          created: iso(new Date(week0.getTime() - 2 * 86400000)),
          start: iso(s),
          end: iso(e),
        };
        workorders.push(nw);
        createdDownCM++;
      }
    }
  }

  writeJson('workorders.json', workorders);
  console.log(`Adjusted priorities: ${adjustedPriorities}`);
  console.log(`Created PMs for DUE vehicles: ${createdDuePM}`);
  console.log(`Created High-CM for DOWN vehicles: ${createdDownCM}`);
}

main();
