// Background refresh of the Infobox History saved records (data/history/*.json).
// Run by .github/workflows/refresh-history.yml — the only writer of those files.
// Locally (reads Wikimedia, writes only the local record files):
//
//   node scripts/refresh-history.mjs [--mode new|full] [--budget-min N]
//        [--only <record file name>]
//        [--add "<input>" --depth N [--count N] [--exclude "Category:A|Category:B"]]
//
// Every run (weekly, --mode new):
//   1. finish any unfinished scan (`pending` files),
//   2. check every stored person's current photo (batched) and rebuild the
//      history only of those whose photo changed,
//   3. list the whole category tree: files added since the watermark become
//      pending and are scanned; people whose current photo is no longer in the
//      tree are flagged `outside`.
// --mode full (monthly) additionally re-checks every file in the tree, catching
// photos that later gained a depicts statement or became the infobox photo.
// An unfinished re-check is carried on by the following runs.
//
// Time-boxed (--budget-min): when the budget runs out, the progress (pending
// files, re-check cursor) is in the record and the next run continues from it.
// Records are written atomically after every chunk, so even a killed job leaves
// a consistent file for the workflow's commit step.
//
// Wikimedia bot etiquette: a descriptive User-Agent with contact details
// (WIKIMEDIA_CONTACT, kept in an Actions secret, is appended when set), maxlag=5
// with >= 5 s waits on lag (Wikidata:Bots asks bots to respect maxlag; on
// Wikidata it includes Query Service lag), serial requests paced under the
// 200/min limit for identified unauthenticated bots (Wikimedia_APIs/Rate_limits, 2026).
// A bad --add is reported and skipped; the existing records are still refreshed.

import { readFile, writeFile, readdir, rename, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import * as core from "../history-core.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { values: args } = parseArgs({ options: {
  mode: { type: "string" }, "budget-min": { type: "string" }, only: { type: "string" },
  add: { type: "string" }, depth: { type: "string" }, count: { type: "string" },
  exclude: { type: "string" },
} });
const MODE = args.mode || process.env.MODE || "new";
// Clamped to finish (and commit) inside the workflow's 350-minute job limit.
const BUDGET_MIN = Math.min(330, Math.max(1, Number(args["budget-min"] || process.env.BUDGET_MIN) || 320));
const CHUNK = 500;                      // files per processFiles call; a checkpoint follows each
const REQS_PER_MIN = 180;               // under the 200/min bot limit, with headroom
if (!["new", "full"].includes(MODE)) throw new Error(`--mode must be new or full, not ${MODE}`);

const contact = (process.env.WIKIMEDIA_CONTACT || "").trim();
core.configureApi({
  userAgent: `WikimediaInfoboxCheckerBot/1.0 (https://github.com/Landsil/Wikimedia-Infobox-Checker`
    + `${contact ? "; " + contact : ""}) node/${process.versions.node}`,
  maxlag: 5,
  maxLagWaitMs: 60 * 60000,             // give up (save, stop; next run continues) after 60 min of lag
  minIntervalMs: Math.ceil(60000 / REQS_PER_MIN),
});

const deadline = Date.now() + BUDGET_MIN * 60000;
class OutOfTime extends Error {}
const checkTime = () => { if (Date.now() > deadline) throw new OutOfTime(`time budget (${BUDGET_MIN} min) used up`); };
const now = () => new Date().toISOString();
const log = msg => console.log(`[${now().slice(11, 19)}] ${msg}`);
// At most one line per `ms` (long phases would otherwise be silent, or flood the log).
const every = (ms, f) => { let t = 0; return msg => { if (Date.now() - t >= ms) { t = Date.now(); f(msg); } }; };
const mins = ms => ms < 60000 ? `${Math.round(ms / 1000)} s`
  : ms < 3600000 ? `${Math.round(ms / 60000)} min`
  : `${Math.floor(ms / 3600000)} h ${String(Math.floor(ms % 3600000 / 60000)).padStart(2, "0")} min`;
const summary = [];

