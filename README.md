# Wikimedia-Infobox-Checker

A small **static, browser-only** site of tools for finding and improving photos
on Wikipedia and Wikimedia Commons. No server, no build step — every page calls
the Wikimedia APIs directly from the browser with `fetch()` + `&origin=*`
(anonymous CORS).

> This README is the developer-facing document: how it's built, which APIs it
> calls, and where the gotchas are. Each tool's in-page **About** covers the same
> ground for someone who just wants to use it.


## Try it

**Website (no install):** https://mb-malta.co.uk/Wikimedia-Infobox-Checker/

<img width="1153" height="1194" alt="Screenshot 2026-07-31 at 13 31 01" src="https://github.com/user-attachments/assets/38f24aae-7237-44e2-b17c-fba63feea376" />


## Structure

A landing hub links to self-contained tool pages; all share one stylesheet.

| File | What |
| :-- | :-- |
| `index.html` | Landing hub — links to the tools |
| `finder.html` | **Infobox Finder** — Commons category → unused photos depicting people, compared to the current infobox photo |
| `gaps.html` | **Photo Gaps** — Wikipedia category → living people whose article has a missing/poor infobox photo; or one person (article / file) → every Commons photo depicting them |
| `history.html` | **Infobox History** — a photo, article or Commons category → current infobox photo plus the ones it replaced |
| `history-core.js` | The Infobox History pipeline (DOM-free ES module), shared by `history.html` and the background job |
| `scripts/refresh-history.mjs` | Background job: keeps the saved Infobox History records up to date |
| `.github/workflows/refresh-history.yml` | Runs that job weekly and monthly on GitHub Actions |
| `data/history/` | Saved Infobox History records (JSON), written only by the background job |
| `package.json` | No dependencies — only `"type": "module"` so Node loads `history-core.js` |
| `wikiportraits.js` | WikiPortraits photographer badge, shared by `finder.html` and `history.html` (classic script) |
| `style.css` | Shared styles for all pages |

`finder.html` and `gaps.html` embed their own JS pipeline, so each is
independently openable. `history.html` imports `history-core.js` as an ES
module, which browsers refuse to load from `file://` — to try it locally, serve
the folder (`python3 -m http.server`) and open `http://localhost:8000/history.html`.
Deployed on GitHub Pages from `main` /root.

Everything is client-side. That has one consequence worth knowing: **browsers
forbid setting `User-Agent`**, so requests go out with the browser's UA plus
`&origin=*` rather than a descriptive tool UA. (An earlier local Python server,
`app.py`, sent a proper UA; it was retired once the browser build covered
everything.)


## Infobox Finder — usage

Enter a Commons category, pick an upload-date window, hit **Search Candidates**.

- **Category** — with or without the `Category:` prefix. `normalize_category()`
  accepts spaces, underscores, `+` and `%20` in any casing and canonicalises to
  `Category:Name` (MediaWiki treats spaces and underscores as equivalent).
- **Start / End** — filters by **upload timestamp**. Defaults to the last three
  months (1st of the month two months back → end of the current month).
  **Previous month** / **This month** / **This year** prefill other ranges.
  Dates are formatted from local date parts, not `toISOString()`, which would
  roll the day back under timezones ahead of UTC (e.g. BST).
- **Subcategory depth** — how far down the tree to look: `0` = only this
  category, `1` = also its subcategories, `2` (default) = also theirs; up to
  `MAX_DEPTH` = 5. Each category is read once and a file in several counts once.
  At most `MAX_TREE_FILES` = 10,000 files are read; the status line says
  "Stopped after 10,000 files" when a search hits that, and "(Searched N
  categories.)" otherwise.

### URL parameters

The form can be prefilled from the query string, so searches are shareable:

```
?category=WikiPortraits_photos_by_John_Manard
?category=Photographs+by+Mateusz+Malta&start=2026-05-01&end=2026-07-31&search=1
?category=WikiPortraits+photos+of+animals&depth=1&search=1
```

- `category` — underscores/`+` become spaces. A `Category:` prefix is fine.
- `start`, `end` — `YYYY-MM-DD`; ignored (falling back to the default) if malformed.
- `depth` — subcategory depth (0–5); default 2. *Copy static URL* includes it.
- `search=1` — runs the search immediately on load.

