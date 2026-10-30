// Headshots — wiring for index.html. The file work lives in shoot.js, the badge
// reading in identify.js, and neither touches the DOM, so both are testable on
// their own (see check.html).

import { listPhotos, groupPhotos, applyGroups, people, stemFor, DONE_DIR } from "./shoot.js";
import { nanoPresent, nanoAvailability, createSession, identify, forModel } from "./identify.js";
import * as store from "./db.js";
import { buildDemoShoot } from "./demo.js";
import * as faces from "./faces.js";

const THUMB = 160;             // review thumbnails, in pixels
const CACHE_CAP = 5000;        // remembered scan results before the oldest are dropped

const $ = id => document.getElementById(id);
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const row = (k, v, warn) => `<div class="row"><span class="k">${esc(k)}</span><span class="v${warn ? " warn" : ""}">${v}</span></div>`;
const hhmm = iso => (iso || "").slice(11, 16);
const mb = n => `${(n / 1e6).toFixed(1)} MB`;

// ---- state ----
let dir = null;          // the chosen folder
let photos = [];         // every image in it, oldest first; .id set by the scan
let thumbs = new Map();  // photo name -> small dataURL
let session = null;      // the model session, made once per scan
let scanCache = {};      // "name|bytes|ms" -> identification, remembered between visits
let stopping = false;
let lastLog = null;
let filedPeople = [];    // accumulated across filings; the report is about these
let faceWarnings = [];   // groups that look like the same person as another group

const cacheKey = p => `${p.name}|${p.bytes}|${p.time.ms}`;

function stepState(id, state) {            // "waiting" | "" | "done"
  const el = $(id);
  el.classList.toggle("waiting", state === "waiting");
  el.classList.toggle("done", state === "done");
}

// ---- requirements ----
// Stated up front rather than failing later. No folder access is fatal; no
// model only costs the automatic reading — badges can still be marked by hand.
let canPickFolder = false;
async function checkRequirements() {
  canPickFolder = typeof window.showDirectoryPicker === "function";
  $("pick").disabled = !canPickFolder;
  $("scan").disabled = true;
  renderBlockers(null);                       // what is known at once
  const avail = nanoPresent() ? await nanoAvailability() : "absent";
  renderBlockers(avail);                      // Chrome can take seconds to answer
}

// `avail` null means the model check is still running, so say nothing about it yet.
function renderBlockers(avail) {
  const modelUsable = avail === null || ["available", "downloadable", "downloading"].includes(avail);
  const out = [];
  if (!canPickFolder) out.push(`<div class="blocker"><p><strong>This browser cannot rename files in your folder.</strong>
    Renaming needs the File System Access API, which only Chrome and Edge have, on desktop.
    Firefox and Safari do not support it on any platform.</p>
    <p>You can still look around, but step 1 will not work here.</p></div>`);
  if (!modelUsable) out.push(`<div class="blocker warn"><p><strong>No built-in model in this browser${
    String(avail).startsWith("error") ? ` (${esc(avail)})` : ""}.</strong> Badges will not be read automatically.</p>
    <p>It needs Chrome 148 or newer on a desktop, with the hardware listed in About.
    Everything else still works: mark the badge frames yourself in step 3 and type the names.</p></div>`);
  else if (avail === "downloadable") out.push(`<div class="blocker warn"><p><strong>Chrome has not downloaded
    the model yet.</strong> The first scan will fetch it, once. It is Chrome's download, not ours, and
    needs a connection and free disk space — see About.</p></div>`);
  $("blockers").innerHTML = out.join("");
}

