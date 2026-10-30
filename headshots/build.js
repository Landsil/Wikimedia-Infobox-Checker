// Which build the browser actually has.
//
// Bumped with every change that reaches a browser. It exists because a stale
// service-worker cache once served the previous build after a deploy, and the
// resulting "nothing has changed" was indistinguishable from a fix that had not
// worked. Now the page says, so it never has to be inferred from how it looks.
export const BUILD = "2026-10-30.6";