### Filter toggles (appear after a search)

The search runs **once**; the toggles filter the already-fetched results
client-side, so switching is instant and costs no API calls.

| Toggle | Default | Effect |
| :-- | :-- | :-- |
| Hide same-author candidates | on | Hides a candidate when the current infobox photo is by the same author **and** is already good, or is a **crop of that candidate** |
| Hide when current photo is good | on | Hides a match when the infobox photo is already good, whoever took it |
| Show no-depicts photos | off | **Exclusive view**: only unused photos with no `P180` |
| Show category photos already in use | off | **Exclusive view**: only category photos that *are* an article's current infobox photo. One row per photo, listing every article it is live on |

The two exclusive views replace the comparison results and disable the other
toggles (and each other). Author matching prefers the Commons **user-page URL**
over the display name, because display names differ from usernames.

### Crops count as the same photo

Commons crops are conventionally named `<original> (cropped).jpg` (also
`(cropped 2)`, `(head crop)`, …). `cropParent()` derives the parent filename, so
when an article's infobox photo is a crop of the candidate the tool treats it as
**the same photo, already in use** — redundant regardless of the crop's
resolution, since a tight crop can fall under the low-res bar and would otherwise
show up as "replace this" against your own adopted photo.

Commons records the relationship structurally too, via `{{Extracted from}}` in
the crop's wikitext (and `{{Image extracted}}` on the original). That is
authoritative, but wikitext is not batchable — one `action=parse` per file — so
the naming convention is used instead, for free. It matches `(cropped)`,
`(cropped 2)`, `(head crop)` and case variants, and deliberately does not match
`(retouched)`, `(1930s)`, `(portrait)`, or a `(cropped)` that isn't the final
qualifier.

Apart from the crop case above, "hide same-author" is a strict subset of "hide
when current photo is good" — it only fires when the current photo is good. Its
value is letting you hide *your own* redundant duplicates while keeping good
photos by *other* photographers visible: turn the second toggle off, the first on.

### Other Wikipedias and the Wikidata image

The comparison uses **one** article per person (`pickWikipediaSitelink`: English
if it exists, else the first Wikipedia). The person's Wikidata entity — already
fetched for the human check — also lists every Wikipedia article (sitelinks) and
the Wikidata image (`P18`), so each candidate shows, for free:

- **Wikidata image (P18)** — or "none set" (red). Many Wikipedias' infobox
  templates take the photo from P18, so a missing P18 can leave several without
  one (which ones do is per wiki; not checked).
- **Other Wikipedias** — the count of other-language articles.

**Check other Wikipedias** (toggle, off) looks up `pageimages` for all those
articles, one batched request per Wikipedia (≤ 50 titles each, `pilicense=any`),
so a search can mean ~150 requests (measured 2026-10-14: 50 people → 918 articles
on 150 Wikipedias → 151 requests). It then lists the languages with no photo,
each linking to that article's editor, and enables **Only missing a photo on
another Wikipedia**. Results are kept until the next search; switching the
toggle off only hides them.

Site ids map to hosts by dropping `wiki` and `_` → `-` — except `be_x_oldwiki`,
which is `be-tarask.wikipedia.org` (the only mismatch among the 364 Wikipedias in
Meta's `action=sitematrix`, 2026-10-15; the old `be-x-old` host redirects without
CORS headers, so browser calls to it fail). `SITE_HOST_EXCEPTIONS` in
`finder.html` and `history-core.js`.

### What "good" means

Present, **not stale**, **not low-res**, *and* resolution known:

- **Stale** — taken (falling back to upload date) more than `STALE_MONTHS` = **12**
  months ago.
- **Low-res** — under `LOW_RES_MP` = **2** megapixels.
- **Unknown resolution counts as not good**, so a candidate is never hidden on
  the strength of a photo we can't vouch for.

Stale dates and low resolutions render in red with a ⚠.

### Row buttons

- **Copy** — copies the bare filename (no `File:` prefix) for pasting into an
  infobox `|image=` field. Needs a secure context (`https:` or `localhost`);
  falls back to `execCommand` otherwise.