// ---- record <-> working state ----
const fromRecord = rec => ({
  rec,
  people: (rec.people || []).map(p => ({ ...p, shown: core.timelineFromJson(p.timeline) })),
  done: new Set(rec.done || []),
  pending: Array.isArray(rec.pending) ? rec.pending.slice() : null,   // null: legacy, list not stored
  scanned: rec.scanned || 0,
  addedThrough: rec.addedThrough || "",
  bg: { ...(rec.bg || {}) },
});
function toRecord(st) {
  const { rec } = st;
  const base = { schema: 1, algoVersion: core.ALGO_VERSION, identity: rec.identity, asOf: now(), input: rec.input };
  if (rec.type !== "category") return { ...rec, ...base, bg: st.bg };
  for (const p of st.people) st.done.add(p.lang + ":" + p.article);
  return { ...base, type: "category", count: rec.count, addedThrough: st.addedThrough,
    ...(rec.exclude && rec.exclude.length ? { exclude: rec.exclude } : {}),
    uncapped: rec.uncapped, scanned: st.scanned, pending: st.pending, done: [...st.done],
    people: st.people.map(p => ({ lang: p.lang, article: p.article, label: p.label || null,
      qid: p.qid || null, topRev: p.topRev || null, more: !!p.more, lead: p.lead || null,
      ...(p.outside ? { outside: true } : {}), timeline: core.timelineToJson(p.shown) })),
    depth: rec.depth, bg: st.bg };
}
async function save(path, obj) {
  // Same formatting the browser Save used, so diffs between runs stay readable.
  await writeFile(path + ".tmp", JSON.stringify(obj, null, 2));
  await rename(path + ".tmp", path);
}

// ---- category record ----
// Scan st.pending in chunks, checkpointing after each. Stops (throws OutOfTime)
// between chunks when the budget is used up; nothing is lost.
async function drainPending(st, path, why) {
  const total = st.pending.length;
  let found = 0;
  while (st.pending.length) {
    checkTime();
    const batch = st.pending.slice(0, CHUNK);
    const { people, doneKeys } = await core.processFiles(batch,
      { done: st.done, count: st.rec.count, known: core.knownPeople(st.people) });
    st.people.push(...people); found += people.length;
    for (const k of doneKeys) st.done.add(k);
    st.pending.splice(0, batch.length);
    st.scanned += batch.length;
    await save(path, toRecord(st));
    log(`  ${why}: ${total - st.pending.length}/${total} files, +${found} people`);
  }
  return found;
}
// `out` collects one summary phrase per finished phase; it's the caller's, so
// a run that stops part-way still reports what it did.
async function refreshCategory(st, path, out) {
  const { rec } = st, title = rec.input.title, depth = rec.depth;
  // 1. Legacy records saved mid-scan without their pending list: rebuild it the
  //    way the page always did (re-enumerate, skip the scanned count). No
  //    `exclude`: the skip count only lines up with the walk that produced it.
  if (st.pending === null) {
    log("  rebuilding the pending list (record didn't store it)…");
    const { files } = await core.walkCategory(title, depth, { cap: rec.uncapped ? Infinity : core.CAT_FILE_CAP });
    st.pending = files.slice(st.scanned);
    await save(path, toRecord(st));
  }
  if (st.pending.length) out.push(`finished scan: +${await drainPending(st, path, "unfinished scan")} people`);
  // 2. People whose current photo changed (one batched lookup per 50 people).
  checkTime();
  const t0 = Date.now();
  const r = await core.refreshPeople(st.people, rec.count, { onProgress: every(60000, m => log(`  people: ${m}`)) });
  out.push(`${r.checked} people checked: ${r.rebuilt} rebuilt (photo changed), ${r.filled} missing current photo filled in (${mins(Date.now() - t0)})`);
  log(`  people: ${r.checked} checked, ${r.rebuilt} rebuilt, ${r.filled} filled in`);
  await save(path, toRecord(st));
  // 3. Whole tree: new files become pending; flag people no longer in it.
  checkTime();
  const { files: tree, added, addedThrough } = await core.walkCategory(title, depth,
    { cap: Infinity, since: st.addedThrough, exclude: rec.exclude || [] });
  core.flagOutside(st.people, tree);
  const seen = new Set(st.pending);
  st.pending.push(...added.filter(f => !seen.has(f)));
  if (addedThrough > st.addedThrough) st.addedThrough = addedThrough;
  await save(path, toRecord(st));
  out.push(`${added.length} new files: +${await drainPending(st, path, "new files")} people`);
  out.push(`${st.people.filter(p => p.outside).length} flagged no longer from this category`);
  // 4. Monthly (or carrying on an unfinished one): re-check every file.
  if (MODE === "full" && !st.bg.recheck) st.bg.recheck = { startedAt: now(), cursor: "" };
  if (st.bg.recheck) {
    const todo = tree.slice().sort().filter(f => f > st.bg.recheck.cursor);
    let found = 0, done = 0;
    for (let i = 0; i < todo.length; i += CHUNK) {
      checkTime();
      const batch = todo.slice(i, i + CHUNK);
      const { people, doneKeys } = await core.processFiles(batch,
        { done: st.done, count: rec.count, known: core.knownPeople(st.people) });
      st.people.push(...people); found += people.length; done += batch.length;
      for (const k of doneKeys) st.done.add(k);
      st.bg.recheck.cursor = batch[batch.length - 1];
      await save(path, toRecord(st));
      log(`  re-check: ${done}/${todo.length} files, +${found} people`);
    }
    st.bg.lastFull = now(); delete st.bg.recheck;
    out.push(`full re-check of ${tree.length} files: +${found} people`);
  }
}

