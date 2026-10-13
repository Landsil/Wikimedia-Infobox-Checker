// Infobox History pipeline — shared by history.html (in the browser) and
// scripts/refresh-history.mjs (the scheduled GitHub Action, in Node).
//
// DOM-free on purpose: everything here runs in both. Rendering, page state and
// photo-detail fetches (which parse HTML) stay in history.html.

export const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
export const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
export const BATCH = 50;
export const REV_PAGE = 50;            // revisions fetched per API page (rvlimit)
// We read only the lead section (rvsection=0) per revision — ~2% of full-article
// payload — so bandwidth is no longer the limiter; round-trips (budget/REV_PAGE
// requests) are, which is why the caps are generous but not unbounded.
export const SINGLE_REV_LIMIT = 1000;  // revisions walked on the first single article/file pass
export const SINGLE_REV_EXTEND = 1000; // extra revisions per "Search another N revisions" click
export const CAT_REV_LIMIT = 200;      // max revisions walked per person in category mode
export const CAT_FILE_CAP = 3000;      // safety cap on files enumerated from a Commons category tree
export const MAX_RETRIES = 6;
export const BACKOFF_BASE = 1.0;
export const ALGO_VERSION = 3;         // saved records: bump when extraction/crop/timeline logic changes
const NON_WIKIPEDIA_WIKIS = new Set([
  "commonswiki", "wikidatawiki", "specieswiki", "metawiki", "mediawikiwiki",
  "incubatorwiki", "sourceswiki", "foundationwiki", "outreachwiki", "wikimaniawiki", "testwiki",
]);

// ---- helpers ----
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export function chunked(a, n = BATCH) { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; }
const wikiLang = site => site.slice(0, -4).replace(/_/g, "-");   // "enwiki" -> "en"
export const wpApi = lang => `https://${lang}.wikipedia.org/w/api.php`;

// Crop helpers (shared behaviour with the other tools).
const CROP_SUFFIX = /^(?<base>.+?)\s*\((?:[^)]*crop[^)]*)\)(?<ext>\.\w+)$/i;
export const cropParent = t => { const m = CROP_SUFFIX.exec(t || ""); return m ? m.groups.base + m.groups.ext : null; };
export const sameOrCrop = (a, b) => !!a && !!b && (a === b || cropParent(a) === b || cropParent(b) === a);

// The authoritative CURRENT infobox photo is pageimages (`lead`), not the newest
// wikitext |image= — those diverge when the image is set via Wikidata (P18) with
// no local |image=, leaving a stale (often deleted) wikitext value. So when the
// lead isn't the newest wikitext entry, put the lead first (as current) and keep
// the wikitext entries as the previous photos. The synthetic current has no rev/
// ts/user (the switch happened outside wikitext). Idempotent (safe to re-run).
export function mergeCurrent(timeline, lead) {
  if (!lead) return timeline;
  if (timeline.length && sameOrCrop(lead, timeline[0].file)) return timeline;
  const prev = timeline.filter(e => !sameOrCrop(e.file, lead));
  return [{ file: lead, key: cropParent(lead) || lead, rev: null, ts: null, user: null }, ...prev];
}

// ---- API ----
// Two request profiles. The browser default is the interactive one: no maxlag
// (see README "Why there is no maxlag") and no pacing beyond being serial. The
// background job calls configureApi() with the bot profile: a descriptive
// User-Agent, maxlag=5, and pacing under the per-minute limit for identified bots.
const api = { userAgent: null, maxlag: null, minIntervalMs: 0, maxLagWaitMs: 30 * 60 * 1000, last: 0 };
export function configureApi(opts) { Object.assign(api, opts); }

// Lag outlasted maxLagWaitMs. The job saves progress and stops rather than
// hammering a lagged cluster or hanging until the job timeout.
export class LagError extends Error {}