// ---- step 1: the folder ----
async function useDirectory(handle, isDemo = false) {
  dir = handle;
  photos = []; thumbs.clear(); lastLog = null;
  $("scan_grid").innerHTML = ""; $("review").innerHTML = ""; $("report").innerHTML = "";
  $("apply_log").hidden = true; $("apply_info").innerHTML = ""; $("scan_info").innerHTML = "";
  $("lookup").disabled = true; $("copy_report").disabled = true; $("apply").disabled = true;
  stepState("step_review", "waiting"); stepState("step_apply", "waiting"); stepState("step_report", "waiting");

  $("folder_info").innerHTML = row("Folder", esc(handle.name)) + row("Reading", "…");
  photos = await listPhotos(handle, n => { $("folder_info").innerHTML = row("Folder", esc(handle.name)) + row("Reading", `${n} photo(s)…`); });
  const withExif = photos.filter(p => p.time.source === "EXIF").length;
  const span = photos.length ? `${hhmm(photos[0].time.local)} – ${hhmm(photos[photos.length - 1].time.local)}` : "—";
  const base =
      row("Folder", esc(handle.name))
    + row("Photos", `${photos.length}`, photos.length === 0)
    + row("Times from", `${withExif} from EXIF, ${photos.length - withExif} from the file date`, withExif < photos.length)
    + row("Span", esc(span));
  $("folder_info").innerHTML = base;
  if (!photos.length) {
    $("folder_info").innerHTML += row("Next", "No images in that folder — pick another.", true);
    renderReview();
    return;
  }
  for (const [i, p] of photos.entries()) {
    if (thumbs.has(p.name)) continue;
    try { thumbs.set(p.name, await makeThumb(await p.handle.getFile())); } catch (_) { /* unreadable image */ }
    if (i % 5 === 0 || i === photos.length - 1)
      $("folder_info").innerHTML = base + row("Thumbnails", `${i + 1} of ${photos.length}`);
  }
  $("folder_info").innerHTML = base;
  stepState("step_folder", "done"); stepState("step_scan", "");
  $("scan").disabled = !nanoPresent();
  $("scan_from").value = "1";
  // Only a real folder is worth remembering; the sample is rebuilt on demand.
  if (!isDemo) try { await store.set("lastDir", handle); } catch (_) { /* some builds refuse to clone handles */ }
  // Anything already identified on a previous visit is reused straight away.
  let known = 0;
  for (const p of photos) { const hit = scanCache[cacheKey(p)]; if (hit) { p.id = hit; known++; } }
  if (known) $("scan_info").innerHTML = row("Remembered", `${known} of ${photos.length} photo(s) were already identified on an earlier visit.`);
  renderReview();
}

$("pick").addEventListener("click", async () => {
  try {
    const handle = await window.showDirectoryPicker({ mode: "readwrite", id: "headshots-shoot", startIn: "pictures" });
    await useDirectory(handle);
  } catch (err) {
    if (err.name !== "AbortError") $("folder_info").innerHTML = row("Could not open that folder", esc(`${err.name}: ${err.message}`), true);
  }
});
$("demo").addEventListener("click", async () => {
  const btn = $("demo"), orig = btn.textContent;
  btn.disabled = true;
  try {
    $("folder_info").innerHTML = row("Sample shoot", "Building it in private storage…");
    const handle = await buildDemoShoot(null, (n, total) => {
      $("folder_info").innerHTML = row("Sample shoot", `Building… ${n} of ${total}`);
    });
    await useDirectory(handle, true);
    $("folder_info").innerHTML += row("Note", "This is the sample shoot in private storage. Your own photos are untouched.");
  } catch (err) {
    $("folder_info").innerHTML = row("Could not build the sample shoot", esc(`${err.name}: ${err.message}`), true);
  } finally {
    btn.disabled = false; btn.textContent = orig;
  }
});
$("reopen").addEventListener("click", async () => {
  try {
    const handle = await store.get("lastDir");
    if (!handle) { $("folder_info").innerHTML = row("Nothing to reopen", "No folder remembered.", true); return; }
    let perm = await handle.queryPermission({ mode: "readwrite" });
    if (perm !== "granted") perm = await handle.requestPermission({ mode: "readwrite" });
    if (perm !== "granted") { $("folder_info").innerHTML = row("Permission refused", "Chrome needs edit permission to rename the photos.", true); return; }
    await useDirectory(handle);
  } catch (err) {
    $("folder_info").innerHTML = row("Could not reopen", esc(`${err.name}: ${err.message}`), true);
  }
});

