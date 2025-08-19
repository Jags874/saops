// scripts/rebaseAllFakeData.cjs
/* Rebase ALL dates in src/data/fake to align the static demo week to 2025-08-22. */
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const FAKE_DIR = path.join(ROOT, 'src', 'data', 'fake');
const OPS_FILE = path.join(FAKE_DIR, 'ops_tasks.json');
const WO_FILE  = path.join(FAKE_DIR, 'workorders.json');

const STATIC_WEEK_START_UTC = new Date(Date.UTC(2025, 7, 22, 0, 0, 0, 0)); // 22 Aug 2025

// ---------- helpers ----------
function listJsonFiles(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const stat = fs.statSync(p);
    if (stat.isDirectory()) out.push(...listJsonFiles(p));
    else if (name.toLowerCase().endsWith('.json')) out.push(p);
  }
  return out;
}
function loadJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function saveJson(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8'); }
function parseISO(s) { const t = Date.parse(s); return Number.isFinite(t) ? new Date(t) : null; }
function startOfDayUTC(d) { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); }

// iso-like string (YYYY-MM-DD or full ISO with time)
const ISO_RE = /^\d{4}-\d{2}-\d{2}(?:[Tt ][\d:.+-Zz]+)?$/;

// Find anchor = earliest scheduled start across ops + scheduled WOs
function findDatasetAnchorUTC() {
  let earliest = null;

  try {
    const ops = loadJson(OPS_FILE);
    for (const t of ops || []) {
      const d = t?.start && ISO_RE.test(String(t.start)) ? parseISO(String(t.start)) : null;
      if (d && (!earliest || d < earliest)) earliest = d;
    }
  } catch {}

  try {
    const wos = loadJson(WO_FILE);
    for (const w of wos || []) {
      const status = String(w?.status || '');
      if ((status === 'Scheduled' || status === 'In Progress') && w?.start && ISO_RE.test(String(w.start))) {
        const d = parseISO(String(w.start));
        if (d && (!earliest || d < earliest)) earliest = d;
      }
    }
  } catch {}

  if (!earliest) {
    // Fallback: scan *all* files for first ISO; we still want consistency
    const files = listJsonFiles(FAKE_DIR);
    for (const f of files) {
      const data = loadJson(f);
      let found = null;
      walk(data, (val) => {
        if (typeof val === 'string' && ISO_RE.test(val)) {
          const d = parseISO(val);
          if (d && (!found || d < found)) found = d;
        }
      });
      if (found && (!earliest || found < earliest)) earliest = found;
    }
  }

  return earliest ? startOfDayUTC(earliest) : new Date(STATIC_WEEK_START_UTC);
}

// walk any JSON value
function walk(node, fn) {
  fn(node);
  if (Array.isArray(node)) {
    for (const v of node) walk(v, fn);
  } else if (node && typeof node === 'object') {
    for (const k of Object.keys(node)) walk(node[k], fn);
  }
}

function shiftNodeDates(node, deltaMs, stats) {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) node[i] = shiftNodeDates(node[i], deltaMs, stats);
    return node;
  } else if (node && typeof node === 'object') {
    for (const k of Object.keys(node)) node[k] = shiftNodeDates(node[k], deltaMs, stats);
    return node;
  } else if (typeof node === 'string') {
    if (ISO_RE.test(node)) {
      const d = parseISO(node);
      if (d) {
        stats.shifted++;
        return new Date(d.getTime() + deltaMs).toISOString();
      }
    }
    return node;
  }
  return node;
}

// ---------- main ----------
(function main() {
  if (!fs.existsSync(FAKE_DIR)) {
    console.error('Cannot find src/data/fake — run from project root.');
    process.exit(1);
  }

  const anchor = findDatasetAnchorUTC();
  const deltaMs = STATIC_WEEK_START_UTC.getTime() - anchor.getTime();

  console.log(`Static demo week start: ${STATIC_WEEK_START_UTC.toISOString().slice(0,10)}`);
  console.log(`Dataset anchor (UTC):  ${anchor.toISOString().slice(0,10)}`);
  console.log(`Delta (days):          ${Math.round(deltaMs / 86400000)}d`);

  if (deltaMs === 0) {
    console.log('Already aligned — no changes needed.');
    return;
  }

  const files = listJsonFiles(FAKE_DIR);
  let totalShifted = 0;

  for (const file of files) {
    const data = loadJson(file);
    const stats = { shifted: 0 };
    const updated = shiftNodeDates(data, deltaMs, stats);
    if (stats.shifted > 0) {
      saveJson(file, updated);
      console.log(`• ${path.relative(ROOT, file)} — shifted ${stats.shifted} timestamps`);
      totalShifted += stats.shifted;
    } else {
      console.log(`• ${path.relative(ROOT, file)} — no dates found`);
    }
  }

  console.log(`Done. Total shifted timestamps: ${totalShifted}`);
})();