// ---- single (article / file) record ----
async function refreshSingle(st, out) {
  const { rec } = st;
  checkTime();
  rec.lead = await core.currentLead(rec.lang, rec.article);
  const top = await core.currentTopRev(rec.lang, rec.article);
  if (!top || top === rec.topRev) { out.push("unchanged"); return; }
  const res = await core.buildTimeline(rec.lang, rec.article, core.SINGLE_REV_LIMIT, rec.count, null, { allowFallback: true });
  if (!res.timeline.length) { out.push("changed, but no infobox photo found — kept as was"); return; }
  Object.assign(rec, { topRev: res.topRev, more: res.more, cont: res.cont || null, fullContent: !!res.usedFull,
    scanned: res.read, timeline: core.timelineToJson(res.timeline) });
  out.push("history rebuilt");
}

// ---- --add: create a new record (then refreshed like any other) ----
async function addRecord(raw, depth, count, exclude) {
  const inp = core.parseInput(raw);
  if (!inp) throw new Error(`--add: can't parse "${raw}"`);
  const path = join(ROOT, core.cachePath(inp));
  if (existsSync(path)) { log(`--add: ${core.cacheIdentity(inp)} already has a record; refreshing it`); return path; }
  const base = { schema: 1, algoVersion: core.ALGO_VERSION, identity: core.cacheIdentity(inp), asOf: now(), input: inp };
  let rec;
  if (inp.type === "category") {
    const { files, addedThrough } = await core.walkCategory(inp.title, depth, { cap: Infinity, exclude });
    if (!files.length) throw new Error(`--add: no files in ${inp.title} at depth ${depth}`);
    rec = { ...base, type: "category", count, addedThrough, uncapped: true, scanned: 0,
      pending: files, done: [], people: [], depth, ...(exclude.length ? { exclude } : {}), bg: {} };
  } else {
    let lang = inp.lang, article = inp.title, label = null, qid = null;
    if (inp.type === "file") {
      const r = await core.resolveSubjectFromFile(inp.title);
      if (r.error) throw new Error(`--add: ${r.error}`);
      ({ lang, article, label, qid } = r);
    }
    const lead = await core.currentLead(lang, article);
    const res = await core.buildTimeline(lang, article, core.SINGLE_REV_LIMIT, count, null, { allowFallback: true });
    if (!res.timeline.length && !lead) throw new Error(`--add: no infobox photo found in ${article}'s history`);
    rec = { ...base, type: "single", count, lang, article, label, qid, topRev: res.topRev || null,
      more: !!res.more, cont: res.cont || null, fullContent: !!res.usedFull, scanned: res.read,
      lead, timeline: core.timelineToJson(res.timeline), bg: {} };
  }
  await save(path, rec);
  summary.push(`- added ${rec.identity}`);
  return path;
}

