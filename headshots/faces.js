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

// The biggest face in a photo, as a vector. null when no face is found — which
// is reported, not treated as a mismatch.
export async function faceOf(blob) {
  await load();
  const bmp = await createImageBitmap(blob);
  try {
    const found = detector.detect(bmp).detections;
    if (!found.length) return null;
    const best = found.slice().sort((a, b) =>
      b.boundingBox.width * b.boundingBox.height - a.boundingBox.width * a.boundingBox.height)[0];
    const bb = best.boundingBox;
    const side = Math.max(bb.width, bb.height) * CROP_MARGIN;
    const cx = bb.originX + bb.width / 2, cy = bb.originY + bb.height / 2;
    const c = document.createElement("canvas");
    c.width = c.height = CROP_SIZE;
    const g = c.getContext("2d", { alpha: false });
    g.fillStyle = "#808080"; g.fillRect(0, 0, CROP_SIZE, CROP_SIZE);   // pad rather than stretch
    g.drawImage(bmp, cx - side / 2, cy - side / 2, side, side, 0, 0, CROP_SIZE, CROP_SIZE);
    const e = embedder.embed(c);
    return { faces: found.length, score: best.categories[0].score, vector: e.embeddings[0] };
  } finally {
    bmp.close();
  }
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
