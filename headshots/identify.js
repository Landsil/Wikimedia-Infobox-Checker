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
  required: ["text_seen", "kind", "full_name", "given_name", "family_name", "organisation", "legible"],
  properties: {
    kind: { type: "string", enum: ["identity", "portrait", "other"] },
    text_seen: { type: "string" },
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
  '"identity" — the SUBJECT of the photograph is a person\'s written name: a close-up of a',
  "conference badge, lanyard, ID card, name card, delegate list, printed sheet, or a phone or",
  "computer screen showing their details. The writing is what the photograph is of.",
  '"portrait" — it is a photograph OF a person.',
  '"other" — anything else.',
  "",
  "Most photographs at an event are portraits, and nearly all of them have writing somewhere:",
  "sponsor backdrops, step-and-repeat banners, signage, logos, lanyards worn around a neck,",
  "badges pinned to clothing. None of that makes a photograph an \"identity\" — a portrait with",
  "a banner behind it, or a visible badge being worn, is still a \"portrait\". Choose \"identity\"",
  "only when someone has deliberately photographed the writing in order to record a name.",
  "",
  "If it is \"identity\", copy the person's name exactly as printed, keeping accents and",
  "capitalisation. Put the first name in given_name and the last name in family_name, and the",
  "whole name as printed in full_name. Put any company, publication or affiliation in",
  "organisation. Ignore event names, job titles, sponsors and slogans — only the person.",
  "Leave a field as an empty string if it is not shown. Set legible to false if the writing is",
  "too blurred or cut off to read with confidence.",
  "",
  "Fill in text_seen FIRST: transcribe every word you can actually read in the image,",
  "verbatim, before you fill in any other field. Then take the name only from what you just",
  "transcribed. Do not add anything that is not written there, and never guess a name from the",
  "person's appearance: if no name is written, leave the name fields empty and set legible to",
  "false. text_seen must never be empty when there is any writing at all in the image.",
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

// Trigger Chrome's one-time model download without doing any work with it, so a
// machine can be set up before a shoot instead of stalling in the middle of one.
// Must be called from a user gesture. Resolves to the availability afterwards.
export async function downloadModel(onProgress) {
  if (!nanoPresent()) throw new Error("This browser has no built-in model (needs Chrome 148+ on desktop).");
  const before = await nanoAvailability();
  if (before === "unavailable")
    throw new Error("Chrome reports the built-in model as unavailable on this device — see the requirements in About.");
  const session = await LanguageModel.create({
    expectedInputs: [{ type: "image" }],
    monitor: m => m.addEventListener("downloadprogress", e => onProgress && onProgress(e.loaded)),
  });
  session.destroy();                      // the download is what we wanted, not the session
  return nanoAvailability();
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

// Accent- and punctuation-insensitive, for checking a name against a transcription.
const flatten = s => String(s == null ? "" : s).normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Is the name the model gave actually present in the text it says it read?
// A model asked to read a name will sometimes supply a famous one instead — on a
// test programme it returned "Matthew McConaughey", "Jamie Foxx" and "Mark
// Kermode" for people who were not there. Requiring every part of the name to
// appear in its own transcription catches that in code rather than trusting the
// answer.
//
// "no" and "cannot tell" are kept apart on purpose. An empty transcription is no
// evidence either way, and reporting that as an invented name once hid a reading
// of "Adam Pearson" that was in fact correct.
function nameSupport(name, textSeen) {
  const hay = flatten(textSeen);
  if (!hay) return "unverified";
  const parts = flatten(name).split(" ").filter(w => w.length >= 2);
  return parts.length > 0 && parts.every(w => hay.includes(w)) ? "ok" : "invented";
}

// Reading the caption printed with a portrait in a programme or delegate list.
// A different job from a badge: the face is already located, and the name sits
// near it among other text, so the model is told where to look.
const CAPTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["text_seen", "full_name", "given_name", "family_name", "organisation", "legible"],
  properties: {
    text_seen: { type: "string" },
    full_name: { type: "string" },
    given_name: { type: "string" },
    family_name: { type: "string" },
    organisation: { type: "string" },
    legible: { type: "boolean" },
  },
};
const CAPTION_PROMPT = [
  "This is a cut-out from a printed programme, delegate list or web page. It shows one",
  "person's photograph with their name printed beside or beneath it.",
  "",
  "Read that person's name exactly as printed, keeping accents and capitalisation. Put the",
  "first name in given_name, the last name in family_name, and the whole name as printed in",
  "full_name. Put any company, publication, role or affiliation in organisation.",
  "",
  "The name belongs to the person in the photograph — ignore event names, venue names,",
  "session titles, sponsors, page headings and any other person's name. Leave a field as an",
  "empty string if it is not shown, and set legible to false if there is no readable name",
  "for this person or you cannot tell which name is theirs.",
  "",
  "Fill in text_seen FIRST: transcribe every word you can actually read in the cut-out,",
  "verbatim, before you fill in any other field. Then take the name only from what you just",
  "transcribed. Do not add anything that is not written there, and never guess a name from the",
  "person's appearance: if no name is printed, leave the name fields empty and set legible to",
  "false. text_seen must never be empty when there is any writing at all in the cut-out.",
].join("\n");

// Read the name printed with one portrait. Same contract as identify(): never
// throws, so one bad cut-out cannot stop a whole document.
export async function readCaption(session, imageSource) {
  try {
    const answer = await session.prompt(
      [{ role: "user", content: [{ type: "text", value: CAPTION_PROMPT }, { type: "image", value: imageSource }] }],
      { responseConstraint: CAPTION_SCHEMA });
    let r;
    try { r = JSON.parse(answer); }
    catch (_) { return { legible: false, error: "model did not return JSON", raw: String(answer).slice(0, 200) }; }
    const given = clean(r.given_name), family = clean(r.family_name);
    const name = clean(r.full_name) || [given, family].filter(Boolean).join(" ");
    const textSeen = clean(r.text_seen);
    const support = name ? nameSupport(name, textSeen) : "ok";
    const ok = support === "ok";
    return {
      full_name: ok ? name : "",
      given_name: ok ? given : "",
      family_name: ok ? family : "",
      organisation: clean(r.organisation),
      text_seen: textSeen,
      legible: ok && r.legible !== false,
      ...(ok ? {} : { rejected: support === "invented"
        ? `"${name}" is not in the text the model read`
        : `"${name}" could not be checked — the model read back no text` }),
    };
  } catch (err) {
    return { legible: false, error: `${err.name}: ${err.message}` };
  }
}

// Choosing which of a known set of names belongs to a face.
//
// This is the only way the model is allowed near a document's names. It is given
// the names already taken verbatim from the page and must answer with one of
// them, or with "" for nobody: the schema's enum makes any other answer
// unrepresentable, so the invention that made free-text reading useless cannot
// happen here. The model is doing what it is actually good at — deciding which
// caption goes with which face — while the strings stay the document's.
const PICK_PROMPT = [
  "This is a cut-out from a printed programme, delegate list or web page. It shows one or",
  "more photographs together with some printed text. Exactly one face is outlined in a",
  "bright pink rectangle.",
  "",
  "You are given the names printed on this page. Decide which one belongs to the person",
  "whose face is inside the pink rectangle — normally the name printed directly beneath or",
  "beside their photograph. Ignore every other face in the cut-out.",
  "",
  "Answer with that name exactly as it appears in the list. If the name of the outlined",
  "person is not in the list, or you cannot tell which of the names is theirs, answer with an",
  "empty string. Do not pick a name just because it is nearby, and never pick one because you",
  "recognise the person — only the name printed with this photograph counts.",
].join("\n");

export async function pickName(session, imageSource, candidates) {
  const list = [...new Set(candidates.map(clean).filter(Boolean))];
  if (!list.length) return { name: "", reason: "no names on the page" };
  try {
    const answer = await session.prompt(
      [{ role: "user", content: [
        { type: "text", value: `${PICK_PROMPT}\n\nNames printed on this page:\n${list.map(n => `- ${n}`).join("\n")}` },
        { type: "image", value: imageSource }] }],
      { responseConstraint: {
          type: "object", additionalProperties: false, required: ["name"],
          properties: { name: { type: "string", enum: [...list, ""] } } } });
    let r;
    try { r = JSON.parse(answer); }
    catch (_) { return { name: "", error: "model did not return JSON" }; }
    const name = clean(r.name);
    // Belt and braces: the enum should make this impossible, but a name that is
    // not on the list is dropped rather than trusted.
    return list.includes(name) ? { name } : { name: "", reason: "answer was not one of the printed names" };
  } catch (err) {
    return { name: "", error: `${err.name}: ${err.message}` };
  }
}

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
    const given = clean(r.given_name), family = clean(r.family_name);
    const name = clean(r.full_name) || [given, family].filter(Boolean).join(" ");
    const textSeen = clean(r.text_seen);
    const support = name ? nameSupport(name, textSeen) : "ok";
    const ok = support === "ok";
    let kind = ["identity", "portrait", "other"].includes(r.kind) ? r.kind : "other";
    // A badge claim has to be backed by a name actually read off the frame.
    //
    // The model's answer alone was trusted here, and on a real shoot it called
    // almost every photograph an identity frame — unsurprisingly, since event
    // portraits nearly all have writing in them (backdrops, signage, worn
    // lanyards). Every false badge starts a new person, so the grouping
    // collapsed into one person per photograph.
    //
    // A frame whose subject really is someone's name yields that name. One that
    // does not is a portrait, and said so below for anyone who wants to overrule
    // it by hand. This gives up the old behaviour where an unreadable badge still
    // started a person; a change of face now covers that, and it is the far
    // cheaper mistake of the two.
    const unnamed = kind === "identity" && !(ok && name);
    if (unnamed) kind = "portrait";
    return {
      kind,
      full_name: ok ? name : "",
      given_name: ok ? given : "",
      family_name: ok ? family : "",
      organisation: clean(r.organisation),
      text_seen: textSeen,
      legible: ok && r.legible !== false,
      ...(unnamed ? { calledIdentity: true } : {}),
      ...(ok ? {} : { rejected: support === "invented"
        ? `"${name}" is not in the text the model read`
        : `"${name}" could not be checked — the model read back no text` }),
    };
  } catch (err) {
    return { kind: "unreadable", error: `${err.name}: ${err.message}` };
  }
}
