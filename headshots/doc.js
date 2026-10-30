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
    // fontName comes along because it is what tells a wrapped name from the line
    // under it: "Sharon" / "Duncan-Brewster" are the same font, the role beneath
    // them is not.
    out.push({ str: it.str, x: tx[4], y: tx[5] - h, w: (it.width || 0) * viewport.scale, h, font: it.fontName });
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
        font: run[0].font,
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

function pickCut(pageCanvas, box, pitch, layout) {
  // Roughly one cell, reaching the way the captions actually sit. A crop spanning
  // two columns puts a neighbour's portrait and caption in front of the model and
  // no amount of outlining beats that; a crop that reaches only downwards misses
  // the caption entirely on a page that puts names beside the photographs.
  //
  // Slightly wider than one cell (0.55 of the pitch, not 0.5) on purpose: cropped
  // to exactly the right cell the model can only ever agree with the layout, and
  // then the cross-check tells you nothing. A little of the neighbour leaves it
  // able to disagree.
  const dir = layout ? layout.dir : "below";
  const colHalf = pitch && pitch.col ? pitch.col * 0.55
    : Math.max(box.width * CUT_SIDES, pageCanvas.width * PICK_SIDES);
  const rowHalf = pitch && pitch.row ? pitch.row * 0.55 : box.height * 3;
  const cx = box.originX + box.width / 2, cy = box.originY + box.height / 2;
  const pad = box.height * CUT_ABOVE;
  let x0 = cx - colHalf, x1 = cx + colHalf, y0 = box.originY - pad, y1 = box.originY + box.height + pad;
  if (dir === "below") y1 = box.originY + box.height + rowHalf * 2;
  else if (dir === "above") y0 = box.originY - rowHalf * 2;
  else if (dir === "right") { x1 = cx + colHalf * 2; y0 = cy - rowHalf; y1 = cy + rowHalf; }
  else { x0 = cx - colHalf * 2; y0 = cy - rowHalf; y1 = cy + rowHalf; }
  x0 = Math.max(0, x0); x1 = Math.min(pageCanvas.width, x1);
  y0 = Math.max(0, y0); y1 = Math.min(pageCanvas.height, y1);
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

// ---- the document's own grid ----
// Fractions of the page were the wrong unit. Tuned on a two-column programme,
// SAME_COLUMN = 0.12 of the page width is wider than a column in a four-column
// cast sheet, so the window straddled the neighbour; and a 0.22 half-width gave
// the model a crop two columns wide, which is how one person's name came back for
// three different faces. Measuring the pitch off the page's own captions costs
// nothing and adapts to any layout.
const median = xs => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : 0; };
const centreX = l => (l.x + l.right) / 2;
const centreY = l => l.y + l.h / 2;

const CAPTION_BLOCK = 3;         // line-heights that still belong to one caption
const DIRS = ["below", "right", "above", "left"];

// A line worth considering at all: page numbers and rules are not captions.
const plausible = t => t.length > 0 && t.length <= 80 && /[^\s\d.,;:·|\-–—_/()\[\]]/.test(t);

// ---- the document's grid, measured from its own text ----
// From the text's baselines, not from the photographs. Faces were tried and are
// not usable for this: a face sits at a different height inside each photograph,
// so nine portraits in three rows grouped into five pseudo-rows and the column
// gap came out as 1174px against a true 390px — which put every caption window
// over its left-hand neighbour and widened the model's crop to three columns.
// Fractions of the page were no better: 0.12 page-widths is itself wider than a
// column in a four-column sheet.
//
// Lines sharing a baseline across columns give the column pitch directly, and no
// notion of what a name looks like is involved.
export function gridPitch(items) {
  const lines = linesOf(items || []).filter(l => plausible(l.text));
  if (lines.length < 2) return { col: 0, row: 0 };
  const bands = [];
  for (const l of [...lines].sort((a, b) => a.y - b.y)) {
    const b = bands.find(b => Math.abs(b.y - l.y) <= Math.max(4, l.h * 0.6));
    if (b) b.lines.push(l); else bands.push({ y: l.y, h: l.h, lines: [l] });
  }
  const colGaps = [];
  for (const b of bands) {
    const cs = b.lines.map(centreX).sort((x, y) => x - y);
    for (let i = 1; i < cs.length; i++) colGaps.push(cs[i] - cs[i - 1]);
  }
  // Consecutive bands are a mix of lines within one caption and the step to the
  // next row of them. Only the big gaps are rows.
  const lineH = median(bands.map(b => b.h)) || 12;
  const gaps = [];
  for (let i = 1; i < bands.length; i++) gaps.push(bands[i].y - bands[i - 1].y);
  return { col: median(colGaps), row: median(gaps.filter(g => g > lineH * 3)) };
}

