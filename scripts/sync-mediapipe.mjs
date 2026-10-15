// Keeps our copy of Google's MediaPipe (runtime + two models) in
// vendor/mediapipe/, for the trial photo score page (score.html).
//
//   node scripts/sync-mediapipe.mjs           # report what's current vs upstream
//   node scripts/sync-mediapipe.mjs --sync    # download a newer release if there is one
//   node scripts/sync-mediapipe.mjs --sync --version 1.1.1
//        # take exactly this runtime version, skipping the minimum age (an
//        # explicit choice, e.g. to test it; the models still follow the rule)
//
// Sources (the "Google version" the page links to):
//   - runtime: npm package @mediapipe/tasks-vision — the tarball is checked
//     against the registry's integrity hash (sha512) before anything is used;
//   - models: storage.googleapis.com/mediapipe-models/…/latest/…
// Only upstream versions at least MIN_AGE_DAYS old are taken (npm publish time,
// model Last-Modified), so a brand-new release gets time to be vetted first.
//
// Writes vendor/mediapipe/<release>/ (files unmodified, plus LICENSE and
// NOTICE.md) and vendor/mediapipe/versions.json — the manifest the page checks
// its saved copy against (release id, every file's size and SHA-256). A new
// release replaces the old directory; the weekly workflow puts that on a
// branch for review, never straight on main.

import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR = join(ROOT, "vendor", "mediapipe");
const MANIFEST = join(VENDOR, "versions.json");
const MIN_AGE_DAYS = 14;
const PACKAGE = "@mediapipe/tasks-vision";
// Only the SIMD build is kept: every current browser supports WebAssembly SIMD.
const RUNTIME_FILES = ["vision_bundle.mjs", "wasm/vision_wasm_internal.js", "wasm/vision_wasm_internal.wasm"];
const MODELS = {
  // Full-range BlazeFace: finds faces further from the camera (up to ~5 m) —
  // the first pass, before the landmarker reads the face from a crop.
  face_detector_full_range: "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_full_range/float16/latest/blaze_face_full_range.tflite",
  face_landmarker: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task",
  pose_landmarker_lite: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task",
};
const LICENSE_URL = "https://www.apache.org/licenses/LICENSE-2.0.txt";
const UA = "WikimediaInfoboxChecker-sync/1.0 (https://github.com/Landsil/Wikimedia-Infobox-Checker)";

const sync = process.argv.includes("--sync");
const vi = process.argv.indexOf("--version");
const wanted = vi > 0 ? process.argv[vi + 1] : (process.env.WANTED_VERSION || "").trim() || null;
if (wanted && !/^\d+\.\d+\.\d+$/.test(wanted)) throw new Error(`--version must be a stable x.y.z version, not "${wanted}"`);
const day = 86400000;
const sha256 = buf => createHash("sha256").update(buf).digest("hex");
const ymd = d => new Date(d).toISOString().slice(0, 10);
async function get(url, init) {
  const r = await fetch(url, { headers: { "User-Agent": UA }, ...(init || {}) });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r;
}

// Newest stable runtime version published at least MIN_AGE_DAYS ago.
async function pickRuntime() {
  const meta = await (await get(`https://registry.npmjs.org/${PACKAGE}`)).json();
  const cutoff = Date.now() - MIN_AGE_DAYS * day;
  const stable = Object.keys(meta.versions).filter(v => /^\d+\.\d+\.\d+$/.test(v));
  const eligible = stable.filter(v => Date.parse(meta.time[v]) <= cutoff)
    .sort((a, b) => Date.parse(meta.time[a]) - Date.parse(meta.time[b]));
  const latest = stable.sort((a, b) => Date.parse(meta.time[a]) - Date.parse(meta.time[b])).at(-1);
  if (wanted && !stable.includes(wanted)) throw new Error(`${PACKAGE}@${wanted} doesn't exist on npm`);
  const v = wanted || eligible.at(-1);
  return { version: v, explicit: !!wanted, published: meta.time[v], tarball: meta.versions[v].dist.tarball,
           integrity: meta.versions[v].dist.integrity, license: meta.versions[v].license,
           newest_upstream: latest, newest_upstream_published: meta.time[latest] };
}
// Each model's upstream state (HEAD): size and Last-Modified.
async function modelState() {
  const out = {};
  for (const [name, url] of Object.entries(MODELS)) {
    const r = await get(url, { method: "HEAD" });
    out[name] = { url, bytes: +r.headers.get("content-length"), last_modified: r.headers.get("last-modified") };
  }
  return out;
}
const stamp = m => ymd(m.last_modified).replace(/-/g, "");
const releaseId = (rt, models) =>
  `tv-${rt.version}_fd-${stamp(models.face_detector_full_range)}`
  + `_fl-${stamp(models.face_landmarker)}_pl-${stamp(models.pose_landmarker_lite)}`;

