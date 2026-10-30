// Checking that a run of headshots really is one person.
//
// Time order says which badge a photo follows; it cannot say whether the person
// changed. This compares the faces: each headshot's face is cropped, turned into
// a vector with MediaPipe's image embedder, and compared by cosine similarity.
//
// Measured on one event's photos (2026-10-30, 4 people, 12 photos, same backdrop
// and lighting — the hard case): same person 0.61–0.97, different people
// 0.17–0.48. Separated, but the margin is thinnest for group shots, where the
// biggest face may not be the subject. So this only ever *flags* photos for a
// human to look at. It never regroups or files anything by itself.
//
// These are generic image embeddings, not face recognition: they say "these two
// crops look alike", and are used only to compare photos within one shoot. No
// identity is stored, and nothing is matched against any database of people.

const VENDOR = "../vendor/mediapipe/";
const CACHE_PREFIX = "headshots-mediapipe-";

// Only what the comparison needs — not the face-landmark or pose models.
export const NEEDED = [
  "vision_bundle.mjs",
  "vision_wasm_internal.js",
  "vision_wasm_internal.wasm",
  "blaze_face_full_range.tflite",
  "mobilenet_v3_small.tflite",
];
const TYPES = { mjs: "text/javascript", js: "text/javascript", wasm: "application/wasm", tflite: "application/octet-stream" };

export const SAME_MIN = 0.55;      // below: "have a look at this one"
export const DETECT_MIN = 0.4;     // face detector confidence floor
const CROP_MARGIN = 1.5;           // crop side as a multiple of the face box
const CROP_SIZE = 224;             // what the embedder sees
// The detector scales whatever it is given down to its own small input, so a
// face that is small within a big image disappears: on a 1801x2548 programme
// page, a 150px face lands at about 11px and only 1 of 4 portraits was found.
// Big images are therefore cut into overlapping tiles and each is searched.
const TILE_OVER = 1100;            // tile anything whose long edge exceeds this
const TILE_EDGE = 760;             // target tile size
const TILE_OVERLAP = 0.25;         // so a face on a seam is whole in one tile
const DEDUPE_IOU = 0.35;           // two boxes this close are the same face

let cached = null;                 // the parsed versions.json
let mp = null, detector = null, embedder = null;

