// A sample shoot, built in the browser's own private storage.
//
// Two uses: it lets anyone try the whole thing — including the renaming — without
// going near their real photos, and it gives check.html real fixtures. The badge
// images are drawn with actual text, so the on-device model has something
// genuine to read.

const DEMO_DIR = "demo-shoot";

// A canvas JPEG carries no EXIF, so one is spliced in: an APP1/Exif segment
// holding a little-endian TIFF, IFD0 -> ExifIFD -> DateTimeOriginal (0x9003).
export function withExif(jpegBuf, dateStr) {
  const tiff = new Uint8Array(64), dv = new DataView(tiff.buffer);
  tiff[0] = 0x49; tiff[1] = 0x49;                            // "II" little-endian
  dv.setUint16(2, 0x2A, true); dv.setUint32(4, 8, true);     // magic, IFD0 at 8
  dv.setUint16(8, 1, true);                                  // IFD0: one entry
  dv.setUint16(10, 0x8769, true); dv.setUint16(12, 4, true); // ExifIFD pointer, LONG
  dv.setUint32(14, 1, true); dv.setUint32(18, 26, true);     // -> ExifIFD at 26
  dv.setUint32(22, 0, true);                                 // no next IFD
  dv.setUint16(26, 1, true);                                 // ExifIFD: one entry
  dv.setUint16(28, 0x9003, true); dv.setUint16(30, 2, true); // DateTimeOriginal, ASCII
  dv.setUint32(32, 20, true); dv.setUint32(36, 44, true);    // 20 bytes at 44
  dv.setUint32(40, 0, true);
  for (let i = 0; i < 19; i++) tiff[44 + i] = dateStr.charCodeAt(i);
  const head = new TextEncoder().encode("Exif\0\0");
  const payload = new Uint8Array(head.length + tiff.length);
  payload.set(head, 0); payload.set(tiff, head.length);
  const seg = new Uint8Array(4), sv = new DataView(seg.buffer);
  sv.setUint16(0, 0xFFE1); sv.setUint16(2, payload.length + 2);
  const src = new Uint8Array(jpegBuf);
  const out = new Uint8Array(2 + seg.length + payload.length + (src.length - 2));
  out.set(src.subarray(0, 2), 0);
  out.set(seg, 2);
  out.set(payload, 2 + seg.length);
  out.set(src.subarray(2), 2 + seg.length + payload.length);
  return out;
}

const toJpeg = canvas => new Promise(r => canvas.toBlob(b => r(b.arrayBuffer()), "image/jpeg", 0.9));

function canvasOf(w, h) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return [c, c.getContext("2d")];
}

// A conference badge with real, readable text.
export async function badgeImage(name, org, event = "WikiPortraits 2026") {
  const [c, g] = canvasOf(760, 480);
  g.fillStyle = "#1f2933"; g.fillRect(0, 0, 760, 480);                 // table behind it
  g.fillStyle = "#ffffff";
  g.beginPath(); g.roundRect(70, 50, 620, 380, 18); g.fill();
  g.fillStyle = "#d7dde4";                                              // lanyard slot
  g.beginPath(); g.roundRect(330, 78, 100, 16, 8); g.fill();
  g.fillStyle = "#2b6cb0"; g.font = "600 26px -apple-system, Helvetica, Arial, sans-serif";
  g.fillText(event.toUpperCase(), 110, 150);
  g.fillStyle = "#111417"; g.font = "700 56px -apple-system, Helvetica, Arial, sans-serif";
  g.fillText(name, 110, 240);
  g.fillStyle = "#4a5560"; g.font = "400 30px -apple-system, Helvetica, Arial, sans-serif";
  g.fillText(org, 110, 300);
  g.fillStyle = "#8a949e"; g.font = "400 22px -apple-system, Helvetica, Arial, sans-serif";
  g.fillText("DELEGATE", 110, 370);
  return withExif(await toJpeg(c), arguments[3] || "2026:10:09 14:00:00");
}

// A stand-in portrait: a head and shoulders on a studio backdrop. Not a real
// face, which is the point — the grouping must not depend on recognising one.
export async function portraitImage(dateStr, hue = 212) {
  const [c, g] = canvasOf(480, 640);
  const bg = g.createLinearGradient(0, 0, 0, 640);
  bg.addColorStop(0, `hsl(${hue} 30% 72%)`); bg.addColorStop(1, `hsl(${hue} 26% 52%)`);
  g.fillStyle = bg; g.fillRect(0, 0, 480, 640);
  g.fillStyle = "rgba(255,255,255,0.92)";
  g.beginPath(); g.arc(240, 250, 96, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.moveTo(240, 370); g.bezierCurveTo(100, 370, 60, 500, 60, 640);
  g.lineTo(420, 640); g.bezierCurveTo(420, 500, 380, 370, 240, 370); g.fill();
  return withExif(await toJpeg(c), dateStr);
}

async function write(dir, name, bytes) {
  const h = await dir.getFileHandle(name, { create: true });
  const w = await h.createWritable();
  await w.write(bytes);
  await w.close();
}

// Build the sample shoot and hand back its directory handle. Shot the way the
// tool expects: a stray frame, then badge → portraits, badge → portraits.
// Files are written in reverse order so the capture-time sorting is doing real work.
export async function buildDemoShoot(root = null, onProgress = null) {
  const parent = root || await navigator.storage.getDirectory();
  // Start clean so a second run is identical to the first.
  try { await parent.removeEntry(DEMO_DIR, { recursive: true }); } catch (_) { /* first time */ }
  const dir = await parent.getDirectoryHandle(DEMO_DIR, { create: true });

  const plan = [
    ["IMG_1001.jpg", () => portraitImage("2026:10:09 13:50:00", 140)],                               // before any badge
    ["IMG_1002.jpg", () => badgeImage("Ada Lovelace", "Analytical Engines Ltd", "WikiPortraits 2026", "2026:10:09 14:00:00")],
    ["IMG_1003.jpg", () => portraitImage("2026:10:09 14:00:30", 212)],
    ["IMG_1004.jpg", () => portraitImage("2026:10:09 14:01:00", 212)],
    ["IMG_1005.jpg", () => portraitImage("2026:10:09 14:01:30", 212)],
    ["IMG_1006.jpg", () => badgeImage("Grace Hopper", "US Navy", "WikiPortraits 2026", "2026:10:09 14:05:00")],
    ["IMG_1007.jpg", () => portraitImage("2026:10:09 14:05:30", 28)],
    ["IMG_1008.jpg", () => portraitImage("2026:10:09 14:06:00", 28)],
  ];
  let n = 0;
  for (const [name, make] of [...plan].reverse()) {
    await write(dir, name, await make());
    if (onProgress) onProgress(++n, plan.length);
  }
  return dir;
}
