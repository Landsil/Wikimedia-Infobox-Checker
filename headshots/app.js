// Headshots — wiring for index.html. The file work lives in shoot.js, the badge
// reading in identify.js, and neither touches the DOM, so both are testable on
// their own (see check.html).

import { listPhotos, groupPhotos, applyGroups, people, stemFor, DONE_DIR } from "./shoot.js";
import { nanoPresent, nanoAvailability, createSession, downloadModel, identify, readCaption, pickName, forModel } from "./identify.js";
import * as store from "./db.js";
import { buildDemoShoot } from "./demo.js";
import * as faces from "./faces.js";
import * as doc from "./doc.js";

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

// ---- step 1: setup ----
// Every dependency is settled here, before a folder is even chosen. Discovering
// mid-shoot that a 19 MB download or Chrome's model is missing is exactly the
// interruption this step exists to prevent, so nothing below asks for a download
// of its own.
let canPickFolder = false;
let setup = null;          // last known state of each dependency

async function readSetup() {
  canPickFolder = typeof window.showDirectoryPicker === "function";
  const [f, d] = await Promise.all([
    faces.state().catch(err => ({ status: "error", error: err.message, bytes: 0 })),
    doc.state().catch(err => ({ status: "error", error: err.message, bytes: 0 })),
  ]);
  // Chrome can take seconds to answer, so the rest is shown first.
  const model = nanoPresent() ? await nanoAvailability() : "absent";
  setup = { faces: f, pdfjs: d, model };
  return setup;
}

const MODEL_WORDS = {
  available: ["ready", "ok", "Downloaded and ready ✓"],
  downloading: ["being downloaded", "need", "Chrome is downloading it now — this step can wait."],
  downloadable: ["not downloaded", "need", "Chrome has it but has not downloaded it yet. It is Chrome's download, not ours: about 2 GB, once per machine."],
  unavailable: ["unavailable", "bad", "Chrome reports it as unavailable on this device. See <em>What it needs</em> in About — usually free disk space, RAM or VRAM."],
  absent: ["not in this browser", "bad", "This browser has no built-in model. It needs Chrome 148+ on a desktop; Edge has it only behind a flag."],
};

function renderSetup() {
  if (!setup) { $("setup_list").innerHTML = row("Checking", "…"); return; }
  const rows = [];
  const line = (cls, title, detail, button) =>
    rows.push(`<div class="setup-row ${cls}"><div class="setup-what"><strong>${title}</strong>
      <span class="setup-detail">${detail}</span></div>
      <div class="setup-do">${button || ""}</div></div>`);

  line(canPickFolder ? "ok" : "bad", "Renaming files in your folder",
    canPickFolder ? "Supported by this browser ✓"
      : "Not supported here. Renaming needs the File System Access API, which only Chrome and Edge have, on desktop — Firefox and Safari have it on no platform.");

  const f = setup.faces;
  line(f.status === "ready" ? "ok" : f.status === "missing" ? "need" : "bad",
    `Face models — ${mb(f.bytes || 0)}`,
    f.status === "ready" ? `Saved in this browser (<code>${esc(f.release || "")}</code>) ✓`
      : f.status === "missing" ? "Needed to find faces, compare them, and read a programme. Comes from this site and is checked against its SHA-256."
      : f.status === "error" ? `Could not be checked: ${esc(f.error || "")}`
      : `Your saved copy (<code>${esc((f.old || []).join(", "))}</code>) is out of date; the current one is <code>${esc(f.release || "")}</code>.`,
    f.status === "ready" ? "" : `<button type="button" id="setup_faces">${f.status === "missing" ? "Download" : "Update"} (${mb(f.bytes || 0)})</button>`);

  const d = setup.pdfjs;
  line(d.status === "ready" ? "ok" : d.status === "missing" ? "need" : "bad",
    `PDF reader — ${mb(d.bytes || 0)}`,
    d.status === "ready" ? `Saved in this browser (pdf.js <code>${esc(d.version || "")}</code>) ✓`
      : d.status === "missing" ? "Needed only to read a PDF programme. Mozilla's pdf.js, from this site, checked against its SHA-256."
      : d.status === "error" ? `Could not be checked: ${esc(d.error || "")}`
      : `Your saved copy is out of date; the current one is <code>${esc(d.version || "")}</code>.`,
    d.status === "ready" ? "" : `<button type="button" id="setup_pdfjs">${d.status === "missing" ? "Download" : "Update"} (${mb(d.bytes || 0)})</button>`);

  const [what, cls, detail] = MODEL_WORDS[setup.model] || ["unknown", "bad", `Chrome answered <code>${esc(String(setup.model))}</code>.`];
  const warm = setup.model === "available" && session;
  line(cls === "ok" && !warm ? "need" : cls, "Chrome's built-in model",
    cls !== "ok" ? `${detail} <em>(${what})</em>`
      : warm ? "Downloaded, and started and ready to use ✓"
      : "Downloaded, but not started yet. Starting it here means a document or a badge never waits for it.",
    setup.model === "downloadable" ? `<button type="button" id="setup_model">Download it</button>`
      : cls === "ok" && !warm ? `<button type="button" id="setup_model">Start it</button>` : "");

  $("setup_list").innerHTML = rows.join("");

  // The two site downloads and folder access are what the shoot cannot proceed
  // without. The model is advisory: without it badges are marked by hand.
  const ready = canPickFolder && setup.faces.status === "ready" && setup.pdfjs.status === "ready";
  stepState("step_setup", ready ? "done" : "");
  stepState("step_folder", ready ? "" : "waiting");
  $("pick").disabled = !canPickFolder;
  $("setup_all").disabled = ready && (setup.model !== "downloadable") && !(setup.model === "available" && !session);
  renderBlockers();
}