// ---- step 2: read the badges ----
async function makeThumb(blob) {
  const probe = await createImageBitmap(blob);
  const scale = Math.min(1, THUMB / Math.max(probe.width, probe.height));
  const w = Math.max(1, Math.round(probe.width * scale)), h = Math.max(1, Math.round(probe.height * scale));
  probe.close();
  const bmp = await createImageBitmap(blob, { resizeWidth: w, resizeHeight: h, resizeQuality: "medium" });
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  c.getContext("2d", { alpha: false }).drawImage(bmp, 0, 0);
  bmp.close();
  return c.toDataURL("image/jpeg", 0.7);
}
function scanCell(p, i) {
  const id = p.id || {};
  const cls = id.kind === "identity" ? "identity" : p.id ? "" : "pending";
  const label = id.kind === "identity" ? (id.full_name || "badge — no name read")
    : id.kind === "portrait" ? "portrait" : id.kind === "unreadable" ? "could not read" : p.id ? "other" : "—";
  return `<figure class="${cls}" data-i="${i}">`
    + `<img src="${thumbs.get(p.name) || ""}" alt="">`
    + `<figcaption>${hhmm(p.time.local)} ${esc(label)}</figcaption></figure>`;
}
function renderScanGrid() {
  $("scan_grid").innerHTML = photos.map(scanCell).join("");
}

$("scan").addEventListener("click", async () => {
  const from = Math.max(1, Math.min(photos.length, parseInt($("scan_from").value, 10) || 1));
  stopping = false;
  $("scan").disabled = true; $("stop").hidden = false; $("scan_bar").hidden = false;
  const bar = $("scan_bar").firstElementChild;
  let read = 0, fromCache = 0, failed = 0;
  try {
    if (!session) {
      $("scan_info").innerHTML = row("Model", "Preparing — the first run on a new machine downloads it once.");
      session = await createSession(p => { $("scan_info").innerHTML = row("Model", `Downloading… ${Math.round(p * 100)}%`); });
    }
    for (let i = from - 1; i < photos.length; i++) {
      if (stopping) break;
      const p = photos[i];
      bar.style.width = `${Math.round(((i + 1) / photos.length) * 100)}%`;
      $("scan_info").innerHTML = row("Reading", `photo ${i + 1} of ${photos.length} — ${esc(p.name)}`)
        + row("So far", `${read} read by the model, ${fromCache} remembered${failed ? `, ${failed} failed` : ""}`);
      let canvas;
      try {
        canvas = await forModel(await p.handle.getFile());
      } catch (err) {
        p.id = { kind: "unreadable", error: `${err.name}: ${err.message}` }; failed++; renderScanGrid(); continue;
      }
      const hit = scanCache[cacheKey(p)];
      if (hit) { p.id = hit; fromCache++; }
      else {
        p.id = await identify(session, canvas);
        if (p.id.kind === "unreadable") failed++;
        else { scanCache[cacheKey(p)] = p.id; read++; }
      }
      renderScanGrid();
    }
    const keys = Object.keys(scanCache);
    if (keys.length > CACHE_CAP) for (const k of keys.slice(0, keys.length - CACHE_CAP)) delete scanCache[k];
    await store.set("scanCache", scanCache);
    const badges = photos.filter(p => p.id && p.id.kind === "identity").length;
    $("scan_info").innerHTML =
        row("Read by the model", `${read}`) + row("Remembered from before", `${fromCache}`)
      + (failed ? row("Could not be read", `${failed}`, true) : "")
      + row("Badges found", `${badges}`, badges === 0)
      + (stopping ? row("Stopped", `at photo ${Math.min(photos.length, from + read + fromCache)} — change “from photo” and run again to carry on`) : "");
    stepState("step_scan", "done");
    renderReview();
  } catch (err) {
    $("scan_info").innerHTML = row("Could not read the badges", esc(`${err.name}: ${err.message}`), true);
  } finally {
    $("scan").disabled = false; $("stop").hidden = true;
  }
});
$("stop").addEventListener("click", () => { stopping = true; });

// ---- step 3: check who is who ----
let grouped = { groups: [], leading: [] };

function clearFaceCheck() {
  for (const p of photos) { delete p.faceScore; delete p.faceFlag; delete p.faceNone; }
  faceWarnings = [];
}
const setIdentity = (p, on) => {
  clearFaceCheck();
  p.id = on
    ? { kind: "identity", full_name: "", given_name: "", family_name: "", organisation: "", legible: true, manual: true }
    : { kind: "portrait", manual: true };
  scanCache[cacheKey(p)] = p.id;
};