function retryDelayMs(resp, attempt) {
  const ra = resp.headers.get("Retry-After");
  if (ra && /^\d+$/.test(ra)) return parseFloat(ra) * 1000;
  return BACKOFF_BASE * 2 ** attempt * 1000;
}
export async function apiGet(base, params) {
  const s = new URLSearchParams(params); s.set("format", "json"); s.set("origin", "*");
  if (api.maxlag != null) s.set("maxlag", String(api.maxlag));
  const url = `${base}?${s.toString()}`;
  const init = { credentials: "omit", ...(api.userAgent ? { headers: { "User-Agent": api.userAgent } } : {}) };
  let lagWaited = 0, lagTries = 0;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const gap = api.last + api.minIntervalMs - Date.now();
    if (gap > 0) await sleep(gap);
    api.last = Date.now();
    let resp;
    try { resp = await fetch(url, init); }
    catch (err) { if (attempt < MAX_RETRIES - 1) { await sleep(BACKOFF_BASE * 2 ** attempt * 1000); continue; } throw err; }
    let data = null; try { data = JSON.parse(await resp.text()); } catch (_) {}
    if ([429, 500, 502, 503, 504].includes(resp.status)) {   // rate-limit or transient 5xx
      if (attempt < MAX_RETRIES - 1) { await sleep(retryDelayMs(resp, attempt)); continue; }
      throw new Error(`Wikimedia unavailable (HTTP ${resp.status}) after ${MAX_RETRIES} attempts.`);
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${base}`);
    if (data === null) throw new Error(`Non-JSON response from ${base}`);
    // maxlag rejections are HTTP 200 with no data. Wait as told (>= 5 s, per
    // Manual:Maxlag_parameter), doubling up to 60 s so a long lag isn't polled
    // every 5 s, and ask again; this isn't a failed attempt. On Wikidata the
    // reported lag includes Query Service (WDQS) lag, so this can last a while.
    if (data.error && data.error.code === "maxlag") {
      const ms = Math.min(60000, Math.max(5000, retryDelayMs(resp, 0)) * 2 ** lagTries++);
      if (lagWaited + ms > api.maxLagWaitMs)
        throw new LagError(`Wikimedia lagged for over ${Math.round(api.maxLagWaitMs / 60000)} min (${data.error.info || "maxlag"}).`);
      lagWaited += ms; attempt--; await sleep(ms); continue;
    }
    if (data.error) throw new Error(`Wikimedia API error: ${data.error.code}${data.error.info ? " — " + data.error.info : ""}`);
    return data;
  }
}
export async function* mwQuery(base, params) {
  const p = { ...params, action: "query" };
  while (true) { const d = await apiGet(base, p); if (d.query) yield d.query; if (d.continue) Object.assign(p, d.continue); else break; }
}
async function wbGetEntities(base, ids, props, extra) {
  return (await apiGet(base, { action: "wbgetentities", ids: ids.join("|"), props, ...(extra || {}) })).entities || {};
}

// ---- input parsing ----
// A single person is ALWAYS given as an article URL or a file (File: name / file
// URL) — never as a bare title. Anything that isn't one of those, and isn't a
// recognised article/file URL, is a Commons photo category.
export function parseInput(raw) {
  const s = (raw || "").trim();
  if (!s) return null;
  // Commons file (URL)
  let m = s.match(/commons\.wikimedia\.org\/(?:wiki\/|entity\/)?(File:[^?#]+)/i);
  if (m) return { type: "file", title: decodeURIComponent(m[1]).replace(/_/g, " ") };
  // Category from either wiki -> a Commons photo category
  m = s.match(/(?:commons\.wikimedia\.org|[a-z-]+\.wikipedia\.org)\/wiki\/(Category:[^?#]+)/i);
  if (m) return { type: "category", title: decodeURIComponent(m[1]).replace(/_/g, " ") };
  // Wikipedia article (URL)
  m = s.match(/([a-z-]+)\.wikipedia\.org\/wiki\/([^?#]+)/i);
  if (m) return { type: "article", lang: m[1], title: decodeURIComponent(m[2]).replace(/_/g, " ") };
  // Bare "Category:X"
  if (/^category:/i.test(s)) return { type: "category", title: s.replace(/_/g, " ") };
  // Bare "File:X" or a filename ending in an image extension
  if (/^file:/i.test(s)) return { type: "file", title: s.replace(/_/g, " ") };
  if (/\.(jpe?g|png|gif|tiff?|webp|svg)$/i.test(s)) return { type: "file", title: "File:" + s.replace(/_/g, " ") };
  // Anything else is a Commons category name (no article-title guessing).
  return { type: "category", title: "Category:" + s.replace(/_/g, " ") };
}

function allDepictsQids(claims) {
  const out = [];
  for (const st of (claims.P180 || [])) {
    try { const id = st.mainsnak.datavalue.value.id; if (id && !out.includes(id)) out.push(id); } catch (_) {}
  }
  return out;
}

// Given depicts QIDs and their fetched Wikidata entities, return the first that
// is a human (P31=Q5) with a Wikipedia article: {lang,article,label,qid}, else null.
function subjectFromQids(qids, entities) {
  for (const q of qids) {
    const e = entities[q]; if (!e) continue;
    const claims = e.claims || {};
    const human = (claims.P31 || []).some(s => { try { return s.mainsnak.datavalue.value.id === "Q5"; } catch (_) { return false; } });
    if (!human) continue;
    const sl = e.sitelinks || {};
    const label = (e.labels && e.labels.en && e.labels.en.value) || q;
    let site = "enwiki", title = (sl.enwiki || {}).title;
    if (!title) for (const [s, l] of Object.entries(sl)) { if (s.endsWith("wiki") && !NON_WIKIPEDIA_WIKIS.has(s)) { site = s; title = l.title; break; } }
    if (!title) continue;
    return { lang: wikiLang(site), article: title, label, qid: q };
  }
  return null;
}

// File -> depicted person -> their article. Returns {lang,article,label,qid} or {error}.
export async function resolveSubjectFromFile(fileTitle) {
  const d = await apiGet(COMMONS_API, { action: "query", titles: fileTitle, prop: "info" });
  const page = Object.values(d.query.pages)[0];
  if (!page || "missing" in page) return { error: `No such Commons file: ${fileTitle}` };
  const ents = await wbGetEntities(COMMONS_API, ["M" + page.pageid], "claims");
  const st = (ents["M" + page.pageid] || {});
  const qids = allDepictsQids(st.statements || st.claims || {});
  if (!qids.length) return { error: `“${fileTitle}” has no depicts (P180) statement, so I can't tell who it's of.` };
  const we = await wbGetEntities(WIKIDATA_API, qids.slice(0, BATCH), "claims|sitelinks|labels", { languages: "en" });
  const subj = subjectFromQids(qids, we);
  return subj || { error: `“${fileTitle}” depicts something that isn't a person with a Wikipedia article.` };
}

// Batched version for category mode: resolve many files' depicted person at once.
// file -> pageid (Commons info) -> depicts QIDs (Commons entities) -> person
// (Wikidata entities). Returns a Map of file -> {lang,article,label,qid}.
async function batchResolve(files, onProgress) {
  const pageid = {};                                     // file -> Commons pageid
  let n = 0;
  for (const b of chunked(files)) {
    for await (const q of mwQuery(COMMONS_API, { titles: b.join("|"), prop: "info" }))
      for (const p of Object.values(q.pages || {})) if (!("missing" in p)) pageid[p.title] = p.pageid;
    n += b.length;
    if (onProgress) onProgress(`Reading file info ${n}/${files.length}…`);
  }

  const midToQids = {};                                  // "M<id>" -> [qids]
  const mids = Object.values(pageid).map(id => "M" + id);
  n = 0;
  for (const b of chunked(mids)) {
    const ents = await wbGetEntities(COMMONS_API, b, "claims");
    for (const [mid, ent] of Object.entries(ents)) midToQids[mid] = allDepictsQids(ent.statements || ent.claims || {});
    n += b.length;
    if (onProgress) onProgress(`Reading depicts statements ${n}/${mids.length}…`);
  }
  const allQids = [...new Set(Object.values(midToQids).flat())];
  const wd = {};
  n = 0;
  for (const b of chunked(allQids)) {
    Object.assign(wd, await wbGetEntities(WIKIDATA_API, b, "claims|sitelinks|labels", { languages: "en" }));
    n += b.length;
    if (onProgress) onProgress(`Resolving people ${n}/${allQids.length}…`);
  }

  const out = new Map();
  for (const file of files) {
    const pid = pageid[file]; if (pid == null) continue;
    const subj = subjectFromQids(midToQids["M" + pid] || [], wd);
    if (subj) out.set(file, subj);
  }
  return out;
}

export async function currentLead(lang, article) {
  const d = await apiGet(wpApi(lang), { action: "query", titles: article, prop: "pageimages", piprop: "name", redirects: "1" });
  const p = Object.values((d.query || {}).pages || {})[0];
  return (p && p.pageimage) ? "File:" + p.pageimage.replace(/_/g, " ") : null;
}

// Batched current-lead lookup: article -> lead File: title, for many articles on one wiki.
async function currentLeads(lang, articles) {
  const out = {};
  for (const b of chunked(articles))
    for await (const q of mwQuery(wpApi(lang), { titles: b.join("|"), prop: "pageimages", piprop: "name", redirects: "1" }))
      for (const p of Object.values(q.pages || {})) if (p.pageimage) out[p.title] = "File:" + p.pageimage.replace(/_/g, " ");
  return out;
}

// Distinct infobox photos, newest first (crop variants collapsed to one).
// Reads up to `budget` NEW revisions this call, following `continue`, stopping
// once `wantDistinct` photos are collected. `resume` ({ timeline, cont }) lets a
// follow-up call continue exactly where a previous one stopped, so extra budget
// is spent on unseen history rather than re-reading it.
//
// Only the lead section (rvsection=0) is fetched — the infobox lives there, and
// it's ~2% of the full-article payload. If the lead section yields no image at
// all on a fresh walk (exotic case: infobox transcluded below a heading), and
// `opts.allowFallback` is set, we retry once with full content so correctness
// can't regress. `opts.fullContent` forces the full-content mode (used when a
// resume must match a walk that already fell back).
//
// Returns { timeline, more, cont, read, usedFull }.
const INFOBOX_IMG = /\|\s*(?:image|image_name|photo|img)\s*=\s*([^\n|}]+)/i;
export async function buildTimeline(lang, article, budget, wantDistinct, resume, opts) {
  opts = opts || {};
  const base = { action: "query", prop: "revisions", titles: article,
    rvprop: "ids|timestamp|user|comment|content", rvslots: "main",
    rvlimit: String(REV_PAGE), rvdir: "older" };
  const walk = async (extra, startTimeline, startCont, startTop) => {
    const timeline = startTimeline || [];
    let read = 0, topRev = startTop || null;
    const p = { ...base, ...extra };
    if (startCont) Object.assign(p, startCont);
    while (true) {
      const d = await apiGet(wpApi(lang), p);
      const page = Object.values((d.query || {}).pages || {})[0];
      for (const r of (page && page.revisions) || []) {
        if (topRev == null) topRev = r.revid;   // newest revision seen = delta watermark
        read++;
        const wt = ((r.slots || {}).main || {})["*"] || "";
        const m = INFOBOX_IMG.exec(wt); if (!m) continue;
        // Editors leave HTML comments / tags after the filename ("Foo.jpg <!-- note -->"),
        // sometimes wrap it in [[File:…]], and sometimes the value is a template or
        // empty. Strip the noise, then require a plain image filename so junk/empty
        // captures don't become unreadable cards.
        let val = m[1].replace(/<!--[\s\S]*?-->/g, "").replace(/<.*$/, "").trim();
        val = val.replace(/^\[\[\s*/, "").replace(/\s*\]\]\s*$/, "")
                 .replace(/^\s*(?:File|Image)\s*:\s*/i, "").trim();
        if (!/\.(jpe?g|png|gif|tiff?|webp|svg)$/i.test(val)) continue;
        // Normalise underscores to spaces (MediaWiki treats them as equal) so the
        // wikitext filename matches the pageimages/categorymembers form; otherwise
        // "Steve_Mould_in_2026.jpg" wouldn't equal the lead "Steve Mould in 2026.jpg"
        // and mergeCurrent would show the same photo as both current and previous.
        const file = "File:" + val.replace(/_/g, " ");
        const key = cropParent(file) || file;
        if (!timeline.length || timeline[timeline.length - 1].key !== key)
          timeline.push({ file, key, rev: r.revid, ts: r.timestamp, user: r.user });
        if (timeline.length >= wantDistinct) return { timeline, more: false, cont: null, read, topRev };
      }
      if (read >= budget) return { timeline, more: !!d.continue, cont: d.continue || null, read, topRev };
      if (d.continue) Object.assign(p, d.continue); else return { timeline, more: false, cont: null, read, topRev };
    }
  };
  const res = await walk(opts.fullContent ? {} : { rvsection: "0" },
    resume ? resume.timeline : [], resume ? resume.cont : null, resume ? resume.topRev : null);
  if (!opts.fullContent && opts.allowFallback && !resume && res.timeline.length === 0)
    return { ...(await walk({}, [], null, null)), usedFull: true };
  return { ...res, usedFull: !!opts.fullContent };
}