function renderBlockers() {
  const out = [];
  if (!canPickFolder) out.push(`<div class="blocker"><p><strong>This browser cannot rename files in your folder.</strong>
    Renaming needs the File System Access API, which only Chrome and Edge have, on desktop.</p>
    <p>You can look around, but the filing step will not work here.</p></div>`);
  if (setup && ["unavailable", "absent"].includes(setup.model))
    out.push(`<div class="blocker warn"><p><strong>No usable built-in model on this device.</strong>
      Badges will not be read for you, and a programme's names cannot be matched to faces automatically.</p>
      <p>Everything else still works: mark the badge frames yourself in step 4 and type the names.</p></div>`);
  $("blockers").innerHTML = out.join("");
}

async function withSetupProgress(label, fn) {
  const bar = $("setup_bar"); bar.hidden = false;
  const fill = bar.firstElementChild;
  fill.style.width = "0%";
  try {
    await fn((done, total) => { fill.style.width = `${Math.round((done / Math.max(1, total)) * 100)}%`; });
  } catch (err) {
    $("setup_list").innerHTML += row(`Could not get ${label}`, esc(`${err.name}: ${err.message}`), true);
  } finally {
    bar.hidden = true;
    await readSetup(); renderSetup();
  }
}

const getFaces = () => withSetupProgress("the face models", p => faces.save(p));
const getPdfjs = () => withSetupProgress("the PDF reader", p => doc.save(p));
// Downloading is not enough: creating the first session can still fetch, which
// is why a model "set up" in step 1 was seen downloading again when a document
// was read. So step 1 also creates the shared session and keeps it.
const getModel = () => withSetupProgress("Chrome's model", async report => {
  await downloadModel(f => report(f, 1));
  await ensureSession(f => report(f, 1));
});