function shotCell(p, isBadge) {
  return `<div class="shot${isBadge ? " is-badge" : ""}${p.faceFlag ? " face-flag" : ""}">`
    + `<img src="${thumbs.get(p.name) || ""}" alt="" title="${esc(p.name)}">`
    + `<span class="cap">${esc(p.name)}</span><span class="time">${hhmm(p.time.local)}</span>`
    + (p.faceNone ? `<span class="face">no face found</span>`
       : p.faceScore != null ? `<span class="face">face ${p.faceScore.toFixed(2)}${p.faceFlag ? " — check" : ""}</span>` : "")
    + `<button type="button" class="mini mark" data-name="${esc(p.name)}" data-on="${isBadge ? "0" : "1"}">`
    + `${isBadge ? "not a badge" : "badge"}</button></div>`;
}
function renderReview() {
  grouped = groupPhotos(photos);
  const { groups, leading } = grouped;
  const named = groups.filter(g => g.person).length;
  const unnamed = groups.length - named;
  const filing = groups.filter(g => g.person).reduce((n, g) => n + g.shots.length, 0);
  $("review_info").innerHTML =
      row("People found", `${groups.length}`, groups.length === 0)
    + (unnamed ? row("Still need a name", `${unnamed}`, true) : "")
    + row("Photos that will be filed", `${filing}`)
    + (leading.length ? row("Before the first badge", `${leading.length} — left alone`, true) : "")
    + (photos.some(p => p.faceFlag) ? row("Faces to check", `${photos.filter(p => p.faceFlag).length} photo(s) do not look like the rest of their group`, true) : "")
    + faceWarnings.map(w => row("Possibly the same person", esc(w), true)).join("");

  const cards = groups.map((g, gi) => {
    const name = g.person ? stemFor(g.person) : "";
    return `<div class="person${g.person ? "" : " unnamed"}">
      <div class="person-head">
        <input type="text" class="person-name" data-gi="${gi}" value="${esc(name)}"
               placeholder="${g.badge && g.badge.id && g.badge.id.legible === false ? "badge unreadable — type the name" : "type the name"}">
        <span class="count">${g.shots.length} headshot(s)${g.badge ? " + badge" : ""}
          ${g.badge && g.badge.id && g.badge.id.organisation ? "· " + esc(g.badge.id.organisation) : ""}</span>
      </div>
      <div class="shots">${g.badge ? shotCell(g.badge, true) : ""}${g.shots.map(p => shotCell(p, false)).join("")}</div>
    </div>`;
  }).join("");
  const lead = leading.length ? `<div class="person unnamed">
      <div class="person-head"><strong>Before the first badge</strong>
      <span class="count">${leading.length} photo(s) — not filed. Mark one as a badge to start a person here.</span></div>
      <div class="shots">${leading.map(p => shotCell(p, false)).join("")}</div></div>` : "";
  $("review").innerHTML = lead + cards || `<p class="none">Nothing to show yet.</p>`;

  const canApply = named > 0;
  $("apply").disabled = !canApply;
  stepState("step_review", groups.length ? "done" : "");
  if (canApply) stepState("step_apply", "");
  renderReport();
}

// Typing a name belongs to that group's badge frame, so regrouping keeps it.
$("review").addEventListener("input", e => {
  const input = e.target.closest(".person-name");
  if (!input) return;
  const g = grouped.groups[+input.dataset.gi];
  if (!g || !g.badge) return;
  const v = input.value.trim();
  g.badge.id = { ...(g.badge.id || {}), kind: "identity", full_name: v, given_name: "", family_name: "", legible: true };
  scanCache[cacheKey(g.badge)] = g.badge.id;
});
$("review").addEventListener("change", e => {
  if (e.target.closest(".person-name")) { store.set("scanCache", scanCache); renderReview(); }
});
$("review").addEventListener("click", e => {
  const b = e.target.closest(".mark");
  if (!b) return;
  const p = photos.find(x => x.name === b.dataset.name);
  if (!p) return;
  setIdentity(p, b.dataset.on === "1");
  store.set("scanCache", scanCache);
  renderReview();
});

