// The shoot: reading a folder of photos, grouping them by the badge shot that
// precedes each person, and renaming them into a "done" folder.
//
// DOM-free on purpose, so it can be driven against any FileSystemDirectoryHandle
// — including the browser's own private storage, which is how check.html tests
// the renaming and moving for real without a folder dialog.

import { captureTime } from "./exif.js";

export const DONE_DIR = "done";
const IMAGE_RE = /\.(jpe?g|png|webp|heic|heif|tiff?|avif)$/i;

// Characters no filesystem (or Windows) will take, plus trailing dots/spaces
// which Windows silently strips. Never returns an empty string.
export function safeName(s) {
  const out = String(s == null ? "" : s)
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 120);
  return out || "unnamed";
}

const extOf = name => { const m = /\.[A-Za-z0-9]+$/.exec(name || ""); return m ? m[0].toLowerCase() : ".jpg"; };

// Every image in the folder, with its capture time, sorted oldest first.
// The "done" folder is skipped so a second pass can't re-process finished work.
export async function listPhotos(dirHandle, onProgress) {
  const photos = [];
  for await (const entry of dirHandle.values()) {
    if (entry.kind !== "file" || !IMAGE_RE.test(entry.name)) continue;
    const file = await entry.getFile();
    const time = await captureTime(file);
    photos.push({ name: entry.name, handle: entry, bytes: file.size, type: file.type, time, id: null });
    if (onProgress) onProgress(photos.length, entry.name);
  }
  photos.sort((a, b) => (a.time.ms - b.time.ms) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  return photos;
}

const hasName = id => !!(id && id.kind === "identity" && id.legible !== false && (id.full_name || id.family_name));

// Group the shoot the way it was photographed: a badge (or screen) frame, then
// that person's headshots, then the next badge. An identity frame always starts
// a new group — even an unreadable one, because the photographer has moved on to
// someone else, so the frames after it must not be filed under the last person.
// Photos before the first identity frame can't be attributed and come back in
// `leading`, left alone.
export function groupPhotos(photos) {
  const groups = [];
  const leading = [];
  let current = null;
  for (const p of photos) {
    const isIdentity = p.id && p.id.kind === "identity";
    if (isIdentity) {
      current = { badge: p, person: hasName(p.id) ? { ...p.id } : null, shots: [] };
      groups.push(current);
      continue;
    }
    if (current) current.shots.push(p); else leading.push(p);
  }
  return { groups, leading };
}

// A person's filename stem. Falls back to the family name, then the raw text.
export const stemFor = person => safeName(
  (person && (person.full_name || [person.given_name, person.family_name].filter(Boolean).join(" ")))
  || "unnamed");

async function exists(dirHandle, name) {
  try { await dirHandle.getFileHandle(name); return true; }
  catch (err) { if (err.name === "NotFoundError") return false; throw err; }
}

// First free "<stem> NN<ext>", continuing past anything already in the folder so
// a second session for the same person doesn't overwrite the first.
async function freeName(destDir, stem, ext, from = 1) {
  for (let n = from; n < 1000; n++) {
    const name = `${stem} ${String(n).padStart(2, "0")}${ext}`;
    if (!(await exists(destDir, name))) return { name, next: n + 1 };
  }
  throw new Error(`no free filename for "${stem}" after 999 tries`);
}
async function freeExact(destDir, stem, suffix, ext) {
  let name = `${stem}${suffix}${ext}`;
  if (!(await exists(destDir, name))) return name;
  for (let n = 2; n < 1000; n++) {
    name = `${stem}${suffix} ${n}${ext}`;
    if (!(await exists(destDir, name))) return name;
  }
  throw new Error(`no free filename for "${stem}${suffix}"`);
}

// Move one file into destDir under a new name. Uses the native move() where it
// exists (Chrome 102+); otherwise copies, verifies the copy's size, and only
// then removes the original — so a failed write can never lose a photo.
async function moveInto(srcDir, photo, destDir, newName) {
  if (typeof photo.handle.move === "function") {
    await photo.handle.move(destDir, newName);
    return "moved";
  }
  const file = await photo.handle.getFile();
  const dest = await destDir.getFileHandle(newName, { create: true });
  const w = await dest.createWritable();
  await w.write(file);
  await w.close();
  const check = await (await destDir.getFileHandle(newName)).getFile();
  if (check.size !== file.size)
    throw new Error(`copy of ${photo.name} is ${check.size} bytes, expected ${file.size} — original kept`);
  await srcDir.removeEntry(photo.name);
  return "copied";
}

// Rename and move every named group into DONE_DIR.
//   opts.includeBadges — also move the badge frame, as "<Name> - badge.ext".
// Groups with no name, and `leading`, are never touched. Returns a per-file log;
// one failure is recorded and the rest carry on.
export async function applyGroups(dirHandle, groups, opts = {}, onProgress) {
  const { includeBadges = true } = opts;
  const destDir = await dirHandle.getDirectoryHandle(DONE_DIR, { create: true });
  const log = [];
  let done = 0;
  const total = groups.filter(g => g.person).reduce((n, g) => n + g.shots.length + (includeBadges && g.badge ? 1 : 0), 0);
  for (const g of groups) {
    if (!g.person) continue;
    const stem = stemFor(g.person);
    let next = 1;
    for (const p of g.shots) {
      const ext = extOf(p.name);
      try {
        const slot = await freeName(destDir, stem, ext, next);
        next = slot.next;
        const how = await moveInto(dirHandle, p, destDir, slot.name);
        log.push({ from: p.name, to: slot.name, person: stem, how, ok: true });
      } catch (err) {
        log.push({ from: p.name, to: null, person: stem, ok: false, error: `${err.name}: ${err.message}` });
      }
      if (onProgress) onProgress(++done, total);
    }
    if (includeBadges && g.badge) {
      const ext = extOf(g.badge.name);
      try {
        const name = await freeExact(destDir, stem, " - badge", ext);
        const how = await moveInto(dirHandle, g.badge, destDir, name);
        log.push({ from: g.badge.name, to: name, person: stem, how, ok: true, badge: true });
      } catch (err) {
        log.push({ from: g.badge.name, to: null, person: stem, ok: false, badge: true, error: `${err.name}: ${err.message}` });
      }
      if (onProgress) onProgress(++done, total);
    }
  }
  return log;
}

// One row per person for the report, with how many photos they ended up with.
export function people(groups) {
  const byStem = new Map();
  for (const g of groups) {
    if (!g.person) continue;
    const stem = stemFor(g.person);
    const row = byStem.get(stem) || { name: stem, person: g.person, shots: 0, sessions: 0 };
    row.shots += g.shots.length;
    row.sessions += 1;
    byStem.set(stem, row);
  }
  return [...byStem.values()].sort((a, b) => a.name.localeCompare(b.name));
}