$("setup_list").addEventListener("click", e => {
  const id = e.target.id;
  if (id === "setup_faces") getFaces();
  else if (id === "setup_pdfjs") getPdfjs();
  else if (id === "setup_model") getModel();
});
$("setup_recheck").addEventListener("click", async () => { await readSetup(); renderSetup(); });
$("setup_all").addEventListener("click", async () => {
  $("setup_all").disabled = true;
  if (setup.faces.status !== "ready") await getFaces();
  if (setup.pdfjs.status !== "ready") await getPdfjs();
  if (["downloadable", "available"].includes(setup.model) && !session) await getModel();
  $("setup_all").disabled = false;
});

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
  stepState("step_folder", "done");

  // Only a real folder is worth remembering; the sample is rebuilt on demand.
  if (!isDemo) try { await store.set("lastDir", handle); } catch (_) { /* some builds refuse to clone handles */ }
  // Anything already identified on a previous visit is reused straight away.
  let known = 0;
  for (const p of photos) { const hit = scanCache[cacheKey(p)]; if (hit) { p.id = hit; known++; } }
  if (known) $("scan_info").innerHTML = row("Remembered", `${known} of ${photos.length} photo(s) were already identified on an earlier visit.`);
  renderReview();
  // Straight on into finding the badges and comparing the faces. There is nothing
  // for the operator to decide first, so there is nothing to press.
  await readPhotos();
}

