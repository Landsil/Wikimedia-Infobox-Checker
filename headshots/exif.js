// Capture time of a photo — DOM-free, no dependencies.
//
// Walks JPEG segments to the APP1/Exif block, then the TIFF IFD0 and ExifIFD,
// for DateTimeOriginal (0x9003), OffsetTimeOriginal (0x9011) and DateTime
// (0x0132). EXIF holds wall-clock time with no timezone unless 0x9011 is
// present, so the string is kept as local time and never shifted — a shoot is
// ordered by the camera's own clock, which is all the matching needs.

// "2026:10:09 14:00:00" -> "2026-10-09T14:00:00"; null if unparseable.
function isoLocal(raw) {
  const m = /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(raw || "").trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}` : null;
}

// EXIF dates out of a JPEG's bytes, or null when there is no Exif block.
// Returns { local, offset, raw } — `local` is an ISO-like local timestamp.
export function exifDate(buf) {
  const d = new DataView(buf);
  if (d.byteLength < 4 || d.getUint16(0) !== 0xFFD8) return null;        // not a JPEG
  let p = 2;
  while (p < d.byteLength - 4) {
    if (d.getUint8(p) !== 0xFF) { p++; continue; }                        // resync on padding
    const marker = d.getUint8(p + 1), len = d.getUint16(p + 2);
    if (marker === 0xD9 || marker === 0xDA) break;                        // end of header / start of scan
    if (marker === 0xE1 && d.byteLength > p + 10 && d.getUint32(p + 4) === 0x45786966) {   // "Exif"
      const tiff = p + 10;
      const le = d.getUint16(tiff) === 0x4949;                            // "II" = little-endian
      const u16 = o => d.getUint16(o, le), u32 = o => d.getUint32(o, le);
      const found = {};
      const seen = new Set();
      const readIFD = off => {
        if (off < tiff || off + 2 > d.byteLength || seen.has(off)) return;  // malformed / looping
        seen.add(off);
        const n = u16(off);
        for (let i = 0; i < n; i++) {
          const e = off + 2 + i * 12;
          if (e + 12 > d.byteLength) return;
          const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
          if (tag === 0x8769) { readIFD(tiff + u32(e + 8)); continue; }     // ExifIFD pointer
          if (type !== 2 || ![0x9003, 0x9011, 0x0132].includes(tag)) continue;
          // ASCII values longer than 4 bytes live at an offset, shorter ones inline.
          const at = count > 4 ? tiff + u32(e + 8) : e + 8;
          if (at + count > d.byteLength) continue;
          let s = "";
          for (let k = 0; k < count; k++) {
            const c = d.getUint8(at + k);
            if (c === 0) break;
            s += String.fromCharCode(c);
          }
          found[tag] = s.trim();
        }
      };
      if (tiff + 8 > d.byteLength) return null;
      readIFD(tiff + u32(tiff + 4));
      const raw = found[0x9003] || found[0x0132] || "";
      if (!raw) return null;
      return { local: isoLocal(raw), offset: found[0x9011] || null, raw };
    }
    if (len < 2) break;                                                   // corrupt segment length
    p += 2 + len;
  }
  return null;
}

// Best capture time for a File: EXIF when present, else the file's own
// modification time (screenshots and PNGs carry no EXIF). `source` says which,
// so the UI can be honest about where the time came from.
export async function captureTime(file) {
  if (/\.jpe?g$/i.test(file.name) || file.type === "image/jpeg") {
    try {
      // The Exif block sits in the first few KB; reading a slice keeps big
      // files off the heap when a shoot holds hundreds of 30 MP photos.
      const head = await file.slice(0, 256 * 1024).arrayBuffer();
      const e = exifDate(head);
      if (e && e.local) return { local: e.local, ms: Date.parse(e.local) || 0, source: "EXIF", raw: e.raw };
    } catch (_) { /* fall through to the file's own time */ }
  }
  const d = new Date(file.lastModified);
  return { local: isNaN(d) ? null : d.toISOString().slice(0, 19), ms: file.lastModified || 0,
           source: "file date", raw: null };
}
