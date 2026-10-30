// Building a roster of people from a document: a programme, a delegate list, a
// press pack, a screenshot — anything that pairs a photograph with a printed name.
//
// Each page becomes an image, every face on it is found, and the name printed
// with that face is read. The result is a list of people each carrying a face
// vector, so a headshot with no badge can still be matched to a name — by
// comparing faces within this one job, never against any database.
//
// The two jobs here are deliberately separated, because conflating them is what
// went wrong first.
//
//   Where the words are  — the PDF's own text layer. Verbatim, exact, free.
//   Which face they go with — the model, choosing from exactly those words.
//
// Asking the model to *read* the caption was measured doing something worse than
// failing: given a cut-out that did not contain the caption, it returned four
// confident, invented names — "Denzel Washington", "Steve McQueen", "Stephen
// Fry", "Emerald Fennell" for a page whose real guests were Anthony Wonke, Ashley
// Walters, Adam Pearson and Bella Ramsey — and, asked to transcribe what it had
// read, invented a transcription agreeing with each name. A check against the
// same model call cannot catch that.
//
// Deciding *which* printed name belongs to a face is a different question, and
// one the model is good at. It is asked with the page's names as a closed list
// and a schema whose enum admits nothing else, so invention is unrepresentable
// rather than merely discouraged. Position is worked out independently and the
// two are compared: they normally agree, and a disagreement is flagged for a
// human instead of being resolved silently. Both answers are the document's own
// text either way, so a disagreement is about which name, never a made-up one.
//
// Scans and screenshots have no text layer, so there the model has to read after
// all. Those names are returned marked `unverified`.
//
// PDFs are rendered with Mozilla's pdf.js from our vendored copy; images are used
// as they are, so a screenshot or an exported page needs no download at all.

import * as faces from "./faces.js";

const VENDOR = "../vendor/pdfjs/";
const CACHE_PREFIX = "headshots-pdfjs-";
const TYPES = { mjs: "text/javascript" };

export const PAGE_WIDTH = 1800;     // rendered page width: captions must stay readable
export const MAX_PAGES = 40;        // a guard against a huge document
// Where the caption sits relative to the face depends entirely on the layout, so
// the cut-out is tried at growing sizes and the first readable name wins. Two
// measured failures shaped this:
//   too short  — it reads the backdrop inside the photograph instead. On a test
//                programme every name came back as the step-and-repeat banner
//                ("BFI LONDON FILM FESTIVAL").
//   too narrow — the caption is left-aligned to the photograph while the face is
//                centred in it, so a crop measured off the face box clips the
//                start of the name: "Adam Pearson" was read as "earson".
// Growing from tight also keeps a neighbour's name out: the biggest cut-out can
// reach the next column or row, and a name stolen from there is wrong but real,
// so the transcription check below cannot catch it.
//
// Each rung is [face-heights below the face, minimum half-width as a share of the
// page width]. The share matters because a caption is about as wide as its
// column however small the face is. Two rungs, not three: a middle rung was
// measured reaching the caption but still clipping it, so it only ever cost a
// model call.
const CUT_LADDER = [[2.2, 0.10], [6.5, 0.22]];
const CUT_SIDES = 2.2;                // half-width, as a multiple of the face width
const CUT_ABOVE = 0.45;
// Caption matching, as shares of the page: how far to either side still counts as
// the same column, and how far below a face its caption may be printed. The
// nearest qualifying line wins, so a generous reach cannot steal the row below.
const SAME_COLUMN = 0.12;
const PAGE_REACH = 0.35;
// A printed programme's portraits are clear, so weak detections are usually the
// backdrop rather than a person.
const DOC_FACE_MIN = 0.5;

let cached = null, pdfjs = null, worker = null;