const current = existsSync(MANIFEST) ? JSON.parse(await readFile(MANIFEST, "utf8")) : null;
const rt = await pickRuntime();
const models = await modelState();
const tooNewModel = Object.entries(models).find(([, m]) => Date.parse(m.last_modified) > Date.now() - MIN_AGE_DAYS * day);
const release = releaseId(rt, models);

console.log(`current release: ${current ? current.release : "(none)"}`);
console.log(`upstream:        ${release}  (runtime ${rt.version}${rt.explicit ? " — requested explicitly, minimum age skipped" : ""}, published ${ymd(rt.published)}; newest upstream ${rt.newest_upstream}, ${ymd(rt.newest_upstream_published)})`);
if (tooNewModel) console.log(`note: ${tooNewModel[0]} changed upstream less than ${MIN_AGE_DAYS} days ago — waiting.`);
const changed = !current || (current.release !== release && !tooNewModel);
console.log(changed ? "→ a newer release is available" : "→ up to date");
if (process.env.GITHUB_OUTPUT) await writeFile(process.env.GITHUB_OUTPUT,
  `changed=${changed && sync ? 1 : 0}\nrelease=${release}\nprevious=${current ? current.release : ""}\nexplicit=${rt.explicit ? 1 : 0}\n`, { flag: "a" });
if (!sync || !changed) process.exit(0);

// ---- download, verify, write ----
const dir = join(VENDOR, release);
const work = join(tmpdir(), `mediapipe-${release}`);
await rm(work, { recursive: true, force: true }); await mkdir(work, { recursive: true });
const tgz = Buffer.from(await (await get(rt.tarball)).arrayBuffer());
const [algo, want] = rt.integrity.split("-", 2);
const got = createHash(algo).update(tgz).digest("base64");
if (got !== want) throw new Error(`${PACKAGE}@${rt.version}: tarball ${algo} mismatch — refusing it`);
await writeFile(join(work, "package.tgz"), tgz);
execFileSync("tar", ["-xzf", join(work, "package.tgz"), "-C", work]);

await rm(dir, { recursive: true, force: true }); await mkdir(dir, { recursive: true });
const files = [];
const add = async (name, buf, source) => {
  await writeFile(join(dir, name), buf);
  files.push({ name, path: `vendor/mediapipe/${release}/${name}`, bytes: buf.length, sha256: sha256(buf), source });
};
for (const f of RUNTIME_FILES)
  await add(f.split("/").pop(), await readFile(join(work, "package", f)),
            `https://www.npmjs.com/package/${PACKAGE}/v/${rt.version} (${f})`);
for (const [name, m] of Object.entries(models)) {
  const buf = Buffer.from(await (await get(m.url)).arrayBuffer());
  if (buf.length !== m.bytes) throw new Error(`${name}: got ${buf.length} bytes, expected ${m.bytes}`);
  await add(m.url.split("/").pop(), buf, m.url);
}
const license = Buffer.from(await (await get(LICENSE_URL)).arrayBuffer());
await writeFile(join(dir, "LICENSE"), license);
await writeFile(join(dir, "NOTICE.md"), `# MediaPipe — our unmodified copy

These files are copies of Google's MediaPipe, used by score.html (the trial
photo score page), unmodified, under the Apache License 2.0 (\`LICENSE\`).

| File | Source |
| :-- | :-- |
${files.map(f => `| \`${f.name}\` | ${f.source} |`).join("\n")}

- Runtime: \`${PACKAGE}\` ${rt.version} (published ${ymd(rt.published)}${rt.explicit ? "; chosen explicitly, before the usual " + MIN_AGE_DAYS + "-day minimum age" : ""}), npm licence field "${rt.license}";
  tarball verified against the registry integrity \`${rt.integrity.slice(0, 20)}…\`.
- Models: MediaPipe model cards link the Apache License 2.0 (Face Mesh V2,
  Blendshape V2, BlazeFace short- and full-range, BlazePose GHUM 3D):
  https://storage.googleapis.com/mediapipe-assets/ (model cards).
- SHA-256 of every file: \`../versions.json\`.
`);
const manifest = {
  release, generated: new Date().toISOString(), min_age_days: MIN_AGE_DAYS,
  runtime: { package: PACKAGE, version: rt.version, published: rt.published, explicit: rt.explicit, tarball: rt.tarball, integrity: rt.integrity },
  models, license: "Apache-2.0",
  total_bytes: files.reduce((n, f) => n + f.bytes, 0),
  files,
};
await writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
for (const d of await readdir(VENDOR, { withFileTypes: true }))
  if (d.isDirectory() && d.name !== release) await rm(join(VENDOR, d.name), { recursive: true, force: true });
await rm(work, { recursive: true, force: true });
console.log(`wrote ${release}: ${files.length} files, ${(manifest.total_bytes / 1e6).toFixed(1)} MB`);