// ---- category mode (Commons photo category) ----
// Walk the files (ns6) of a Commons category tree, recursing subcats to `depth`.
// Cheap relative to the per-file depicts/history lookups.
//   cap   — stop after this many files (CAT_FILE_CAP normally; Infinity un-capped).
//   since — also collect `added`: files whose category-add timestamp is after it.
//           A delta must see the whole tree (pre-existing subcats gain files too),
//           so pass cap = Infinity with it.
//   exclude — subcategory titles to skip, with everything below them (a file
//           that is also in an included category is still listed).
// Returns { files, added, addedThrough } — addedThrough is the latest add
// timestamp seen, the watermark for the next delta.
export const normCategory = t => {
  const s = String(t || "").trim().replace(/_/g, " ");
  return /^category:/i.test(s) ? "Category:" + s.slice(9).trim() : "Category:" + s;
};
export async function walkCategory(category, depth, { cap = CAT_FILE_CAP, since = null, exclude = [] } = {}) {
  const files = [], added = [], seen = new Set(), visited = new Set(exclude.map(normCategory));
  let addedThrough = since || "";
  let queue = [{ c: category, d: 0 }];
  while (queue.length && files.length < cap) {
    const { c, d } = queue.shift();
    if (visited.has(c)) continue;
    visited.add(c);
    for await (const q of mwQuery(COMMONS_API, { list: "categorymembers", cmtitle: c,
        cmtype: d < depth ? "file|subcat" : "file", cmprop: "title|type|timestamp", cmlimit: "500" })) {
      for (const m of q.categorymembers || []) {
        if (m.ns === 14) { if (d < depth) queue.push({ c: m.title, d: d + 1 }); }
        else if (m.ns === 6 && !seen.has(m.title)) {
          seen.add(m.title); files.push(m.title);
          if (since != null && m.timestamp > since) added.push(m.title);
          if (m.timestamp && m.timestamp > addedThrough) addedThrough = m.timestamp;
        }
      }
      if (files.length >= cap) break;
    }
  }
  return { files: files.slice(0, cap), added, addedThrough };
}