async function sha256Hex(buf) {
  const h = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, "0")).join("");
}
export async function manifest() {
  if (cached) return cached;
  const r = await fetch(`${VENDOR}versions.json?t=${Date.now()}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`cannot read the pdf.js version list (HTTP ${r.status})`);
  cached = await r.json();
  return cached;
}
const cacheName = m => CACHE_PREFIX + m.version;

export async function state() {
  const m = await manifest();
  const mine = (await caches.keys()).filter(k => k.startsWith(CACHE_PREFIX));
  if (mine.includes(cacheName(m))) {
    const c = await caches.open(cacheName(m));
    if ((await Promise.all(m.files.map(f => c.match(f.path)))).every(Boolean))
      return { status: "ready", version: m.version, bytes: m.total_bytes };
  }
  const old = mine.filter(k => k !== cacheName(m)).map(k => k.slice(CACHE_PREFIX.length));
  return { status: old.length ? "outdated" : "missing", version: m.version, bytes: m.total_bytes, old };
}
export async function save(onProgress) {
  const m = await manifest();
  const name = cacheName(m);
  await caches.delete(name);
  const c = await caches.open(name);
  let done = 0;
  for (const f of m.files) {
    if (onProgress) onProgress(done, m.total_bytes, f.name);
    const r = await fetch(VENDOR + f.path.replace(/^vendor\/pdfjs\//, ""), { cache: "no-store" });
    if (!r.ok) throw new Error(`${f.name}: HTTP ${r.status}`);
    const buf = await r.arrayBuffer();
    if (buf.byteLength !== f.bytes || await sha256Hex(buf) !== f.sha256) {
      await caches.delete(name);
      throw new Error(`${f.name} does not match its SHA-256 — nothing kept`);
    }
    await c.put(f.path, new Response(buf, { headers: { "Content-Type": TYPES[f.name.split(".").pop()] || "application/octet-stream" } }));
    done += f.bytes;
    if (onProgress) onProgress(done, m.total_bytes, f.name);
  }
  for (const k of await caches.keys()) if (k.startsWith(CACHE_PREFIX) && k !== name) await caches.delete(k);
}
export async function remove() {
  for (const k of await caches.keys()) if (k.startsWith(CACHE_PREFIX)) await caches.delete(k);
  if (worker) { worker.terminate(); worker = null; }
  pdfjs = null;
}

// pdf.js, loaded only from the verified copy. Its worker is handed over as a
// port built from a blob, so no path has to resolve at run time.
async function loadPdfjs() {
  if (pdfjs) return pdfjs;
  const m = await manifest();
  const c = await caches.open(cacheName(m));
  const blobUrl = async name => {
    const f = m.files.find(x => x.name === name);
    const hit = await c.match(f.path);
    if (!hit) throw new Error(`${name} is not saved — download pdf.js first`);
    return URL.createObjectURL(new Blob([await hit.arrayBuffer()], { type: "text/javascript" }));
  };
  const lib = await import(await blobUrl("pdf.min.mjs"));
  worker = new Worker(await blobUrl("pdf.worker.min.mjs"), { type: "module" });
  lib.GlobalWorkerOptions.workerPort = worker;
  pdfjs = lib;
  return pdfjs;
}

export const isPdf = file => file.type === "application/pdf" || /\.pdf$/i.test(file.name);

// Every page of a document as a canvas. Images come through as a single page.
export async function pageImages(file, onProgress) {
  if (!isPdf(file)) {
    const bmp = await createImageBitmap(file);
    const c = document.createElement("canvas");
    c.width = bmp.width; c.height = bmp.height;
    c.getContext("2d", { alpha: false }).drawImage(bmp, 0, 0);
    bmp.close();
    if (onProgress) onProgress(1, 1);
    return { pages: [c], texts: [null], numPages: 1, truncated: false };
  }
  const lib = await loadPdfjs();
  const doc = await lib.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    isEvalSupported: false,          // no dynamic code from the document
    useSystemFonts: false,           // deterministic rendering
  }).promise;
  const pages = [], texts = [];
  const count = Math.min(doc.numPages, MAX_PAGES);
  for (let i = 1; i <= count; i++) {
    if (onProgress) onProgress(i, count);
    const page = await doc.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(4, PAGE_WIDTH / base.width) });
    const c = document.createElement("canvas");
    c.width = Math.ceil(viewport.width); c.height = Math.ceil(viewport.height);
    const g = c.getContext("2d", { alpha: false });
    g.fillStyle = "#ffffff"; g.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: g, viewport }).promise;
    pages.push(c);
    texts.push(await textBoxes(lib, page, viewport));
    page.cleanup();
  }
  return { pages, texts, numPages: doc.numPages, truncated: doc.numPages > count };
}

// The page's own text, each run with its box in rendered pixels. null when the
// page carries no text at all, which is what a scan looks like.
async function textBoxes(lib, page, viewport) {
  let content;
  try { content = await page.getTextContent(); }
  catch (_) { return null; }
  const out = [];
  for (const it of content.items) {
    if (!it.str || !it.str.trim()) continue;
    const tx = lib.Util.transform(viewport.transform, it.transform);
    const h = Math.hypot(tx[2], tx[3]) || Math.abs(tx[3]) || 1;
    out.push({ str: it.str, x: tx[4], y: tx[5] - h, w: (it.width || 0) * viewport.scale, h });
  }
  return out.length ? out : null;
}

// Runs on roughly the same baseline, joined left to right, top line first.
//
// A wide horizontal gap splits the line. Captions in a grid share a baseline
// across columns, so without this the two names in a row are joined into one:
// a test programme produced "Anthony WonkeAshley Walters" and then matched it to
// neither face. The gap only has to beat a word space, so it is measured against
// the font height.
const GAP_SPLIT = 1.0;        // multiples of the run's height

export function linesOf(items) {
  const rows = [];
  for (const it of [...items].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const row = rows.find(r => Math.abs(r.y - it.y) <= Math.max(3, it.h * 0.6));
    if (row) { row.parts.push(it); row.y = Math.min(row.y, it.y); }
    else rows.push({ y: it.y, h: it.h, parts: [it] });
  }
  const out = [];
  for (const r of rows) {
    let run = [];
    const flush = () => {
      if (!run.length) return;
      const text = run.map(p => p.str).join("").replace(/\s+/g, " ").trim();
      if (text) out.push({
        text,
        x: Math.min(...run.map(p => p.x)),
        right: Math.max(...run.map(p => p.x + p.w)),
        y: Math.min(...run.map(p => p.y)),
        h: Math.max(...run.map(p => p.h)),
      });
      run = [];
    };
    for (const p of r.parts.sort((a, b) => a.x - b.x)) {
      const prev = run[run.length - 1];
      if (prev && p.x - (prev.x + prev.w) > Math.max(prev.h * GAP_SPLIT, 10)) flush();
      run.push(p);
    }
    flush();
  }
  return out.sort((a, b) => a.y - b.y || a.x - b.x);
}

// The cut-out shown to the picker. Measured against the page, for the same reason
// captionFor() is: in face-heights, a small face's crop stopped short of its
// caption and the model — correctly — answered "none" rather than guess. It
// declined on two of four faces on the test page for exactly that reason.
//
// A crop generous enough to hold the caption can also hold a neighbour's face, so
// the one being asked about is outlined and the prompt refers to the outline.
// That is more reliable than "the face in the middle", which a tall crop makes
// untrue.
const PICK_SIDES = 0.22;            // half-width, as a share of the page width
const PICK_MARK = "#ff2d55";
const PICK_MARK_WIDTH = 6;

function pickCut(pageCanvas, box) {
  const half = Math.max(box.width * CUT_SIDES, pageCanvas.width * PICK_SIDES);
  const cx = box.originX + box.width / 2;
  const x0 = Math.max(0, cx - half);
  const x1 = Math.min(pageCanvas.width, cx + half);
  const y0 = Math.max(0, box.originY - box.height * CUT_ABOVE);
  const y1 = Math.min(pageCanvas.height,
    box.originY + box.height + pageCanvas.height * PAGE_REACH);
  const w = Math.max(1, Math.round(x1 - x0)), h = Math.max(1, Math.round(y1 - y0));
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d", { alpha: false });
  g.drawImage(pageCanvas, x0, y0, w, h, 0, 0, w, h);
  g.strokeStyle = PICK_MARK;
  g.lineWidth = PICK_MARK_WIDTH;
  g.strokeRect(box.originX - x0 - PICK_MARK_WIDTH / 2, box.originY - y0 - PICK_MARK_WIDTH / 2,
               box.width + PICK_MARK_WIDTH, box.height + PICK_MARK_WIDTH);
  return c;
}

// Every name-shaped line on a page — the closed list the model must choose from.
export function namesOn(items) {
  if (!items || !items.length) return [];
  return [...new Set(linesOf(items).filter(l => looksLikeName(l.text)).map(l => l.text))];
}

// Does a line read like a person's name, rather than a heading or a job title?
// Two or more words, every one capitalised, no digits.
const looksLikeName = t => /^[^\d]+$/.test(t) && t.split(/\s+/).filter(Boolean).length >= 2
  && t.split(/\s+/).filter(Boolean).every(w => /^[\p{Lu}]/u.test(w)) && t.length <= 60;

// The caption belonging to one face: the nearest lines below it that sit in the
// same column. The name is left-aligned to the photograph while the face is
// centred in it, so the column window is measured from the face centre outwards
// and only has to overlap the line, not contain it.
export function captionFor(items, box, pageWidth, pageHeight) {
  if (!items || !items.length) return null;
  const cx = box.originX + box.width / 2;
  const half = Math.max(box.width * CUT_SIDES, pageWidth * SAME_COLUMN);
  const below = box.originY + box.height * 0.6;
  // How far down to look is a property of the page, not of the face. Measuring it
  // in face-heights lost the small faces: an 82px face in a tall photograph gave
  // a reach of 1152px while its caption was printed at 1280px, so two of four
  // people on a test page were reported as having no caption at all.
  const reach = Math.max(box.height * 4, (pageHeight || pageWidth * 1.41) * PAGE_REACH);
  // Everything in this column, then the part of it within reach below the face.
  // The name comes from the second; the line under the name is looked up in the
  // first, because it belongs to the name rather than to the face — hunting for
  // it inside the reach window missed a "Guest speaker" line by three pixels.
  const column = linesOf(items)
    .filter(l => l.right > cx - half && l.x < cx + half)
    .sort((a, b) => a.y - b.y);
  const nameLine = column.find(l => l.y >= below && l.y <= below + reach && looksLikeName(l.text));
  if (!nameLine) return null;
  const after = column.find(l => l.y > nameLine.y && l.y < nameLine.y + nameLine.h * 3);
  return { name: nameLine.text, organisation: after && !looksLikeName(after.text) ? after.text : "" };
}

// A cut-out around one face, reaching `below` face-heights beneath it and at
// least `minHalf` of the page width to either side.
function cutOut(pageCanvas, box, [below, minHalf]) {
  const half = Math.max(box.width * CUT_SIDES, pageCanvas.width * minHalf);
  const x0 = Math.max(0, box.originX + box.width / 2 - half);
  const x1 = Math.min(pageCanvas.width, box.originX + box.width / 2 + half);
  const y0 = Math.max(0, box.originY - box.height * CUT_ABOVE);
  const y1 = Math.min(pageCanvas.height, box.originY + box.height * (1 + below));
  const w = Math.max(1, Math.round(x1 - x0)), h = Math.max(1, Math.round(y1 - y0));
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  c.getContext("2d", { alpha: false }).drawImage(pageCanvas, x0, y0, w, h, 0, 0, w, h);
  return c;
}
function faceThumb(pageCanvas, box, size = 96) {
  const side = Math.max(box.width, box.height) * 1.5;
  const cx = box.originX + box.width / 2, cy = box.originY + box.height / 2;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d", { alpha: false });
  g.fillStyle = "#808080"; g.fillRect(0, 0, size, size);
  g.drawImage(pageCanvas, cx - side / 2, cy - side / 2, side, side, 0, 0, size, size);
  return c.toDataURL("image/jpeg", 0.7);
}

// Find every portrait in the rendered pages and read the name printed with it.
// `readName` is injected (the Nano caption reader) so this module stays testable
// without a model: pass null and the faces come back unnamed, ready to be typed in.
export async function rosterFrom(pages, opts = {}) {
  const { readName = null, pickName = null, onProgress = null, texts = [] } = opts;
  await faces.load();
  const out = [];
  let n = 0;
  const totalPages = pages.length;
  for (const [pageIndex, page] of pages.entries()) {
    if (onProgress) onProgress({ phase: "faces", page: pageIndex + 1, totalPages });
    const found = (await faces.facesIn(page, { tile: true }))   // pages are large; small portraits need tiling
      .filter(f => f.score >= DOC_FACE_MIN);
    for (const f of found) {
      const entry = {
        key: `p${pageIndex + 1}f${++n}`,
        page: pageIndex + 1,
        score: f.score,
        vector: f.vector,
        thumb: faceThumb(page, f.box),
        name: "", organisation: "", legible: null,
      };
      const items = texts[pageIndex];
      const candidates = namesOn(items);
      if (candidates.length) {
        // Two independent answers from the same verified vocabulary.
        const printed = captionFor(items, f.box, page.width, page.height);
        let picked = null;
        if (pickName) {
          if (onProgress) onProgress({ phase: "names", page: pageIndex + 1, totalPages, done: n });
          picked = await pickName(pickCut(page, f.box), candidates);
        }
        const byModel = picked && picked.name ? picked.name : "";
        const byPlace = printed ? printed.name : "";
        entry.byModel = byModel;
        entry.byPlace = byPlace;
        entry.organisation = printed ? printed.organisation : "";
        entry.source = "document";
        if (byModel && byPlace && byModel !== byPlace) {
          // Both are printed on the page, so this is a question of which — never
          // of a fabricated name. A human decides.
          entry.name = byModel;
          entry.disputed = `the model says ${byModel}, the layout says ${byPlace}`;
          entry.legible = true;
        } else if (byModel || byPlace) {
          entry.name = byModel || byPlace;
          entry.agreed = !!(byModel && byPlace);
          entry.legible = true;
        } else {
          entry.noCaption = true;
          if (picked && picked.error) entry.error = picked.error;
        }
      } else if (items && items.length) {
        // A text layer with no name-shaped line in it: there is nothing on this
        // page to attribute, and asking the model to read would only invent one.
        entry.source = "document";
        entry.noCaption = true;
      } else if (readName) {
        // Widen the cut-out until a name survives the transcription check. The
        // model occasionally fails a single image outright (kErrorUnknown), so a
        // rung that errors is tried once more before moving on.
        let r = null;
        for (const rung of CUT_LADDER) {
          if (onProgress) onProgress({ phase: "names", page: pageIndex + 1, totalPages, done: n, rung });
          const cut = cutOut(page, f.box, rung);
          r = await readName(cut);
          if (r.error) r = await readName(cut);
          entry.tried = rung[0];
          if (r.full_name) break;
        }
        entry.name = r.full_name || "";
        entry.organisation = r.organisation || "";
        entry.legible = r.legible !== false;
        entry.textSeen = r.text_seen || "";
        entry.source = "model";
        // No text layer to check against, and the model has been measured
        // inventing both a name and a transcription agreeing with it.
        if (entry.name) entry.unverified = true;
        if (r.rejected) entry.rejected = r.rejected;
        if (r.error) entry.error = r.error;
      }
      out.push(entry);
    }
  }
  return out;
}

// Best roster match for one face vector, or null when nothing is close enough.
export function bestMatch(vector, roster, min = faces.SAME_MIN) {
  let best = null;
  for (const r of roster) {
    if (!r.vector || !r.name) continue;
    const sim = faces.similarity(vector, r.vector);
    if (!best || sim > best.sim) best = { entry: r, sim };
  }
  return best && best.sim >= min ? best : null;
}
