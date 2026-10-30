// Reading a person's details off a badge or a screenshot, on the device, with
// Chrome's built-in Gemini Nano (the Prompt API).
//
// Nothing is shipped by us and nothing is sent anywhere: the model belongs to
// Chrome, and its docs state "No data is sent to Google or any third party when
// using the model" (developer.chrome.com/docs/ai/get-started).
//
// Requirements, from those docs: Chrome 148+ on desktop (Windows 10/11,
// macOS 13+, Linux, Chromebook Plus) — no Firefox, no Safari, no mobile; Edge
// 138 only behind a flag; 22 GB free on the Chrome profile's volume; either
// >4 GB VRAM or 16 GB RAM with 4+ cores. The model downloads once, on first use.
// The API is not available in Web Workers, so this runs on the main thread.

// Long edge the image is scaled to before the model sees it. Badge text has to
// stay readable, so this is deliberately larger than a thumbnail.
export const ANALYSIS_EDGE = 1280;

// Output shape, forced with responseConstraint (JSON Schema, Chrome 137+), so
// the answer is parseable rather than prose. Empty string = not readable.
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "full_name", "given_name", "family_name", "organisation", "legible"],
  properties: {
    kind: { type: "string", enum: ["identity", "portrait", "other"] },
    full_name: { type: "string" },
    given_name: { type: "string" },
    family_name: { type: "string" },
    organisation: { type: "string" },
    legible: { type: "boolean" },
  },
};

const PROMPT = [
  "Look at this photograph and decide which of three things it is.",
  "",
  '"identity" — it shows a person\'s WRITTEN name: a conference badge, lanyard, ID card,',
  "name card, delegate list, printed sheet, or a phone or computer screen showing their details.",
  '"portrait" — it is a photograph OF a person, with no written name to read.',
  '"other" — anything else.',
  "",
  "If it is \"identity\", copy the person's name exactly as printed, keeping accents and",
  "capitalisation. Put the first name in given_name and the last name in family_name, and the",
  "whole name as printed in full_name. Put any company, publication or affiliation in",
  "organisation. Ignore event names, job titles, sponsors and slogans — only the person.",
  "Leave a field as an empty string if it is not shown. Set legible to false if the writing is",
  "too blurred or cut off to read with confidence.",
].join("\n");

// Is the API present at all (so the UI can explain rather than fail silently)?
export const nanoPresent = () => typeof self !== "undefined" && "LanguageModel" in self;

// "unavailable" | "downloadable" | "downloading" | "available", or an error string.
export async function nanoAvailability() {
  if (!nanoPresent()) return "absent";
  try {
    return await LanguageModel.availability({ expectedInputs: [{ type: "image" }] });
  } catch (err) {
    return `error: ${err.name}: ${err.message}`;
  }
}

// One session, reused for every photo in a scan. `onProgress(fraction)` reports
// the model download, which happens only on a machine that doesn't have it yet.
// Must be called from a user gesture when the model still needs downloading.
export async function createSession(onProgress) {
  if (!nanoPresent()) throw new Error("This browser has no built-in model (needs Chrome 148+ on desktop).");
  const availability = await nanoAvailability();
  if (availability === "unavailable")
    throw new Error("Chrome reports the built-in model as unavailable on this device — see the requirements in About.");
  return LanguageModel.create({
    expectedInputs: [{ type: "image" }],
    monitor: m => m.addEventListener("downloadprogress", e => onProgress && onProgress(e.loaded)),
  });
}

// Scale an image to ANALYSIS_EDGE on its long edge. The model accepts a canvas
// directly, so there is no encode/decode round trip.
export async function forModel(blob, edge = ANALYSIS_EDGE) {
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, edge / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  canvas.getContext("2d", { alpha: false }).drawImage(bmp, 0, 0, w, h);
  bmp.close();
  return canvas;
}

const clean = s => String(s == null ? "" : s).replace(/\s+/g, " ").trim();

// Ask the model about one image. Returns the parsed record, or
// { kind: "unreadable", error } when the model refused or answered unparseably —
// never a throw, so one odd frame can't stop a whole shoot.
export async function identify(session, imageSource) {
  try {
    const answer = await session.prompt(
      [{ role: "user", content: [{ type: "text", value: PROMPT }, { type: "image", value: imageSource }] }],
      { responseConstraint: SCHEMA });
    let r;
    try { r = JSON.parse(answer); }
    catch (_) { return { kind: "unreadable", error: "model did not return JSON", raw: String(answer).slice(0, 200) }; }
    const full = clean(r.full_name);
    const given = clean(r.given_name), family = clean(r.family_name);
    return {
      kind: ["identity", "portrait", "other"].includes(r.kind) ? r.kind : "other",
      full_name: full || [given, family].filter(Boolean).join(" "),
      given_name: given,
      family_name: family,
      organisation: clean(r.organisation),
      legible: r.legible !== false,
    };
  } catch (err) {
    return { kind: "unreadable", error: `${err.name}: ${err.message}` };
  }
}