- **Edit** — the article URL with `?action=edit`.
- **Find previous photo by a different author** — on the already-in-use view;
  see below.


## Infobox Finder pipeline (`finder.html`)

`runSearch()` in order. Each step feeds the next a shrinking set.

| # | Step | API | Batching |
| :-- | :-- | :-- | :-- |
| 1 | `fetchCategoryFiles` | Commons `generator=categorymembers` + `prop=imageinfo` per category; `list=categorymembers&cmtype=subcat` for the next level | paged via `continue`, `gcmlimit=max`; level by level to the chosen depth, capped at `MAX_TREE_FILES` |
| 2 | `filter_unused` | Commons `prop=globalusage` (`guprop=namespace\|url`) | 50 titles/call |
| 3 | `find_current_photos` | per-wiki `prop=pageimages` | 50 titles/call |
| 4 | `attach_depicts` | Commons `wbgetentities` on `M`-ids | 50 ids/call |
| 5 | `fetch_person_data` | Wikidata `wbgetentities` + `pageimages` + Commons `imageinfo` | 50/call |
| 6 | — | shape and sort results | — |

**Dates filter after fetching, not before.** `categorymembers` has no
upload-date parameter — `cmstart`/`cmend` filter on *when the file was added to
the category*, which is not the same as upload date. So step 1 always pages the
whole category and the date window is applied client-side. The window still cuts
steps 2–5 proportionally, which is where the fan-out cost is.

### Key implementation details

- **Depicts → person.** `P180` points at the *specific* entity, not the class, so
  filtering for humans means a second lookup: each depicted Q-id's `P31`
  (instance of) must include `Q5`. All depicted entities are collected (a photo
  can depict a company *and* a person) and files with no human depict are dropped.
  Without this, non-person subjects (e.g. a Waymo vehicle) match.
- **Commons SDC nests claims under `statements`, not `claims`.** Wikidata items
  use `claims`; Commons MediaInfo entities use `statements`. Reading the wrong key
  silently yields zero depicts for everything.
- **"Unused" means unused in an article.** `globalusage` reports user pages,
  talk pages and galleries too, so only namespace `0` usages count.
- **The infobox photo is what the article displays**, via `pageimages` — *not*
  Wikidata `P18`, which frequently diverges (an article can show a 2026 photo
  while `P18` still points at a 2018 one). `P18` is only a fallback when the
  article has no resolvable lead image. `pageimages` returns names with
  underscores; Commons titles use spaces, so they must be normalised to match.
- **Non-Wikipedia projects leak in.** `globalusage` also reports Wikiquote,
  Wikisource etc.; `wikipedia_site_from_host()` filters to Wikipedia only.
- **A photo can be live on several wikis**, so the already-in-use view emits one
  row per *(file, article)* — each wiki has its own edit history.

### Previous-photo lookup

Each row groups by **photo**, not by article: the same photo is often the lead
image on several language Wikipedias, so all of them are listed with short
language codes (`EN`, `CA`, `BG`, …) and their own Edit links. Because each wiki
has its own history, the right-hand side offers an **All wikis** button plus one
button per wiki; results are appended, each labelled with its language code.

The lookup walks the article's revision history **on click** (it's the expensive
call, so it stays out of the main search):

1. `prop=revisions` with `rvprop=content&rvslots=main`, `rvdir=older`,
   `HISTORY_REV_LIMIT` = **50** revisions (content-bearing requests are capped at
   50 and are heavy — ~2 MB).
2. Extract the infobox image per revision by regex
   (`|image=`, `image_name`, `photo`, `img`).
3. Collapse to distinct values. Walking newest→older, a run of revisions shares
   one image; the revision that **introduced** it is the **newest** of that run.
4. Return the first earlier photo whose author differs from the current one, plus
   when/by whom it was replaced and a diff URL.

Cheaper alternative if this ever needs optimising: list revisions with
**metadata only** (500/call, ~75 KB) to shortlist candidates, then use
`action=compare` with `slots=main&difftype=unified` — a diff containing both
`image=` lines is ~420 bytes, versus ~2 MB for 50 full revisions.