// ---- learning where the captions are ----
// Nothing here asks what a name looks like. Requiring two capitalised words and
// no digits dropped mononyms ("Zendaya"), every name with a lowercase particle
// ("Ludwig van Beethoven", "Hassan al-Banna") and every uncased script — a
// Japanese programme yielded no names at all — while happily accepting
// "EXECUTIVE PRODUCER" and "Director of Photography" as people.
//
// Instead the layout is learned from the page, which is sound because a document
// is laid out consistently: whatever holds for one photograph holds for the rest.
// Only two things are assumed, and both are language-neutral.
// The caption block for one face in one direction, in reading order.
function blockFor(lines, box, dir, pageWidth, pageHeight, pitch, freq) {
  const cx = box.originX + box.width / 2, cy = box.originY + box.height / 2;
  const colHalf = pitch.col ? Math.max(box.width * 0.6, pitch.col * 0.45)
    : Math.max(box.width * CUT_SIDES, pageWidth * SAME_COLUMN);
  const rowHalf = pitch.row ? Math.max(box.height * 0.6, pitch.row * 0.45)
    : box.height * 1.2;
  const reachY = Math.max(box.height * 4, pageHeight * PAGE_REACH);
  const reachX = Math.max(box.width * 4, pageWidth * PAGE_REACH);
  const sameCol = l => Math.abs(centreX(l) - cx) <= colHalf || (l.x <= cx && l.right >= cx);
  const sameRow = l => Math.abs(centreY(l) - cy) <= rowHalf || (l.y <= cy && l.y + l.h >= cy);
  // Which side of the face a line sits on is judged by its centre, not its edges.
  // An edge test discards a caption wider than the photograph it belongs to —
  // "Sharon Duncan-Brewster" reached past the picture and was dropped, leaving
  // only the role beneath it.
  let pool, dist;
  if (dir === "below") {
    dist = l => centreY(l) - cy;
    pool = lines.filter(l => dist(l) > 0 && dist(l) <= box.height / 2 + reachY && sameCol(l));
  } else if (dir === "above") {
    dist = l => cy - centreY(l);
    pool = lines.filter(l => dist(l) > 0 && dist(l) <= box.height / 2 + reachY && sameCol(l));
  } else if (dir === "right") {
    dist = l => centreX(l) - cx;
    pool = lines.filter(l => dist(l) > 0 && dist(l) <= box.width / 2 + reachX && sameRow(l));
  } else {
    dist = l => cx - centreX(l);
    pool = lines.filter(l => dist(l) > 0 && dist(l) <= box.width / 2 + reachX && sameRow(l));
  }
  pool = pool.filter(l => plausible(l.text));
  if (!pool.length) return [];
  pool.sort((a, b) => dist(a) - dist(b));
  // The nearest line, plus whatever is stacked with it: a caption is a little
  // block of lines, not one line.
  //
  // Grouped on both axes. Beside-the-photo layouts are selected by row, so a
  // cell could see the previous cell's lines at the same height and, sorted by
  // position, hand back the neighbour's name. Centres rather than edges, because
  // centred captions of different widths share a centre and not a left edge.
  const first = pool[0];
  const spread = Math.max(first.h * 6, (pitch.col || 0) * 0.4);
  const block = pool.filter(l => Math.abs(l.y - first.y) <= first.h * CAPTION_BLOCK
                                 && Math.abs(centreX(l) - centreX(first)) <= spread)
                    .sort((a, b) => a.y - b.y || a.x - b.x);
  // A long name wraps, and the second half was landing in the field below it —
  // "Sharon Duncan-Brewster" came out as "Sharon" with "Duncan-Brewster" filed as
  // the organisation. Lines set in the same font and stacked tightly are one
  // entry, which is also what keeps the slots lined up across the page: without
  // it, one wrapped name shifts that person's role into a different slot from
  // everybody else's.
  const merged = [];
  for (const l of block) {
    const prev = merged[merged.length - 1];
    // Same font, tightly stacked, and the text appears only once on the page.
    // The font alone is not enough: a document that sets the name and the role
    // in one font would have the role swallowed into the name. A role repeats
    // down the page — CAST, CAST, CAST — and half a name does not.
    const continues = prev && prev.font && l.font && prev.font === l.font
      && l.y - (prev.y + prev.h) <= l.h * 1.2
      && (!freq || (freq.get(l.text) || 0) <= 1);
    if (continues) {
      // No space after a hyphen: the break falls inside "Duncan-Brewster", and
      // also inside any ordinary hyphenated word split across two lines.
      prev.text += (/-$/.test(prev.text) ? "" : " ") + l.text;
      prev.h = (l.y + l.h) - prev.y;
      prev.x = Math.min(prev.x, l.x);
      prev.right = Math.max(prev.right, l.right);
    } else merged.push({ ...l });
  }
  return merged;
}