// ---- main ----
async function refreshRecord(path) {
  const rec = JSON.parse(await readFile(path, "utf8"));
  const name = basename(path);
  if (rec.algoVersion !== core.ALGO_VERSION) { summary.push(`- ${name}: skipped (algoVersion ${rec.algoVersion} ≠ ${core.ALGO_VERSION})`); return; }
  if (rec.type === "category" && !Number.isInteger(rec.depth)) {
    summary.push(`- ${name}: skipped — record has no subcategory depth; add "depth" to it`); return;
  }
  log(`${rec.identity} (${MODE})`);
  const st = fromRecord(rec);
  const out = [], t0 = Date.now(), s0 = core.apiStats();
  // One summary line per record, whatever happened: what was done, how long it
  // took, how much of that was waiting on Wikimedia lag, and why it stopped.
  const line = end => {
    const s = core.apiStats();
    const known = s.qidsKnown - s0.qidsKnown, fetched = s.qidsFetched - s0.qidsFetched;
    const cost = `${mins(Date.now() - t0)}; ${s.requests - s0.requests} requests, `
      + `${mins(s.lagWaitMs - s0.lagWaitMs)} waiting on lag (${s.lagWaits - s0.lagWaits} waits)`
      + (known + fetched ? `, depicted QIDs: ${known} known, ${fetched} fetched from Wikidata` : "")
      + (s.throttled > s0.throttled ? `, ${s.throttled - s0.throttled} × HTTP 429` : "");
    return `- ${rec.identity}: ${[...out, ...(end ? [end] : [])].join("; ")} [${cost}]`;
  };
  try {
    if (rec.type === "category") await refreshCategory(st, path, out); else await refreshSingle(st, out);
    st.bg.lastRun = now(); st.bg.lastMode = MODE;
    summary.push(line());
  } catch (err) {
    const stop = err instanceof OutOfTime || err instanceof core.LagError;
    summary.push(line(stop ? `stopped — ${err.message}; progress saved, next run continues` : `FAILED — ${err.message}`));
    err.reported = true;
    throw err;
  } finally {
    await save(path, toRecord(st));     // keep whatever progress was made, even on error
  }
}

let failed = 0;
try {
  const records = [];
  // A bad --add (typo, empty category) is reported but must not stop the
  // refresh of the existing records.
  if (args.add) {
    try {
      records.push(await addRecord(args.add, Math.max(0, parseInt(args.depth, 10) || 0),
        Math.min(10, Math.max(1, parseInt(args.count, 10) || 3)),
        (args.exclude || "").split("|").map(s => s.trim()).filter(Boolean).map(core.normCategory)));
    } catch (err) {
      failed++;
      summary.push(`- add "${args.add}": FAILED — ${err.message}`);
      console.error(err.message);
    }
  }
  const dir = join(ROOT, core.HISTORY_DIR);
  for (const f of (await readdir(dir)).filter(f => f.endsWith(".json")).sort()) {
    const p = join(dir, f);
    if (!records.includes(p) && (!args.only || f === args.only)) records.push(p);
  }
  for (const path of records) {
    try { await refreshRecord(path); }
    catch (err) {
      if (!err.reported) summary.push(`- ${basename(path)}: FAILED — ${err.message}`);
      if (err instanceof OutOfTime || err instanceof core.LagError) break;   // later records wait for the next run
      failed++;
      console.error(err);
    }
  }
} finally {
  const s = core.apiStats();
  const total = `Total: ${s.requests} requests, ${mins(s.lagWaitMs)} waiting on lag (${s.lagWaits} waits)`
    + (s.throttled ? `, ${s.throttled} × HTTP 429` : "");
  const text = `Infobox History refresh (${MODE})\n\n${summary.join("\n")}\n\n${total}\n`;
  console.log("\n" + text);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, text);
  if (process.env.SUMMARY_FILE) await writeFile(process.env.SUMMARY_FILE, text);
}
process.exitCode = failed ? 1 : 0;