// Resolve a list of files to the live people whose current infobox photo is one
// of them (crop-aware), and build each person's history. People already in
// `done` ("lang:article") are skipped. Pure: the caller marks the returned
// `doneKeys` done only once the whole chunk has succeeded, so a failed chunk can
// simply be retried without losing anyone.
// Returns { people, doneKeys }; people carry no photo details (`info`).
export async function processFiles(fileList, { done, count, onProgress }) {
  // 1. Resolve every file's depicted person in batched queries (cheap in bulk).
  const resolved = await batchResolve(fileList, onProgress);
  const candidates = [...resolved].map(([file, subj]) => ({ file, ...subj }))
    .filter(c => !done.has(c.lang + ":" + c.article));
  // 2. Batch the current-lead lookup per wiki, then keep files that are the lead
  //    (crop-aware) and dedup by person AFTER the liveness check (a person may be
  //    depicted by several files; only the one matching the infobox is "live").
  if (onProgress) onProgress(`Checking current infobox photos for ${candidates.length} candidate(s)…`);
  const byLang = {};
  for (const c of candidates) (byLang[c.lang] = byLang[c.lang] || new Set()).add(c.article);
  const leads = {};
  for (const [lang, set] of Object.entries(byLang)) leads[lang] = await currentLeads(lang, [...set]);
  const live = [], seen = new Set();
  for (const c of candidates) {
    const lead = (leads[c.lang] || {})[c.article];
    if (!sameOrCrop(c.file, lead)) continue;      // this photo is the person's current infobox photo
    const key = c.lang + ":" + c.article;
    if (seen.has(key)) continue; seen.add(key);
    live.push({ ...c, lead });
  }
  // 3. Walk history for each live person; the CURRENT photo is the pageimages
  //    lead, the wikitext walk supplies the previous photos.
  const people = [];
  let i = 0;
  for (const c of live) {
    if (onProgress) onProgress(`Building history ${++i}/${live.length}: ${c.label || c.article}`);
    let res;
    try { res = await buildTimeline(c.lang, c.article, CAT_REV_LIMIT, count); } catch (_) { res = { timeline: [], more: false, topRev: null }; }
    const merged = mergeCurrent(res.timeline, c.lead);
    if (!merged.length) continue;
    people.push({ lang: c.lang, article: c.article, label: c.label, qid: c.qid, lead: c.lead,
                  topRev: res.topRev, shown: merged.slice(0, count), more: res.more });
  }
  return { people, doneKeys: live.map(c => c.lang + ":" + c.article) };
}

