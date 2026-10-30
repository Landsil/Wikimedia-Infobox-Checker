// Keeps our copy of Mozilla's pdf.js in vendor/pdfjs/, for the Headshots tool's
// "add a document" step (rendering a programme or delegate list to images).
//
//   node scripts/sync-pdfjs.mjs            # report current vs upstream
//   node scripts/sync-pdfjs.mjs --sync     # take a newer release if there is one
//   node scripts/sync-pdfjs.mjs --sync --version 6.4.299
//
// Same rules as the MediaPipe sync: only versions at least MIN_AGE_DAYS old, the
// npm tarball verified against the registry's integrity hash before anything is
// used, never automatically backwards, and the result goes to a branch for
// review rather than straight onto main.
//
// Only the two minified ESM builds are taken (1.65 MB). The optional
// standard_fonts, cmaps and wasm directories are not: a PDF needing them is
// reported to the user, who can export its pages as images instead.

import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR = join(ROOT, "vendor", "pdfjs");
const MANIFEST = join(VENDOR, "versions.json");
const MIN_AGE_DAYS = 14;
const PACKAGE = "pdfjs-dist";
const WANT = [["build/pdf.min.mjs", "pdf.min.mjs"], ["build/pdf.worker.min.mjs", "pdf.worker.min.mjs"]];
const LICENSE_URL = "https://www.apache.org/licenses/LICENSE-2.0.txt";
const UA = "WikimediaInfoboxChecker-sync/1.0 (https://github.com/Landsil/Wikimedia-Infobox-Checker)";

const sync = process.argv.includes("--sync");
const vi = process.argv.indexOf("--version");
const wanted = vi > 0 ? process.argv[vi + 1] : (process.env.WANTED_VERSION || "").trim() || null;
if (wanted && !/^\d+\.\d+\.\d+$/.test(wanted)) throw new Error(`--version must be x.y.z, not "${wanted}"`);

const day = 86400000;
const sha256 = buf => createHash("sha256").update(buf).digest("hex");
const ymd = d => new Date(d).toISOString().slice(0, 10);
const cmpVer = (a, b) => {
  const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
};
async function get(url, init) {
  const r = await fetch(url, { headers: { "User-Agent": UA }, ...(init || {}) });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r;
}

const meta = await (await get(`https://registry.npmjs.org/${PACKAGE}`)).json();
const stable = Object.keys(meta.versions).filter(v => /^\d+\.\d+\.\d+$/.test(v))
  .sort((a, b) => Date.parse(meta.time[a]) - Date.parse(meta.time[b]));
if (wanted && !stable.includes(wanted)) throw new Error(`${PACKAGE}@${wanted} does not exist`);
const cutoff = Date.now() - MIN_AGE_DAYS * day;
const eligible = stable.filter(v => Date.parse(meta.time[v]) <= cutoff);
const version = wanted || eligible.at(-1);
const newest = stable.at(-1);

const current = existsSync(MANIFEST) ? JSON.parse(await readFile(MANIFEST, "utf8")) : null;
console.log(`current: ${current ? current.version : "(none)"}`);
console.log(`upstream: ${version}${wanted ? " — requested explicitly, minimum age skipped" : ""}`
  + ` (published ${ymd(meta.time[version])}; newest upstream ${newest}, ${ymd(meta.time[newest])})`);

const forward = !current || cmpVer(version, current.version) > 0;
const changed = wanted ? (!current || current.version !== version) : forward;
if (changed) console.log(`→ a newer release is available${wanted ? " (requested)" : ""}`);
else if (current && cmpVer(version, current.version) < 0)
  console.log(`→ staying on ${current.version}: the newest release old enough to vet is ${version}, which is older`);
else console.log("→ up to date");
if (process.env.GITHUB_OUTPUT) await writeFile(process.env.GITHUB_OUTPUT,
  `changed=${changed && sync ? 1 : 0}\nversion=${version}\nprevious=${current ? current.version : ""}\n`, { flag: "a" });
if (!sync || !changed) process.exit(0);

// ---- download, verify, write ----
const dist = meta.versions[version].dist;
const tgz = Buffer.from(await (await get(dist.tarball)).arrayBuffer());
const [algo, want] = dist.integrity.split("-", 2);
if (createHash(algo).update(tgz).digest("base64") !== want)
  throw new Error(`${PACKAGE}@${version}: tarball ${algo} mismatch — refusing it`);

const work = join(tmpdir(), `pdfjs-${version}`);
await rm(work, { recursive: true, force: true });
await mkdir(work, { recursive: true });
await writeFile(join(work, "p.tgz"), tgz);
execFileSync("tar", ["-xzf", join(work, "p.tgz"), "-C", work]);

const dir = join(VENDOR, version);
await rm(dir, { recursive: true, force: true });
await mkdir(dir, { recursive: true });
const files = [];
for (const [from, name] of WANT) {
  const buf = await readFile(join(work, "package", from));
  await writeFile(join(dir, name), buf);
  files.push({ name, path: `vendor/pdfjs/${version}/${name}`, bytes: buf.length, sha256: sha256(buf),
               source: `https://www.npmjs.com/package/${PACKAGE}/v/${version} (${from})` });
}
await writeFile(join(dir, "LICENSE"), Buffer.from(await (await get(LICENSE_URL)).arrayBuffer()));
await writeFile(join(dir, "NOTICE.md"), `# pdf.js — our unmodified copy

Copies of Mozilla's pdf.js, used by the Headshots tool to render a PDF's pages
to images, unmodified, under the Apache License 2.0 (\`LICENSE\`).

| File | Source |
| :-- | :-- |
${files.map(f => `| \`${f.name}\` | ${f.source} |`).join("\n")}

- \`${PACKAGE}\` ${version} (published ${ymd(meta.time[version])}${wanted ? "; chosen explicitly, before the usual " + MIN_AGE_DAYS + "-day minimum age" : ""}),
  npm licence field "${meta.versions[version].license}"; tarball verified against the
  registry integrity \`${dist.integrity.slice(0, 20)}…\`.
- Only the two minified ESM builds are vendored. The optional \`standard_fonts\`,
  \`cmaps\` and \`wasm\` assets are not, so a PDF that needs them is reported rather
  than rendered with substituted fonts.
- SHA-256 of every file: \`../versions.json\`.
`);
await writeFile(MANIFEST, JSON.stringify({
  package: PACKAGE, version, published: meta.time[version], explicit: !!wanted,
  tarball: dist.tarball, integrity: dist.integrity, license: meta.versions[version].license,
  generated: new Date().toISOString(), min_age_days: MIN_AGE_DAYS,
  total_bytes: files.reduce((n, f) => n + f.bytes, 0), files,
}, null, 2) + "\n");
for (const d of await readdir(VENDOR, { withFileTypes: true }))
  if (d.isDirectory() && d.name !== version) await rm(join(VENDOR, d.name), { recursive: true, force: true });
await rm(work, { recursive: true, force: true });
console.log(`wrote ${version}: ${files.length} files, ${(files.reduce((n, f) => n + f.bytes, 0) / 1e6).toFixed(2)} MB`);
