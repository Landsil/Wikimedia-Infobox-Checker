# pdf.js — our unmodified copy

Copies of Mozilla's pdf.js, used by the Headshots tool to render a PDF's pages
to images, unmodified, under the Apache License 2.0 (`LICENSE`).

| File | Source |
| :-- | :-- |
| `pdf.min.mjs` | https://www.npmjs.com/package/pdfjs-dist/v/6.4.299 (build/pdf.min.mjs) |
| `pdf.worker.min.mjs` | https://www.npmjs.com/package/pdfjs-dist/v/6.4.299 (build/pdf.worker.min.mjs) |

- `pdfjs-dist` 6.4.299 (published 2026-10-03; chosen explicitly, before the usual 14-day minimum age),
  npm licence field "Apache-2.0"; tarball verified against the
  registry integrity `sha512-AVl138zALtfaA…`.
- Only the two minified ESM builds are vendored. The optional `standard_fonts`,
  `cmaps` and `wasm` assets are not, so a PDF that needs them is reported rather
  than rendered with substituted fonts.
- SHA-256 of every file: `../versions.json`.