// ---- refresh (shared by "Check for updates" and the background job) ----
export async function currentTopRev(lang, article) {
  const d = await apiGet(wpApi(lang), { action: "query", titles: article, prop: "info", redirects: "1" });
  const p = Object.values((d.query || {}).pages || {})[0];
  return p ? p.lastrevid : null;
}
async function lastRevIds(lang, articles) {
  const out = {};
  for (const b of chunked(articles))
    for await (const q of mwQuery(wpApi(lang), { titles: b.join("|"), prop: "info", redirects: "1" }))
      for (const p of Object.values(q.pages || {})) out[p.title] = p.lastrevid;
  return out;
}

// Rebuild the history of every stored person whose article changed since it was
// recorded (top revision differs). Updates people in place; calls onChanged(p)
// for each one that changed. A person whose rebuild fails is left as it was.
export async function refreshPeople(people, count, { onProgress, onChanged } = {}) {
  const byLang = {};
  for (const p of people) (byLang[p.lang] = byLang[p.lang] || []).push(p);
  let checked = 0, changed = 0;
  for (const [lang, ps] of Object.entries(byLang)) {
    const last = await lastRevIds(lang, ps.map(p => p.article));
    for (const p of ps) {
      checked++;
      if (!last[p.article] || last[p.article] === p.topRev) continue;
      if (onProgress) onProgress(`Updating ${p.label || p.article} (${checked}/${people.length} checked)…`);
      let res; try { res = await buildTimeline(p.lang, p.article, CAT_REV_LIMIT, count); } catch (_) { continue; }
      p.lead = await currentLead(p.lang, p.article);   // current photo may have changed
      const merged = mergeCurrent(res.timeline, p.lead);
      if (!merged.length) continue;
      p.topRev = res.topRev; p.more = res.more; p.shown = merged.slice(0, count);
      changed++;
      if (onChanged) await onChanged(p);
    }
  }
  return changed;
}