// Where this page keeps its captions, and which line of one is the name.
//
// Direction is scored across every face at once: the right direction finds a
// caption for most faces and finds a *different* one for each. A heading above a
// row of photographs is the same text for all of them, so "above" scores badly
// wherever the captions are really below.
//
// Which line is the name then falls out of repetition, which is the whole gift of
// a consistently laid-out document: roles repeat down a page — CAST, CAST, CAST,
// PRODUCER — and names do not. No wordlist, no language, no case.
// How often each line's text appears on the page: what separates a repeated
// field from a one-off, with no idea of what either means.
function textFreq(lines) {
  const m = new Map();
  for (const l of lines) m.set(l.text, (m.get(l.text) || 0) + 1);
  return m;
}

export function learnLayout(items, boxes, pageWidth, pageHeight, pitch) {
  const lines = linesOf(items || []);
  const list = (boxes || []).filter(Boolean);
  if (!lines.length || !list.length) return null;
  const freq = textFreq(lines);

  // Which line of a caption carries the name, and how name-like that line is
  // across the whole page. Roles repeat, names do not.
  const slots = blocks => {
    const depth = Math.max(0, ...blocks.map(b => b.length));
    let slot = 0, unique = null;
    for (let i = 0; i < depth; i++) {
      const vals = blocks.map(b => b[i]).filter(Boolean).map(l => l.text);
      if (vals.length < 2) continue;                  // one sample proves nothing
      const u = new Set(vals).size / vals.length;
      if (unique === null || u > unique) { unique = u; slot = i; }   // ties keep the earlier line
    }
    return { slot, unique };
  };

  let best = null;
  for (const dir of DIRS) {
    const blocks = list.map(b => blockFor(lines, b, dir, pageWidth, pageHeight, pitch, freq));
    const found = blocks.filter(b => b.length);
    if (!found.length) continue;
    const { slot, unique } = slots(blocks);
    // Scored on how well the direction yields a uniquely-valued line across every
    // face — not on its *first* line. Scoring the first line punished the right
    // answer whenever a role was printed above the name, since every caption then
    // begins with the same word.
    const score = (found.length / list.length) * (unique === null ? 1 : unique);
    // With one photograph there is no repetition to judge by, so the nearest
    // caption wins instead of a direction being assumed.
    const near = found.reduce((n, b) => n + Math.abs(b[0].y), 0) / found.length;
    if (!best || score > best.score + 1e-9 || (Math.abs(score - best.score) < 1e-9 && near < best.near))
      best = { dir, score, near, slot, unique, depth: Math.max(...blocks.map(b => b.length)) };
  }
  if (!best) return null;
  return { dir: best.dir, nameSlot: best.slot, uniqueness: best.unique, score: best.score, depth: best.depth };
}

// This face's caption, using the layout learned for the page.
export function captionFor(items, box, pageWidth, pageHeight, pitch, layout) {
  if (!items || !items.length || !layout) return null;
  const all = linesOf(items);
  const block = blockFor(all, box, layout.dir, pageWidth, pageHeight, pitch || { col: 0, row: 0 }, textFreq(all));
  if (!block.length) return null;
  const i = block[layout.nameSlot] ? layout.nameSlot : 0;
  return {
    name: block[i].text,
    organisation: block.filter((_, j) => j !== i).map(l => l.text).join(" · "),
  };
}

// The closed list the model chooses from: the names this page's own layout gives.
export function namesOn(items, boxes, pageWidth, pageHeight, pitch, layout) {
  const list = (boxes || []).filter(Boolean);
  if (!layout || !list.length) return [];
  const out = [];
  for (const b of list) {
    const c = captionFor(items, b, pageWidth, pageHeight, pitch, layout);
    if (c && c.name) out.push(c.name);
  }
  return [...new Set(out)];
}

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
    // Every face first, because the layout is learned from all of them together:
    // one photograph cannot tell you which direction the captions sit in, nor
    // which line of a caption is the name.
    const items = texts[pageIndex];
    const pitch = gridPitch(items);
    const layout = learnLayout(items, found.map(f => f.box), page.width, page.height, pitch);
    const candidates = namesOn(items, found.map(f => f.box), page.width, page.height, pitch, layout);
    let onPage = 0;
    for (const f of found) {
      const entry = {
        key: `p${pageIndex + 1}f${++n}`,
        page: pageIndex + 1,
        score: f.score,
        vector: f.vector,
        thumb: faceThumb(page, f.box),
        name: "", organisation: "", legible: null,
      };
      if (candidates.length) {
        // Two answers from the same verified vocabulary.
        const printed = captionFor(items, f.box, page.width, page.height, pitch, layout);
        let picked = null;
        if (pickName) {
          if (onProgress) onProgress({ phase: "names", page: pageIndex + 1, totalPages,
                                       done: n, index: ++onPage, count: found.length });
          picked = await pickName(pickCut(page, f.box, pitch, layout), candidates);
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
        if (layout) entry.layout = layout.dir;
      } else if (items && items.length) {
        // A text layer the layout found nothing in: there is nothing on this page
        // to attribute, and asking the model to read would only invent something.
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