Caveat: identifying the image means parsing wikitext. That's reliable for
standard biography infoboxes but finds nothing for unusual templates or images
pulled from Wikidata with no local parameter.

### No-depicts search links

For photos with no depicts statement, the right column offers search links to
help find the person's entry. The name is **guessed from the filename**:

- The filename is assumed to **start with the name**, and a **separator word**
  ends it — `NAME_SEPARATORS` = `at` / `in`, easy to extend
  (`Hanna Flint at SXSW London 2026.jpg` → `Hanna Flint`).
- The `File:` prefix, extension and any trailing sequence number are stripped.
  A result under two words is discarded, so `Waymo` produces no bogus search.
- `personSearchUrl()` builds a **plain (unquoted)** `Special:Search` query
  restricted to namespace 0:

  ```
  https://en.wikipedia.org/w/index.php?title=Special%3ASearch&search=Hanna+Flint&fulltext=1&ns0=1
  ```

**Why plain rather than an exact phrase.** Measured on en.wikipedia, plain search
ranks the person's own article **first** where one exists (`James Dow`,
`Sharon Horgan`, `Kate Griggs`), which is the whole point of the link. A quoted
`"Name"` phrase search is worse for this: it returned **0 hits for `A. Y. Chao`**,
and for `Hanna Flint` the top hits were unrelated pages. `intitle:"Name"` is
worse still — 0 results for anyone whose article title isn't an exact match.
Quoting also made MediaWiki try the phrase as a page title, adding a
"does not exist" notice above the results.

**Encoding trap.** This is a *query parameter*, so spaces are `+`-encoded by
`URLSearchParams` and that is correct. An earlier version hand-built a
`/wiki/Special:Search/<name>` **path** instead, where `+` is a **literal plus** —
which corrupted names into `A.+Y.+Chao` and broke the search. Don't put the name
in the path.


## Rate limiting and reliability

All calls go through `api_get()` / `apiGet()`, which retries with exponential
backoff (`MAX_RETRIES` = 6, honouring `Retry-After`) on genuine rate limiting
(HTTP 429/503) and on connection/timeout errors, and **raises** on exhaustion
rather than returning a partial response that would look like "nothing found".

### Why there is no `maxlag`

`maxlag` is deliberately **not** sent. The docs are explicit that it's for
background work:

> "Interactive tasks (where a user is waiting for the result) may omit the
> `maxlag` parameter. Noninteractive tasks should always use it."
> — [Manual:Maxlag parameter](https://www.mediawiki.org/wiki/Manual:Maxlag_parameter)

This tool is the interactive case: somebody clicks Search and waits. `maxlag=5`
is the recommended default for **bots**, where a low duty cycle under load is the
intended behaviour precisely so that humans get priority.

Sending it caused frequent, avoidable failures:

- **Reads are not rate-limited.** `meta=userinfo&uiprop=ratelimits` returns only
  write/expensive actions (`edit`, `sendemail`, `purge`, `renderfile`, captchas)
  — no read entry. Per [API:Etiquette](https://www.mediawiki.org/wiki/API:Etiquette),
  *"There is no hard speed limit on read requests."*
- **It trips on Wikidata Query Service lag.** The lagged host reported was
  `wdqs1012`, a SPARQL/WDQS node this tool never queries, pinned at 35–37s, while
  the databases were fine (Commons 0.14s, en.wikipedia 0.85s) and no
  `X-Database-Lag` header was present at all.
- **The same requests succeed without it.** With lag reported at 35s,
  `wbgetentities` with `maxlag=5` returned `error=maxlag` and zero entities;
  the identical request without `maxlag` returned the entities.

So the failures were self-imposed: refusing requests the servers were happy to
serve. Etiquette for reads is still followed — serial (not parallel) requests,
50-item batching and generators. (The background job is the non-interactive
case and does send `maxlag` — see [Background refresh](#background-refresh).)

There is no published SLA or typical-response-time figure for the Wikimedia
APIs; WDQS lag is tracked only on Grafana dashboards with no documented "normal"
value, so there is nothing meaningful to gate on anyway.

### Rate limits (2026)

Wikimedia now enforces per-minute limits on the Action API
([Wikimedia APIs/Rate limits](https://www.mediawiki.org/wiki/Wikimedia_APIs/Rate_limits),
"new in 2026 and … subject to experimentation and change"): **200 requests/min**
for unauthenticated browser traffic and for bots with a compliant `User-Agent`,
**10/min** for clients identified only by IP. Over the limit is HTTP **429** with
`Retry-After`, which `apiGet()` already honours. A fast serial browser scan can
brush the limit; it just slows down. The limit is real — an un-paced probe
(~3 req/s) got a 429 from Commons while this was being built.

### Would an API key help?

Not really. Wikimedia has no read key; registering an account would only add
`apihighlimits` (batches 50 → 500), which for a typical search means 4 calls
instead of 8. For the static build it would mean either leaking a credential in
public source or forcing every visitor through an OAuth login.


## Photo Gaps pipeline (`gaps.html`)

The input box takes the same forms as Infobox History (`parseInput()`): an
**article link** (any Wikipedia, mobile links too) or a **Commons file** (name
or link) switches to *person mode* (below); a bare name or an en.wikipedia
**category** link runs the category mode. Categories here are English
Wikipedia categories, so a Commons or other-language category link gets a
message instead of a guess.

### Person mode

1. Resolve the person: an article → its `wikibase_item` (`pageprops`); a file →
   its MediaInfo depicts (P180) → the first human (`P31=Q5`) with a Wikipedia
   article (English first).
2. Wikidata label + image (P18); the article's current infobox photo
   (`pageimages`, `pilicense=any`).
3. Every Commons file with depicts = that person: `list=search`
   `haswbstatement:P180=Q…`, `srlimit=max`, paged, capped at `PERSON_FILE_CAP`
   (1,000; the status line shows "first N of TOTAL" when capped).
4. `imageinfo` + `extmetadata` (50 per request): author (with the WikiPortraits
   badge), description, size, date taken.

Sorted newest first by date taken, falling back to upload date. Each photo is
*good* / *low-res* / *old* by the same rule as the other pages (≥ 2 MP and taken
within 12 months, resolution known), and the one that is (crop-aware) the
article's current infobox photo is highlighted.

### Category mode

Given an English Wikipedia category and a subcategory depth:

| # | Step | API | Notes |
| :-- | :-- | :-- | :-- |
| 1 | `enumerateArticles` | `list=categorymembers` (`cmtype=page\|subcat`) | BFS to the chosen depth; deduped; capped at `GAP_ARTICLE_CAP`; flags `truncated` |
| 2 | `fetchArticlePhotoState` | `prop=pageimages\|pageprops\|categories` | One batched call per 50: lead image? Wikidata id? in `Category:Living people`? |
| 3 | assess | Commons `imageinfo` on the lead images | resolution + age of existing photos |
| 4 | `fetchP18Images` | Wikidata `wbgetentities` | candidate via P18, batched |
| 5 | (on demand) `fetchDepictingFiles` | Commons `list=search` `haswbstatement:P180=Q…` | files that depict the person; one search per person, so a per-row + "check all" button |

A gap = a **living** person whose article photo is **missing, under 2 MP, or
>12 months old**. `Category:Tennis players` is almost all subcategories, so a
flat (depth 0) search finds nothing — hence the depth control and the honest
`truncated` flag.


## WikiPortraits photographer badge (`wikiportraits.js`)

Both the Finder and History show who took each photo ("by …"). When that
photographer is in
[Category:WikiPortraits contributors](https://commons.wikimedia.org/wiki/Category:WikiPortraits_contributors)
or its subcategory
[Category:WikiPortraits photographers](https://commons.wikimedia.org/wiki/Category:WikiPortraits_photographers),
a text-height [WikiPortraits logo](https://commons.wikimedia.org/wiki/File:WikiPortraits_Logo.png)
(CC0, via its Commons thumbnail) follows the name, linking to the contributors
category (hover: "WikiPortraits contributor").

- **The list** is the user pages (namespace 2) of both categories, merged into one
  set, so someone in both gets one logo. Their photos and subcategories are
  ignored (2026-10-14: 32 contributors + 254 photographers, 25 in both, 261
  people; "WikiPortraits India contributors" holds only a photo category).
  One request per category per page load, so it's always current with no
  caching. A category that fails to load contributes nobody; if both fail, no
  badges are shown — never a wrong one. Pages await it before the first render.
- **Matching** uses the credit the page already shows (Commons `extmetadata.Artist`):
  1. the credit links to a user page — `/wiki/User:Name` or a red link
     `index.php?title=User:Name`, on any wiki — and Name is listed (a hard match;
     display names like "Bea Phi" for `User:Phibeatrice` work); or
  2. the credit has no user-page link and its text is exactly a listed username
     (plain-text credits such as "Harald Krichel").

  Usernames compare with underscores = spaces and the first letter upper-cased.
- **Not the uploader.** Uploaders on the list also upload other people's photos:
  on 182 older infobox photos, matching by uploader would have mislabelled 8
  (credits "Super Festivals", "Gage Skidmore"). Measured 2026-10-14 on 200
  current WikiPortraits photos: rules 1–2 matched 137, no false matches.
- **The categories are the source of truth.** Someone in neither gets no badge.
  (`User:Zafer`, credited on 63 of those 200 photos, is in contributors only —
  the reason contributors was added.)

## Infobox History (`history.html`)

Shows how a Wikipedia infobox photo changed over time: the current photo plus
the photos it replaced (`Images to show`, 1–10), each with when and by whom it
was swapped in and a diff link. The pipeline is in `history-core.js`; the page
keeps rendering, photo details and crop families.

### Input

`parseInput()`: a Commons file (name or URL), a Wikipedia article URL, or —
anything else — a Commons photo category (bare name, `Category:…`, or a category
link on either wiki). A bare title is never guessed to be an article.

### One person (article or file)

1. A file is resolved to its person: Commons `prop=info` → MediaInfo
   `wbgetentities` (`statements.P180`) → Wikidata `P31=Q5` with a Wikipedia
   sitelink (`enwiki` first).
2. **The current photo is `pageimages`, not the newest wikitext `|image=`.**
   They diverge when the infobox takes the image from Wikidata (`P18`) and the
   wikitext still holds a stale value; `mergeCurrent()` puts the lead first.
3. `buildTimeline()` walks `prop=revisions` newest → older with
   **`rvsection=0`** — only the lead section, where the infobox lives, ~2% of
   the full payload — and regexes `|image=` / `image_name` / `photo` / `img`.
   If the lead section yields no image at all, it retries once with full
   content. Filenames are normalised (comments/tags stripped, `[[File:…]]`
   unwrapped, underscores → spaces) and crops collapse into one photo.
   It walks `SINGLE_REV_LIMIT` revisions first; **Search another N revisions**
   resumes from the saved `continue` point rather than re-reading.
4. Photo details come from the **article's own wiki** (`prop=imageinfo`), which
   knows both local and Commons files. Non-English wikis rename the File
   namespace (`Fichier:`, `Datei:`), so results are mapped back via `normalized`.

### A Commons category

| # | Step | API | Notes |
| :-- | :-- | :-- | :-- |
| 1 | `walkCategory` | Commons `list=categorymembers` | BFS to `Subcategory depth`; capped at `CAT_FILE_CAP` unless un-capped; records the latest category-add `timestamp` as the watermark |
| 2 | `batchResolve` | Commons `info` + MediaInfo `wbgetentities` + Wikidata `wbgetentities` | depicted human per file, 50/call |
| 3 | liveness | per-wiki `pageimages` | keep files that are (crop-aware) the person's current infobox photo; dedupe people |
| 4 | `buildTimeline` | per-wiki `revisions` | `CAT_REV_LIMIT` revisions per person; **Search deeper** per row |

Files are processed **files per click** at a time (**Scan more files**). A chunk is
only consumed — queue shortened, people marked done — once it has fully
succeeded, so after an error the same files are retried rather than skipped.
**Re-check all files** re-runs steps 2–3 over every file (people already found
are skipped), catching photos that later gained a depicts statement or became the
infobox photo.

### Saved history (`data/history/`)

A search with a saved record loads it instead of scanning (badge: *From saved
history — updated <date>*). The page only **reads** records (anonymously,
via Pages); nothing done on the page is saved.

- **File name**: `cachePath()` — a slug of the identity (`category|<title>`,
  `article|<lang>|<title>`, `file|<title>`) plus an FNV-1a hash.
- **Validity**: ignored unless `algoVersion` equals `ALGO_VERSION` — bump it when
  extraction/crop/timeline logic changes, and every record is rebuilt.
- **Category record**: `count`, `depth` (the page adopts it on load),
  `exclude` (optional: subcategories skipped with everything below them — e.g.
  `Category:WikiPortraits photos of animals`; a file also in an included
  category still counts), `addedThrough` (watermark), `uncapped`, `scanned`, `pending` (files not yet
  scanned; `[]` = complete; `null` in older browser-saved records = "too long to
  store, re-enumerate and skip `scanned`"), `done` (`lang:article` keys),
  `people` (each with `topRev`, `lead`, `timeline`, and `outside: true` when
  the current photo is no longer from the category), `bg` (background-job state).
- **Single record**: `lang`, `article`, `topRev`, `cont`, `fullContent`,
  `scanned`, `lead`, `timeline`.
- **Check for updates** applies the same delta as the weekly job, in the tab only.

Until 2026-10 the page itself saved records through the GitHub Contents API
with a pasted token; that was removed when the background job took over.
(For the record: Contents API `GET` on a file over 1 MB returns `sha` but an
empty body; a 5.2 MB record still saved fine.)

### Hide

Each photo card has a **Hide** button — a one-off, view-only removal (e.g. to
screenshot the current photo next to an older one). The remaining headings
renumber; *Was replaced* keeps stating the real swap. Nothing is stored; any
re-render brings the card back.

## Background refresh

`.github/workflows/refresh-history.yml` runs `scripts/refresh-history.mjs` —
the only writer of `data/history/`. It reuses `history-core.js`, so it can't
drift from the page.

| When | Mode | Does |
| :-- | :-- | :-- |
| Mondays 03:17 UTC | weekly (`new`) | finish any unfinished scan; check every stored person's current photo (`pageimages`, 50 per request) and rebuild the history only where it changed; walk the whole tree — files added after the watermark are scanned, people whose photo left the tree are flagged `outside` |
| 1st of month 02:13 UTC | monthly (`full`) | all of the above, then re-check every file in the tree |
| Manual (*Run workflow*) | either | same. The form is pre-filled like a scheduled weekly run. Leave **new_search** empty for a plain refresh; fill it only to start tracking a *new* search (with **new_search_depth**, and **new_search_exclude** — `\|`-separated subcategories to skip). A bad new search is reported and skipped; the existing records are still refreshed. **budget_minutes** (default 320, max 330) |

Every run — scheduled or manual — refreshes **every** record in `data/history/`,
**each in its own job**: a `plan` job saves a new search (if given, without
scanning it — `--add … --create-only`) and lists the records smallest first
(`--list`: files scanned + pending); then a matrix runs one job per record,
**one at a time** (`max-parallel: 1` — a single request stream to Wikimedia,
whose rate-limit guidance also asks for ≤ 3 concurrent requests). Each job has
its own `BUDGET_MIN`, checks out the branch tip (earlier jobs have pushed),
and commits its own record (`cache: background refresh (<mode>) — <record>`), so
a big category no longer shares its time with the others, and one failing
doesn't stop the rest. GitHub documents that matrix jobs are *created* in list
order; that they also *run* in that order with `max-parallel: 1` is observed
behaviour, not a documented guarantee.
Runs are named in the Actions list (*Weekly refresh (scheduled)*, *Monthly
refresh (scheduled)*, *Manual weekly refresh*, …). GitHub notes scheduled runs
can be delayed at busy times, especially at the start of an hour, and under
heavy load some queued runs may be dropped.

- **Time-boxed.** The script stops at `BUDGET_MIN` (320) inside the job's
  350-minute timeout. Progress lives in the record — `pending` files, and a
  `bg.recheck.cursor` (last title of the sorted tree that was re-checked) — so
  the next run continues. Records are written atomically after every chunk
  (`CHUNK` = 500 files) and the commit step runs even after a failure or timeout.
- **Why "photo changed", not "article edited".** The first real run (2026-10-13)
  rebuilt 4,653 of 8,572 WikiPortraits people because their article had *any*
  edit since the record was saved — 3 h 49 min, almost all wasted. Comparing the
  current photo costs ~180 requests for ~9,000 people. Trade-off: a photo swapped
  and swapped back between two runs isn't noticed. People stored without a
  current photo (browser saves before 2026-08-28) have it filled in.
- **"No longer from this category"** is only judged for people whose current
  photo is known (stored, or looked up this run); missing data never flags anyone.
- **One commit per record per run**, `cache: background refresh (<mode>) — <record>`,
  with the record's summary as the body (also on the run's summary page): per record, what was
  done, how long it took, requests made, and time spent waiting on lag.
- **Bot etiquette** (non-interactive, unlike the page): `User-Agent`
  `WikimediaInfoboxCheckerBot/1.0 (<repo URL>[; <contact>]) node/<version>`,
  per the [User-Agent policy](https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_User-Agent_Policy);
  `maxlag=5` on every wiki, per
  [Manual:Maxlag parameter](https://www.mediawiki.org/wiki/Manual:Maxlag_parameter)
  and [Wikidata:Bots](https://www.wikidata.org/wiki/Wikidata:Bots) ("Bots should
  respect maxlag") — waits ≥ 5 s, doubling to 60 s; serial requests paced to
  `REQS_PER_MIN` = 180, under the 200/min bot limit. **Wikidata's lag includes
  Query Service (WDQS) lag**, which is often above 5 s (2026-10-13 14:13 UTC:
  9.25 s from `wdqs1014` while the databases were at 0.2–0.7 s), so the
  Wikidata step — resolving who a file depicts — can stall for a while. Refreshing
  stored people only uses Wikipedia and isn't affected. If lag lasts over 60
  minutes the run saves and stops; the next run continues.
- **Contact address**: set an Actions secret `WIKIMEDIA_CONTACT` (e.g. an email)
  to have it appended to the `User-Agent`. It's sent only to Wikimedia's servers
  and never appears in the repo or the logs. Without it, the repo URL is the
  contact.
- **Locally**: `node scripts/refresh-history.mjs --only <record>.json --budget-min 5`
  (Node 20+; reads Wikimedia, rewrites only the local record files).

## Tunables

At the top of each tool's `<script>` (history: `history-core.js`; background job: `scripts/refresh-history.mjs`):

| Constant | Value | Meaning |
| :-- | :-- | :-- |
| `BATCH` | 50 | Items per `titles=`/`ids=` request (non-bot cap) |
| `THUMB_WIDTH` | 320 | Requested thumbnail width |
| `STALE_MONTHS` | 12 | Age at which a photo is flagged stale |
| `LOW_RES_MP` | 2.0 | Megapixels below which resolution is flagged |
| `MAX_RETRIES` | 6 | Attempts per request before aborting |
| `BACKOFF_BASE` | 1.0 | Backoff seconds, doubled per retry when no `Retry-After` |
| `HISTORY_REV_LIMIT` | 50 | (finder) Revisions fetched per history lookup |
| `GAP_ARTICLE_CAP` | 5000 | (gaps) Max articles enumerated from a category tree |
| `MAX_DEPTH` | 5 | (finder) Deepest subcategory depth accepted |
| `MAX_TREE_FILES` | 10000 | (finder) Files read from a category tree before stopping |
| `SINGLE_REV_LIMIT` / `SINGLE_REV_EXTEND` | 1000 / 1000 | (history) Revisions walked for one person / per "Search another" |
| `CAT_REV_LIMIT` | 200 | (history) Revisions walked per person in category mode |
| `CAT_CHUNK` | 100 | (history page) Default *files per click* (input accepts 1–50000) |
| `CAT_FILE_CAP` | 3000 | (history) File cap unless un-capped |
| `ALGO_VERSION` | 3 | (history) Saved-record version; bump to invalidate all records |
| `CHUNK` | 500 | (background job) Files per checkpoint |
| `REQS_PER_MIN` | 180 | (background job) Request pacing, under the 200/min bot limit |
| `BUDGET_MIN` | 320 | (background job, env) Minutes before a run saves and stops |


## Licence

See [LICENCE](LICENCE).