async function sha256Hex(buf) {
  const h = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function manifest() {
  if (cached) return cached;
  const r = await fetch(`${VENDOR}versions.json?t=${Date.now()}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`cannot read the model list (HTTP ${r.status})`);
  cached = await r.json();
  return cached;
}
const filesNeeded = m => m.files.filter(f => NEEDED.includes(f.name));
const cacheName = m => CACHE_PREFIX + m.release;

// "ready" | "missing" | { outdated: [old release ids] }, plus the byte count.
export async function state() {
  const m = await manifest();
  const bytes = filesNeeded(m).reduce((n, f) => n + f.bytes, 0);
  const mine = (await caches.keys()).filter(k => k.startsWith(CACHE_PREFIX));
  if (mine.includes(cacheName(m))) {
    const c = await caches.open(cacheName(m));
    const all = await Promise.all(filesNeeded(m).map(f => c.match(f.path)));
    if (all.every(Boolean)) return { status: "ready", release: m.release, bytes };
  }
  const old = mine.filter(k => k !== cacheName(m)).map(k => k.slice(CACHE_PREFIX.length));
  return { status: old.length ? "outdated" : "missing", release: m.release, bytes, old };
}

// Download from this site and verify every file against its SHA-256 before it is
// kept. A mismatch throws and leaves nothing behind.
export async function save(onProgress) {
  const m = await manifest();
  const name = cacheName(m);
  await caches.delete(name);
  const c = await caches.open(name);
  const want = filesNeeded(m);
  let done = 0;
  const total = want.reduce((n, f) => n + f.bytes, 0);
  for (const f of want) {
    if (onProgress) onProgress(done, total, f.name);
    const r = await fetch(VENDOR + f.path.replace(/^vendor\/mediapipe\//, ""), { cache: "no-store" });
    if (!r.ok) throw new Error(`${f.name}: HTTP ${r.status}`);
    const buf = await r.arrayBuffer();
    if (buf.byteLength !== f.bytes || await sha256Hex(buf) !== f.sha256) {
      await caches.delete(name);
      throw new Error(`${f.name} does not match its SHA-256 — nothing kept`);
    }
    await c.put(f.path, new Response(buf, { headers: { "Content-Type": TYPES[f.name.split(".").pop()] || "application/octet-stream" } }));
    done += f.bytes;
    if (onProgress) onProgress(done, total, f.name);
  }
  for (const k of await caches.keys()) if (k.startsWith(CACHE_PREFIX) && k !== name) await caches.delete(k);
}

export async function remove() {
  for (const k of await caches.keys()) if (k.startsWith(CACHE_PREFIX)) await caches.delete(k);
  mp = detector = embedder = null;
}

// Loaded only from the verified copy in Cache Storage — never straight off the network.
export async function load() {
  if (detector && embedder) return;
  const m = await manifest();
  const c = await caches.open(cacheName(m));
  const path = n => m.files.find(f => f.name === n).path;
  const buf = async n => {
    const hit = await c.match(path(n));
    if (!hit) throw new Error(`${n} is not saved — press the download button first`);
    return hit.arrayBuffer();
  };
  const blobUrl = async n => URL.createObjectURL(new Blob([await buf(n)], { type: TYPES[n.split(".").pop()] }));
  mp = await import(await blobUrl("vision_bundle.mjs"));
  const fileset = { wasmLoaderPath: await blobUrl("vision_wasm_internal.js"),
                    wasmBinaryPath: await blobUrl("vision_wasm_internal.wasm") };
  detector = await mp.FaceDetector.createFromOptions(fileset, {
    baseOptions: { modelAssetBuffer: new Uint8Array(await buf("blaze_face_full_range.tflite")), delegate: "CPU" },
    runningMode: "IMAGE", minDetectionConfidence: DETECT_MIN });
  embedder = await mp.ImageEmbedder.createFromOptions(fileset, {
    baseOptions: { modelAssetBuffer: new Uint8Array(await buf("mobilenet_v3_small.tflite")), delegate: "CPU" },
    runningMode: "IMAGE", quantize: false, l2Normalize: true });
}

// A square crop around one face, padded rather than stretched so the embedder
// always sees the same geometry.
function cropFace(source, bb) {
  const side = Math.max(bb.width, bb.height) * CROP_MARGIN;
  const cx = bb.originX + bb.width / 2, cy = bb.originY + bb.height / 2;
  const c = document.createElement("canvas");
  c.width = c.height = CROP_SIZE;
  const g = c.getContext("2d", { alpha: false });
  g.fillStyle = "#808080"; g.fillRect(0, 0, CROP_SIZE, CROP_SIZE);
  g.drawImage(source, cx - side / 2, cy - side / 2, side, side, 0, 0, CROP_SIZE, CROP_SIZE);
  return c;
}

// Tiles covering an image, each with its offset. One tile when it is small.
function tilesFor(w, h) {
  if (Math.max(w, h) <= TILE_OVER) return [{ x: 0, y: 0, w, h }];
  const step = TILE_EDGE * (1 - TILE_OVERLAP);
  const cols = Math.max(1, Math.ceil((w - TILE_EDGE) / step) + 1);
  const rows = Math.max(1, Math.ceil((h - TILE_EDGE) / step) + 1);
  const out = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const x = Math.min(Math.round(c * step), Math.max(0, w - TILE_EDGE));
      const y = Math.min(Math.round(r * step), Math.max(0, h - TILE_EDGE));
      out.push({ x, y, w: Math.min(TILE_EDGE, w - x), h: Math.min(TILE_EDGE, h - y) });
    }
  return out;
}
const overlaps = (a, b) => {
  const ix = Math.max(0, Math.min(a.originX + a.width, b.originX + b.width) - Math.max(a.originX, b.originX));
  const iy = Math.max(0, Math.min(a.originY + a.height, b.originY + b.height) - Math.max(a.originY, b.originY));
  const inter = ix * iy;
  return inter > DEDUPE_IOU * Math.min(a.width * a.height, b.width * b.height);
};

// Every face in an image, canvas or blob, each with its box and vector, biggest
// first. `tile` searches overlapping tiles as well as the whole image, which is
// what finds the small portraits on a document page.
export async function facesIn(source, { tile = false } = {}) {
  await load();
  const own = !(source instanceof HTMLCanvasElement || source instanceof ImageBitmap);
  const img = own ? await createImageBitmap(source) : source;
  try {
    const W = img.width, H = img.height;
    const raw = [];
    const push = (d, dx, dy) => raw.push({
      originX: d.boundingBox.originX + dx, originY: d.boundingBox.originY + dy,
      width: d.boundingBox.width, height: d.boundingBox.height, score: d.categories[0].score });
    for (const d of detector.detect(img).detections) push(d, 0, 0);   // whole image: the big faces
    if (tile) {
      const tiles = tilesFor(W, H);
      if (tiles.length > 1) {
        const c = document.createElement("canvas");
        const g = c.getContext("2d", { alpha: false });
        for (const t of tiles) {
          c.width = t.w; c.height = t.h;
          g.drawImage(img, t.x, t.y, t.w, t.h, 0, 0, t.w, t.h);
          for (const d of detector.detect(c).detections) push(d, t.x, t.y);
        }
      }
    }
    // Highest score first, then drop anything that is the same face again.
    raw.sort((a, b) => b.score - a.score);
    const kept = [];
    for (const b of raw) if (!kept.some(k => overlaps(k, b))) kept.push(b);
    kept.sort((a, b) => b.width * b.height - a.width * a.height);
    return kept.map(b => ({
      box: { originX: b.originX, originY: b.originY, width: b.width, height: b.height },
      score: b.score,
      vector: embedder.embed(cropFace(img, b)).embeddings[0],
    }));
  } finally {
    if (own) img.close();
  }
}

// The biggest face in a photo, as a vector. null when no face is found — which
// is reported, not treated as a mismatch.
export async function faceOf(blob) {
  const all = await facesIn(blob);
  if (!all.length) return null;
  return { faces: all.length, score: all[0].score, vector: all[0].vector, box: all[0].box };
}

export const similarity = (a, b) => mp.ImageEmbedder.cosineSimilarity(a, b);

// How well each photo fits the rest of its own group: the mean similarity to the
// others, so one odd frame cannot drag the whole group. Fewer than two faces
// means there is nothing to compare.
export function checkGroup(items) {
  const withFace = items.filter(i => i.face);
  if (withFace.length < 2) return { comparable: withFace.length, scores: new Map(), flagged: [], reference: null };
  const scores = new Map();
  for (const a of withFace) {
    const sims = withFace.filter(b => b !== a).map(b => similarity(a.face.vector, b.face.vector));
    scores.set(a.key, sims.reduce((x, y) => x + y, 0) / sims.length);
  }
  // The most typical photo of the group stands for it when comparing groups.
  let reference = null, bestScore = -Infinity;
  for (const a of withFace) {
    const s = scores.get(a.key);
    if (s > bestScore) { bestScore = s; reference = a; }
  }
  return {
    comparable: withFace.length,
    scores,
    flagged: withFace.filter(a => scores.get(a.key) < SAME_MIN).map(a => a.key),
    reference,
  };
}