// ---- the face check (optional, step 3) ----
async function faceState() {
  const st = await faces.state();
  const el = $("face_state");
  el.hidden = false;
  if (st.status === "ready") {
    el.className = "lib-state ok";
    el.innerHTML = `Face models saved (<code>${esc(st.release)}</code>, ${mb(st.bytes)}) ✓`;
  } else if (st.status === "missing") {
    el.className = "lib-state need";
    el.innerHTML = `The face check needs ${mb(st.bytes)} of MediaPipe from this site, kept in this browser. `
      + `<button type="button" id="face_get">Download (${mb(st.bytes)})</button>`;
  } else {
    el.className = "lib-state bad";
    el.innerHTML = `Your saved face models (<code>${esc(st.old.join(", "))}</code>) are out of date — the current ones are `
      + `<code>${esc(st.release)}</code>. <button type="button" id="face_get">Update (${mb(st.bytes)})</button>`;
  }
  return st.status === "ready";
}
async function runFaceCheck() {
  const btn = $("face_check");
  btn.disabled = true;
  try {
    if (!(await faceState())) return;
    $("face_state").className = "lib-state";
    $("face_state").innerHTML = "Loading the face models…";
    await faces.load();
    clearFaceCheck();
    const named = grouped.groups.filter(g => g.person);
    let n = 0;
    const total = named.reduce((t, g) => t + g.shots.length, 0);
    const refs = [];
    for (const g of named) {
      const items = [];
      for (const p of g.shots) {
        $("face_state").innerHTML = `Comparing faces… ${++n} of ${total}`;
        try {
          const face = await faces.faceOf(await p.handle.getFile());
          if (face) items.push({ key: p.name, face, photo: p });
          else p.faceNone = true;
        } catch (err) { p.faceNone = true; }
      }
      const res = faces.checkGroup(items);
      for (const it of items) {
        const s = res.scores.get(it.key);
        if (s != null) { it.photo.faceScore = s; it.photo.faceFlag = s < faces.SAME_MIN; }
      }
      if (res.reference) refs.push({ name: stemFor(g.person), vector: res.reference.face.vector });
    }
    // Two different people's groups scoring alike usually means a badge was missed
    // and one person was shot twice under two names.
    for (let i = 0; i < refs.length; i++)
      for (let j = i + 1; j < refs.length; j++) {
        const sim = faces.similarity(refs[i].vector, refs[j].vector);
        if (sim >= faces.SAME_MIN)
          faceWarnings.push(`${refs[i].name} and ${refs[j].name} look alike (${sim.toFixed(2)}) — one badge may have been missed`);
      }
    const flagged = photos.filter(p => p.faceFlag).length;
    const noFace = photos.filter(p => p.faceNone).length;
    $("face_state").className = flagged || faceWarnings.length ? "lib-state bad" : "lib-state ok";
    $("face_state").innerHTML = `Compared ${total} photo(s): ${flagged} to check, ${faceWarnings.length} group warning(s)`
      + (noFace ? `, ${noFace} with no face found` : "") + ".";
    renderReview();
  } catch (err) {
    $("face_state").className = "lib-state bad";
    $("face_state").innerHTML = esc(`${err.name}: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
}
$("face_check").addEventListener("click", runFaceCheck);
$("face_state").addEventListener("click", async e => {
  if (e.target && e.target.id === "face_get") {
    e.target.disabled = true;
    try {
      await faces.save((done, total, name) => {
        $("face_state").innerHTML = `Downloading ${esc(name)}… ${mb(done)} of ${mb(total)}`;
      });
      await faceState();
      runFaceCheck();
    } catch (err) {
      $("face_state").className = "lib-state bad";
      $("face_state").innerHTML = esc(`Download failed: ${err.message}`);
    }
  }
});

// ---- step 4: rename and file ----
$("apply").addEventListener("click", async () => {
  const includeBadges = $("keep_badges").checked;
  const named = grouped.groups.filter(g => g.person);
  const count = named.reduce((n, g) => n + g.shots.length + (includeBadges && g.badge ? 1 : 0), 0);
  const unnamed = grouped.groups.length - named.length;
  if (!confirm(`Rename and move ${count} photo(s) for ${named.length} ${named.length === 1 ? "person" : "people"} into "${DONE_DIR}"?`
    + (unnamed ? `\n\n${unnamed} unnamed ${unnamed === 1 ? "person is" : "people are"} left untouched.` : "")
    + (grouped.leading.length ? `\n${grouped.leading.length} photo(s) before the first badge are left untouched.` : ""))) return;
  $("apply").disabled = true; $("apply_bar").hidden = false;
  const bar = $("apply_bar").firstElementChild;
  try {
    lastLog = await applyGroups(dir, grouped.groups, { includeBadges },
      (done, total) => { bar.style.width = `${Math.round((done / Math.max(1, total)) * 100)}%`;
                         $("apply_info").innerHTML = row("Filing", `${done} of ${total}`); });
    const ok = lastLog.filter(r => r.ok).length, bad = lastLog.filter(r => !r.ok);
    $("apply_info").innerHTML = row("Filed", `${ok} photo(s) into ${esc(DONE_DIR)}/`)
      + (bad.length ? row("Failed", `${bad.length} — listed below, originals kept`, true) : "");
    $("apply_log").hidden = false;
    $("apply_log").textContent = lastLog.map(r => r.ok ? `${r.from}  ->  ${DONE_DIR}/${r.to}` : `${r.from}  ->  FAILED: ${r.error}`).join("\n");
    stepState("step_apply", "done"); stepState("step_report", "");
    // Record who was filed before the photos leave the working list.
    for (const r of people(grouped.groups)) {
      const seen = filedPeople.find(x => x.name === r.name);
      if (seen) { seen.shots += r.shots; seen.sessions += r.sessions; } else filedPeople.push({ ...r });
    }
    // Drop what moved, rather than re-reading the folder — a re-read would reset
    // this step and wipe the report that has just been produced.
    const moved = new Set(lastLog.filter(r => r.ok).map(r => r.from));
    photos = photos.filter(p => !moved.has(p.name));
    renderReview();
  } catch (err) {
    $("apply_info").innerHTML = row("Could not file the photos", esc(`${err.name}: ${err.message}`), true);
  } finally {
    $("apply").disabled = false;
  }
});

// ---- step 5: report ----
let reportRows = [];
// Once anything has been filed the report is about that; before then it previews
// what filing would produce. Either way, look-up results already fetched are kept.
function renderReport() {
  const source = filedPeople.length ? filedPeople : people(grouped.groups);
  reportRows = source.map(r => ({ ...r, wiki: (reportRows.find(x => x.name === r.name) || {}).wiki }));
  if (!reportRows.length) { $("report").innerHTML = `<p class="none">No named people yet.</p>`; $("lookup").disabled = true; $("copy_report").disabled = true; return; }
  $("report").innerHTML = `<table class="report"><thead><tr>
      <th>Person</th><th>Headshots</th><th>Sittings</th><th>Organisation</th><th>Wikipedia</th></tr></thead><tbody>`
    + reportRows.map(r => `<tr><td>${esc(r.name)}</td><td>${r.shots}</td><td>${r.sessions}</td>
        <td>${esc(r.person.organisation || "")}</td><td>${r.wiki || "<span class=\"muted\">not looked up</span>"}</td></tr>`).join("")
    + `</tbody></table>`;
  $("lookup").disabled = false; $("copy_report").disabled = false;
}

// The only network call on this page. Searches en.wikipedia for each name, then
// asks in one batch which of the articles found already have a lead photo —
// which is the point of the rest of this site.
const WP = "https://en.wikipedia.org/w/api.php";
async function wpGet(params) {
  const q = new URLSearchParams({ ...params, format: "json", origin: "*" });
  const r = await fetch(`${WP}?${q}`, { credentials: "omit" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = await r.json();
  if (d.error) throw new Error(d.error.info || d.error.code);
  return d;
}
$("lookup").addEventListener("click", async () => {
  $("lookup").disabled = true;
  const searchUrl = n => `https://en.wikipedia.org/w/index.php?${new URLSearchParams({ title: "Special:Search", search: n, fulltext: "1", ns0: "1" })}`;
  try {
    const titles = new Map();
    for (const [i, r] of reportRows.entries()) {
      $("lookup").textContent = `Looking up ${i + 1} of ${reportRows.length}…`;
      try {
        const d = await wpGet({ action: "query", list: "search", srsearch: r.name, srlimit: "1", srnamespace: "0" });
        const hit = ((d.query || {}).search || [])[0];
        if (hit) { titles.set(r.name, hit.title); r.wiki = `<a href="https://en.wikipedia.org/wiki/${encodeURIComponent(hit.title.replace(/ /g, "_"))}" target="_blank" rel="noopener">${esc(hit.title)}</a>`; }
        else r.wiki = `<a href="${esc(searchUrl(r.name))}" target="_blank" rel="noopener">no article found — search</a>`;
      } catch (err) { r.wiki = `<span class="warn">lookup failed</span>`; }
      renderReport();
    }
    // Which of those articles have no lead photo? 50 titles per request.
    const list = [...titles.values()];
    for (let i = 0; i < list.length; i += 50) {
      const batch = list.slice(i, i + 50);
      const d = await wpGet({ action: "query", titles: batch.join("|"), prop: "pageimages", piprop: "name", pilicense: "any", redirects: "1" });
      const alias = {};
      for (const n of (d.query || {}).normalized || []) alias[n.to] = n.from;
      for (const rd of (d.query || {}).redirects || []) alias[rd.to] = alias[rd.from] || rd.from;
      const hasPhoto = new Map();
      for (const pg of Object.values((d.query || {}).pages || {})) hasPhoto.set(alias[pg.title] || pg.title, !!pg.pageimage);
      for (const r of reportRows) {
        const t = titles.get(r.name);
        if (t == null || !hasPhoto.has(t)) continue;
        r.wiki += hasPhoto.get(t) ? ` <span class="muted">· has a photo</span>` : ` <span class="warn">· no photo</span>`;
      }
      renderReport();
    }
  } finally {
    $("lookup").textContent = "Look up on Wikipedia (online)";
    $("lookup").disabled = false;
  }
});
$("copy_report").addEventListener("click", async () => {
  const text = [`Headshots — ${dir ? dir.name : ""}`, ""]
    .concat(reportRows.map(r => `${r.name}\t${r.shots} headshot(s)${r.person.organisation ? "\t" + r.person.organisation : ""}`)).join("\n");
  const btn = $("copy_report"), orig = btn.textContent;
  try { await navigator.clipboard.writeText(text); btn.textContent = "Copied"; }
  catch (_) { btn.textContent = "Copy failed"; }
  setTimeout(() => { btn.textContent = orig; }, 1500);
});

// ---- housekeeping ----
$("forget").addEventListener("click", async () => {
  if (!confirm("Forget the remembered names, thumbnails and folder for this shoot?\n\nYour photos are not touched.")) return;
  await store.clear();
  scanCache = {}; thumbs.clear(); photos = []; dir = null; session = null;
  location.reload();
});
const setAbout = open => { $("about_overlay").hidden = !open; };
$("about_btn").addEventListener("click", () => setAbout(true));
$("about_close").addEventListener("click", () => setAbout(false));
$("about_overlay").addEventListener("click", e => { if (e.target === $("about_overlay")) setAbout(false); });
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("about_overlay").hidden) setAbout(false); });

let installPrompt = null;
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); installPrompt = e; $("install").hidden = false; });
$("install").addEventListener("click", async () => {
  if (!installPrompt) return;
  $("install").hidden = true;
  installPrompt.prompt();
  installPrompt = null;
});

(async function start() {
  if ("serviceWorker" in navigator) {
    // Scoped to this folder by where the file sits, so the rest of the site is untouched.
    navigator.serviceWorker.register("sw.js")
      .catch(err => console.warn("headshots: offline use unavailable —", err));
  }
  checkRequirements();                        // not awaited: the model check is slow
  try {
    scanCache = (await store.get("scanCache")) || {};
    if (await store.get("lastDir")) $("reopen").hidden = false;
  } catch (_) { scanCache = {}; }
})();