$("pick").addEventListener("click", async () => {
  try {
    const handle = await window.showDirectoryPicker({ mode: "readwrite", id: "headshots-shoot", startIn: "pictures" });
    await useDirectory(handle);
  } catch (err) {
    if (err.name !== "AbortError") $("folder_info").innerHTML = row("Could not open that folder", esc(`${err.name}: ${err.message}`), true);
  }
});
// Only reachable with ?sample=1. It exists so the whole pipeline, renaming
// included, can be driven end to end in a test without a camera or a real folder.
if (new URLSearchParams(location.search).get("sample") === "1") $("sample").hidden = false;
$("sample").addEventListener("click", async () => {
  const btn = $("sample"), orig = btn.textContent;
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

// One model session, shared by the badge pass and the document picker. It is
// only ever created in step 1, so no later step can start a download.
async function ensureSession(onProgress) {
  if (!session) session = await createSession(onProgress);
  return session;
}

// Is the model usable right now without fetching anything?
async function modelReady() {
  if (session) return true;
  if (!nanoPresent()) return false;
  return (await nanoAvailability()) === "available";
}

// ---- step 3: read the badges ----
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
  const tip = id.kind === "identity" ? "Click: this is not a badge" : "Click: mark this a badge";
  return `<figure class="${cls}" data-i="${i}" title="${esc(p.name)} — ${tip}">`
    + `<img src="${thumbs.get(p.name) || ""}" alt="">`
    + `<figcaption>${hhmm(p.time.local)} ${esc(label)}</figcaption></figure>`;
}
function renderScanGrid() {
  $("scan_grid").innerHTML = photos.map(scanCell).join("");
}

// Checking the badges is required, so correcting one has to be possible right
// here rather than only later in the review.
$("scan_grid").addEventListener("click", e => {
  const fig = e.target.closest("figure[data-i]");
  if (!fig) return;
  const p = photos[+fig.dataset.i];
  if (!p) return;
  setIdentity(p, !(p.id && p.id.kind === "identity"));
  renderScanGrid();
  renderReview();
});

// Finding the badges is not a decision anyone has to make, so it is not a step of
// its own any more: it runs as part of reading the folder, and every face is
// embedded in the same pass because a change of face is what separates two people
// nobody badged.
async function readPhotos() {
  stopping = false;
  $("stop").hidden = false; $("scan_bar").hidden = false;
  const bar = $("scan_bar").firstElementChild;
  let read = 0, fromCache = 0, failed = 0;
  try {
    // Step 1 owns the model. Starting a session here could set Chrome's multi-
    // gigabyte download going the moment a folder is opened, which is the thing
    // step 1 exists to prevent — so if it is not ready, the badges are simply not
    // read and the faces are compared anyway.
    if (!(await modelReady())) {
      $("scan_info").innerHTML = row("Badges not read",
        `the built-in model is not set up — finish <a href="#step_setup">step 1</a>, or mark the badges yourself below`, true);
      await embedFaces();
      renderReview();
      return;
    }
    for (let i = 0; i < photos.length; i++) {
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
      + (stopping ? row("Stopped", "part-way — reopen the folder to carry on") : "");
    await embedFaces();
    renderReview();
  } catch (err) {
    $("scan_info").innerHTML = row("Could not read the photos", esc(`${err.name}: ${err.message}`), true);
    renderReview();
  } finally {
    $("stop").hidden = true; $("scan_bar").hidden = true;
  }
}

// Every photo's face, once, so the grouping can tell one subject from the next.
async function embedFaces() {
  if (!(await faceState())) return;
  const bar = $("scan_bar").firstElementChild;
  const todo = photos.filter(p => !faceVecs.has(p.name));
  if (!todo.length) return;
  let n = 0;
  for (const p of todo) {
    if (stopping) break;
    bar.style.width = `${Math.round((++n / todo.length) * 100)}%`;
    $("scan_info").innerHTML = row("Comparing faces", `photo ${n} of ${todo.length}`);
    try {
      const f = await faces.faceOf(await p.handle.getFile());
      faceVecs.set(p.name, f ? { vector: f.vector, score: f.score } : null);
    } catch (_) { faceVecs.set(p.name, null); }
  }
}

// What begins a person nobody badged: a face, and then a different face.
//
// Compared against the most recent frame in the group that had one, so a single
// unusable frame does not split somebody in two. A photo with no detectable face
// never starts a person — that is what keeps test frames, venue shots and the
// badge photographs themselves from becoming people.
function faceStartsNew(p, current) {
  const mine = faceVecs.get(p.name);
  if (!mine) return false;
  if (!current) return true;              // first face of a shoot with no badges
  for (let i = current.shots.length - 1; i >= 0; i--) {
    const theirs = faceVecs.get(current.shots[i].name);
    if (theirs) return faces.similarity(mine.vector, theirs.vector) < faces.SAME_MIN;
  }
  return false;                           // only the badge so far: this is their first frame
}
$("stop").addEventListener("click", () => { stopping = true; });

// ---- step 3: check who is who ----
let grouped = { groups: [], leading: [] };

function clearFaceCheck() {
  for (const p of photos) { delete p.faceScore; delete p.faceFlag; delete p.faceNone; }
  faceWarnings = [];
}
// A photo's vector does not change when the grouping does, so the cache stays —
// only the scores, which are relative to a group, are thrown away.
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
  grouped = groupPhotos(photos, { startsNew: faceStartsNew });
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

  // Nothing is filed until the badges have been looked at. The grouping rests on
  // them, badges are only a suggestion, and not everyone has one — so this is a
  // deliberate stop rather than a formality.
  const checked = $("badges_ok").checked;
  const canApply = named > 0 && checked;
  $("apply").disabled = !canApply;
  // Its own element: writing this into apply_info would wipe the result of a
  // filing that has already happened.
  $("apply_gate").innerHTML = named > 0 && !checked
    ? row("Waiting on you", "Tick <em>I have checked the people above and they are right</em> in step 4 before anything is renamed.", true)
    : "";
  stepState("step_review", groups.length ? "done" : "");
  if (canApply) stepState("step_apply", "");
  renderReport();
}

$("badges_ok").addEventListener("change", renderReview);

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

// ---- faces: vectors, the same-person check, and matching to a document ----
let faceVecs = new Map();   // photo name -> { vector, score }, or null when no face was found

// Readiness only. Downloads belong to step 1, so a missing model here sends you
// back there rather than starting a 19 MB fetch in the middle of the work.
async function faceState() {
  const st = await faces.state();
  if (st.status === "ready") { $("face_state").hidden = true; return true; }
  $("face_state").hidden = false;
  $("face_state").className = "lib-state need";
  $("face_state").innerHTML = `The face models are not set up on this device. `
    + `Finish <a href="#step_setup">step 1</a> first (${mb(st.bytes)}).`;
  return false;
}

// Embed the biggest face in each headshot, skipping any already done.
async function ensureFaceVectors(groups, onStep) {
  await faces.load();
  const todo = groups.flatMap(g => g.shots).filter(p => !faceVecs.has(p.name));
  let n = 0;
  for (const p of todo) {
    if (onStep) onStep(++n, todo.length);
    try {
      const f = await faces.faceOf(await p.handle.getFile());
      if (f) faceVecs.set(p.name, { vector: f.vector, score: f.score });
      else { faceVecs.set(p.name, null); p.faceNone = true; }
    } catch (_) { faceVecs.set(p.name, null); p.faceNone = true; }
  }
}
const groupItems = g => g.shots.filter(p => faceVecs.get(p.name))
  .map(p => ({ key: p.name, face: faceVecs.get(p.name), photo: p }));

async function runFaceCheck() {
  const btn = $("face_check");
  btn.disabled = true;
  try {
    if (!(await faceState())) return;
    const named = grouped.groups.filter(g => g.person);
    if (!named.length) {
      $("face_state").className = "lib-state";
      $("face_state").innerHTML = "Nobody is named yet, so there is nothing to compare.";
      return;
    }
    $("face_state").className = "lib-state";
    $("face_state").innerHTML = "Loading the face models…";
    clearFaceCheck();
    await ensureFaceVectors(named, (n, t) => { $("face_state").innerHTML = `Comparing faces… ${n} of ${t}`; });
    const refs = [];
    for (const g of named) {
      const items = groupItems(g);
      const res = faces.checkGroup(items);
      for (const it of items) {
        const sc = res.scores.get(it.key);
        if (sc != null) { it.photo.faceScore = sc; it.photo.faceFlag = sc < faces.SAME_MIN; }
      }
      if (res.reference) refs.push({ name: stemFor(g.person), vector: res.reference.face.vector });
    }
    // Two people's groups looking alike usually means a badge was missed and one
    // person was shot twice under two names.
    for (let i = 0; i < refs.length; i++)
      for (let j = i + 1; j < refs.length; j++) {
        const sim = faces.similarity(refs[i].vector, refs[j].vector);
        if (sim >= faces.SAME_MIN)
          faceWarnings.push(`${refs[i].name} and ${refs[j].name} look alike (${sim.toFixed(2)}) — one badge may have been missed`);
      }
    const total = named.reduce((t, g) => t + g.shots.length, 0);
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


// ---- step 2: a programme or delegate list ----
let roster = [];

$("doc_files").addEventListener("change", () => {
  $("doc_read").disabled = !($("doc_files").files || []).length;
});

async function pdfjsState() {
  const st = await doc.state();
  if (st.status === "ready") return true;
  $("doc_info").innerHTML = row("Not set up",
    `Reading a PDF needs the PDF reader from <a href="#step_setup">step 1</a> (${mb(st.bytes)}).`, true);
  return false;
}

// Where a name came from decides how much it can be trusted, so it is always on
// screen. A name printed in the document is the document's own text; a name from
// the model is a suggestion that has been measured being confidently wrong.
// How a name was arrived at, worst to best. Both of the middle two take the
// string from the document, so neither can be invented — but only the top one
// has been confirmed twice, and saying so is more use than a flat "from the
// document" on every card.
function nameNote(r) {
  if (!r.name) return null;
  if (r.disputed) return { cls: "warn", text: `${r.disputed} — both are printed on the page` };
  if (r.unverified) return { cls: "warn", text: "read by the model from an image — check it" };
  if (r.agreed) return { cls: "good", text: "model and layout agree ✓" };
  if (r.byModel) return { cls: "", text: "the model matched it; the layout found no name here" };
  if (r.byPlace) return { cls: "", text: "matched by where it is printed; the model was unsure" };
  return { cls: "", text: "printed in the document" };
}

function renderRoster() {
  const named = roster.filter(r => r.name).length;
  const agreed = roster.filter(r => r.agreed).length;
  const disputed = roster.filter(r => r.disputed).length;
  const oneWay = roster.filter(r => r.name && r.source === "document" && !r.agreed && !r.disputed).length;
  const guessed = roster.filter(r => r.name && r.unverified).length;
  $("doc_info").innerHTML =
      row("Faces found", `${roster.length}`, roster.length === 0)
    + row("With a name", `${named}`, named === 0 && roster.length > 0)
    + (agreed ? row("Model and layout agree", `${agreed}`) : "")
    + (oneWay ? row("Only one of the two found a name", `${oneWay}`) : "")
    + (disputed ? row("They disagree", `${disputed} — pick the right one`, true) : "")
    + (guessed ? row("Read by the model, unverified", `${guessed} — please check each one`, true) : "")
    + (roster.length ? row("Next", "Correct any name by typing in it, then use “Name them from the document” in step 5.") : "");
  $("roster").innerHTML = roster.map((r, i) => {
    const n = nameNote(r);
    const note = n ? `<div class="meta-line ${n.cls}">${esc(n.text)}</div>` : "";
    const alt = r.disputed && r.byPlace
      ? `<button type="button" class="mini use-other" data-i="${i}">use “${esc(r.byPlace)}”</button>` : "";
    return `<div class="roster-item${r.name ? "" : " unreadable"}${r.unverified || r.disputed ? " unverified" : ""}">
      <img src="${r.thumb}" alt="">
      <div class="who">
        <input type="text" class="roster-name" data-i="${i}" value="${esc(r.name)}"
               placeholder="${r.noCaption ? "no name printed for this face — type it"
                             : r.legible === false ? "no name read — type it" : "name"}">
        <div class="meta-line">page ${r.page} · face ${r.score.toFixed(2)}${r.organisation ? " · " + esc(r.organisation) : ""}</div>
        ${note}${alt}
      </div></div>`;
  }).join("");
  if ($("name_from_doc")) $("name_from_doc").hidden = named === 0;
}
// Resolving a disagreement by taking the layout's answer instead.
$("roster").addEventListener("click", e => {
  const b = e.target.closest(".use-other");
  if (!b) return;
  const r = roster[+b.dataset.i];
  if (!r) return;
  r.name = r.byPlace;
  delete r.disputed;
  r.agreed = true;
  renderRoster();
});
$("roster").addEventListener("input", e => {
  const el = e.target.closest(".roster-name");
  if (!el) return;
  roster[+el.dataset.i].name = el.value.trim();
});
$("roster").addEventListener("change", () => { renderRoster(); });

async function readDocuments() {
  const files = [...($("doc_files").files || [])];
  if (!files.length) return;
  const btn = $("doc_read");
  btn.disabled = true;
  $("doc_bar").hidden = false;
  const bar = $("doc_bar").firstElementChild;
  try {
    if (files.some(doc.isPdf) && !(await pdfjsState())) return;
    if (!(await faceState())) return;                 // faces are what a roster is built on
    $("doc_info").innerHTML = row("Reading", "Loading the models…");
    // Built lazily: a PDF with a text layer never needs the model, so it is not
    // downloaded or started unless a page turns out to be a scan.
    let sess = null, sessErr = null;
    const reader = async canvas => {
      if (!(await modelReady())) return { legible: false, error: "the model is not set up" };
      if (!sess && !sessErr) {
        try { sess = await ensureSession(); }
        catch (err) {
          sessErr = err;
          $("doc_info").innerHTML = row("Names", `cannot be read automatically (${esc(err.message)}) — type them in`, true);
        }
      }
      return sessErr ? { legible: false, error: sessErr.message } : readCaption(sess, canvas);
    };
    // The picker is the normal path: it only ever chooses between names already
    // taken from the page, so it cannot contribute a name of its own.
    const usable = await modelReady();
    if (!usable)
      $("doc_info").innerHTML = row("Matching by layout only",
        `the built-in model is not set up — finish <a href="#step_setup">step 1</a> to have it match faces to names too`, true);
    const picker = !usable ? null : async (canvas, candidates) => {
      if (!sess && !sessErr) {
        try { sess = await ensureSession(); }
        catch (err) {
          sessErr = err;
          $("doc_info").innerHTML = row("Matching", `the model is unavailable (${esc(err.message)}) — falling back to the printed layout`, true);
        }
      }
      return sessErr ? { name: "" } : pickName(sess, canvas, candidates);
    };
    roster = [];
    for (const [fi, file] of files.entries()) {
      $("doc_info").innerHTML = row("Reading", `${esc(file.name)} (${fi + 1} of ${files.length})`);
      const out = await doc.pageImages(file, (n, total) => {
        bar.style.width = `${Math.round(((fi + (n / Math.max(1, total)) * 0.15) / files.length) * 100)}%`;
        $("doc_info").innerHTML = row("Rendering", `${esc(file.name)} — page ${n} of ${total}`);
      });
      const pages = out.pages;
      const found = await doc.rosterFrom(pages, {
        texts: out.texts,
        readName: reader,                      // only reached by a page with no text layer
        pickName: picker,                      // chooses among that page's printed names
        onProgress: st => {
          // Finding faces and matching names are the slow parts; without a share
          // of the bar the whole read looked frozen on a page of nine people.
          const within = st.phase === "names" && st.count ? st.index / st.count : 0;
          const done = ((st.page - 1) + (st.phase === "faces" ? 0.15 : 0.15 + 0.85 * within)) / Math.max(1, st.totalPages);
          bar.style.width = `${Math.round(((fi + done) / files.length) * 100)}%`;
          $("doc_info").innerHTML = row(st.phase === "faces" ? "Finding faces" : "Matching names to faces",
            `${esc(file.name)} — page ${st.page} of ${st.totalPages}`
            + (st.phase === "names" && st.count ? `, face ${st.index} of ${st.count}` : ""));
        },
      });
      for (const r of found) roster.push({ ...r, key: `${fi}-${r.key}`, file: file.name });
      if (out.truncated)
        $("doc_info").innerHTML += row("Note", `only the first ${pages.length} of ${out.numPages} pages were read`, true);
    }
    if (!reader && roster.length)
      roster.forEach(r => { if (r.source !== "document") r.legible = false; });
    stepState("step_doc", roster.length ? "done" : "");
    renderRoster();
  } catch (err) {
    $("doc_info").innerHTML = row("Could not read the document", esc(`${err.name}: ${err.message}`), true);
  } finally {
    btn.disabled = false;
    $("doc_bar").hidden = true;
  }
}
$("doc_read").addEventListener("click", readDocuments);

// Match anyone still unnamed against the roster, by face. Proposes and shows the
// score; it never files anything on its own.
async function nameFromDocument() {
  const btn = $("name_from_doc");
  btn.disabled = true;
  try {
    const named = roster.filter(r => r.name && r.vector);
    if (!named.length) { $("face_state").hidden = false; $("face_state").className = "lib-state bad";
      $("face_state").innerHTML = "No named faces in the document yet."; return; }
    if (!(await faceState())) return;
    const targets = grouped.groups.filter(g => !g.person && g.shots.length);
    if (!targets.length) { $("face_state").className = "lib-state"; $("face_state").innerHTML = "Everyone already has a name."; return; }
    $("face_state").className = "lib-state";
    await ensureFaceVectors(targets, (n, t) => { $("face_state").innerHTML = `Comparing faces… ${n} of ${t}`; });
    let matched = 0;
    for (const g of targets) {
      const items = groupItems(g);
      if (!items.length) continue;
      const res = faces.checkGroup(items);
      const ref = res.reference || items[0];
      const hit = doc.bestMatch(ref.face.vector, named);
      if (!hit) continue;
      if (g.badge) {
        g.badge.id = { ...(g.badge.id || {}), kind: "identity", full_name: hit.entry.name,
                       given_name: "", family_name: "", organisation: hit.entry.organisation || "",
                       legible: true, fromDocument: hit.sim };
        scanCache[cacheKey(g.badge)] = g.badge.id;
      }
      matched++;
      faceWarnings.push(`${hit.entry.name} taken from the document by face (${hit.sim.toFixed(2)}) — please confirm`);
    }
    await store.set("scanCache", scanCache);
    $("face_state").className = matched ? "lib-state bad" : "lib-state";
    $("face_state").innerHTML = matched
      ? `Proposed ${matched} name(s) from the document — check each one before filing.`
      : `No face in the document was close enough (threshold ${faces.SAME_MIN}).`;
    renderReview();
  } catch (err) {
    $("face_state").className = "lib-state bad";
    $("face_state").innerHTML = esc(`${err.name}: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
}
$("name_from_doc").addEventListener("click", nameFromDocument);

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
  renderSetup();                              // "checking…" until the slow model answer lands
  readSetup().then(renderSetup);
  try {
    scanCache = (await store.get("scanCache")) || {};
    if (await store.get("lastDir")) $("reopen").hidden = false;
  } catch (_) { scanCache = {}; }
})();