// Mark people whose current infobox photo is no longer a file (or crop of a
// file) in the category tree: they stay listed, flagged `outside`. Needs the
// complete tree listing (walkCategory with cap = Infinity).
export function flagOutside(people, treeFiles) {
  // Both directions, like sameOrCrop: the lead may be a crop of a tree file, or
  // the tree may hold a crop of the lead.
  const tree = new Set(treeFiles);
  for (const f of treeFiles) { const parent = cropParent(f); if (parent) tree.add(parent); }
  for (const p of people) {
    const lead = p.lead;
    const inside = !!lead && (tree.has(lead) || tree.has(cropParent(lead) || ""));
    if (inside) delete p.outside; else p.outside = true;
  }
}

// ---- saved records (data/history/<slug>-<hash>.json) ----
export const HISTORY_DIR = "data/history";
function hash32(s) { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); }
export function cacheIdentity(inp) {
  return inp.type === "article" ? `article|${inp.lang}|${inp.title}`
       : inp.type === "file"    ? `file|${inp.title}`
       :                          `category|${inp.title}`;
}
export function cachePath(inp) {
  const id = cacheIdentity(inp);
  const slug = id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return `${HISTORY_DIR}/${slug}-${hash32(id)}.json`;
}
export const timelineToJson = t => t.map(e => ({ file: e.file, rev: e.rev, ts: e.ts, user: e.user }));
export const timelineFromJson = t => (t || []).map(e => ({ ...e, key: cropParent(e.file) || e.file }));
