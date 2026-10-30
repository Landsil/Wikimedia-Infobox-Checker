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
| `score.html` | **Trial photo score** — one person → every Commons photo depicting them, scored with in-browser face and pose detection (MediaPipe) |
| `vendor/mediapipe/` | Our unmodified copy of Google's MediaPipe runtime + two models, with `versions.json` (release id, sizes, SHA-256), `LICENSE`, `NOTICE.md` |
| `scripts/sync-mediapipe.mjs` | Checks / downloads a newer MediaPipe release (≥ 14 days old upstream) |
| `.github/workflows/check-mediapipe.yml` | Weekly: a newer release goes to its own branch + a review issue assigned to Landsil |
| `vendor/pdfjs/` | Our unmodified copy of Mozilla's pdf.js (the two minified ESM builds), with `versions.json`, `LICENSE`, `NOTICE.md` |
| `scripts/sync-pdfjs.mjs` | Checks / downloads a newer pdf.js release — same rules as the MediaPipe sync |
| `headshots/` | **Headshots** — installable, offline PWA for an event shoot: badge photos → names → grouped, renamed headshots. Its own scope, worker and storage |
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

### Grouped by person

Comparison rows are grouped by depicted person, as in Infobox History: one
heading — the person's article (and its wiki) · their Wikidata item — over all
of that person's candidates (`personGroups()`). People keep the order of their
newest candidate; a person without a Wikipedia article gets their name and the
Wikidata link only.

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
- **Other top-20 Wikipedias** — a third section of each comparison row, on the
  right (the Finder's page is 1440 px wide for it; under 1200 px it drops to a
  strip below the row): the count of the person's other articles on the
  `TOP_WIKIS` (and of Wikipedias in all), then the check's results.

`TOP_WIKIS` are the 20 largest Wikipedias **by active users** (siteinfo
statistics, 2026-10-15): en es fr de it ja ru zh pl nl fa pt he ar id ko uk sv vi
tr. By article count, ceb / arz / war / ce would be in the top 20, but they are
mostly bot-made place and species stubs with ~80–300 active users.

**Check other Wikipedias** (toggle, off):

1. `pageimages` for those articles — one batched request per Wikipedia
   (≤ 50 titles, `pilicense=any`), so ≤ 20 per 50 people;
2. each **distinct** lead photo once (the same Commons file is usually reused
   across languages): `imageinfo` with `iiprop=size|timestamp|url|extmetadata`
   and `iiextmetadatafilter=DateTimeOriginal` (only the date taken — far lighter
   than full metadata), 50 per request on Commons, then any wiki-local files on
   the wiki that uses them.

Measured on Photographs by Mateusz Malta (2026, 99 candidates): **21 requests,
4–6 s** (the earlier all-Wikipedias, presence-only check was ~150). Each
candidate then lists *no photo* languages, and the photo each other language
uses grouped by file — size and date, red only where it fails the same "good"
rule as the comparison (≥ 2 MP and taken within 12 months). **Only missing or
poor photo on another Wikipedia** filters to people with at least one such
article. Results are kept until the next search; switching off only hides them.

With the 12-month rule most other-language photos count as poor (63 of the 99
candidates' people in that test), because "old" means taken over a year ago.

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

Results are cards, two per row (one when narrow): the current infobox photo on
the left, the data beside it. **Show Commons photos for all** is a real toggle:
on fetches anyone not fetched yet and shows everyone's depicting files; off goes
back to only those opened with their own button. Fetched results are kept, so
switching costs nothing. Only good (not old, not low-res) depicting files are
offered; when none of the first 8 is good the card says so with the Commons total
and a **see all N** link to person mode for that person.

`DateTimeOriginal` from Commons' `{{other date}}` carries machine text
(`1970s` + `date QS:P,+1970-00-00T00:00:00Z/8`); `cleanDate()` drops it (in
`gaps.html`, `finder.html`, `history.html`).

Given an English Wikipedia category and a subcategory depth:

| # | Step | API | Notes |
| :-- | :-- | :-- | :-- |
| 1 | `enumerateArticles` | `list=categorymembers` (`cmtype=page\|subcat`) | BFS to the chosen depth; deduped; capped at `GAP_ARTICLE_CAP`; flags `truncated` |
| 2 | `fetchArticlePhotoState` | `prop=pageimages\|pageprops\|categories` | One batched call per 50: lead image? Wikidata id? in `Category:Living people`? |
| 3 | assess | Commons `imageinfo` on the lead images | resolution + age of existing photos |
| 4 | `fetchP18Images` | Wikidata `wbgetentities` | candidate via P18, batched |
| 5 | (on demand) `fetchDepictingFiles` | Commons `list=search` `haswbstatement:P180=Q…` (`srinfo=totalhits`) | the first `DEPICT_LIMIT` (8) files that depict the person, plus the total; one search per person, so a per-person button and a **Show Commons photos for all** toggle |

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

## Headshots (`headshots/`)

An **installable, offline** tool for filing an event shoot, kept deliberately
apart from the rest of the site. The photographer shoots a person's badge (or a
screen showing their details), then that person's headshots, then the next
person's badge. This reads the folder in capture-time order, reads the names off
the badge frames with Chrome's built-in model, groups each run of headshots under
the badge before it, and renames them into a `done` folder.

A document can be dropped in first (a programme, delegate list or press pack).
Each person in it becomes a roster entry carrying a face, so a headshot whose
badge was missed can be named by matching faces rather than by typing.

Everything the tool needs is settled in **step 1** before a folder is chosen —
the two site downloads and Chrome's own model are checked and fetched there, so
nothing interrupts a shoot halfway through.

Why a subdirectory and not one `.html` at the root: a service worker can only
control its own folder and below, and GitHub Pages cannot send the
`Service-Worker-Allowed` header that would widen the scope. Living in
`headshots/` therefore gives it its own worker scope, its own caches and its own
IndexedDB, so nothing it does can affect the other four pages.

### The worker serves the network first, and the page says which build it is

`sw.js` was cache-first with a background refresh, and that cost a day. After a
deploy the first load served the **previous** build and fetched the new one for
next time, so corrected code looked uncorrected: a stale page was reported as a
bug twice, and the second report was investigated as though it were one. Two
changes, both about never having to guess again:

- **Network first, cache as the offline fallback.** The app's own files are tens
  of kilobytes, so a round trip when online costs nothing against being certain
  what is running. Offline use is untouched — the fallback serves the precached
  copy, and the big downloads live in their own Cache Storage, not the worker's.
- **`build.js` holds one string**, shown in the footer and on the checks page, and
  bumped with every change that reaches a browser. "Is this the new code?" is now
  answered by reading the page rather than inferred from how it looks.

The page also reloads itself once when a new worker takes over
(`controllerchange`), because a deploy otherwise needed two reloads and the first
one looked like nothing had been fixed.

Step 1 folds to its own heading once there is nothing left to do, rather than
leaving a panel of ticks in the way for the rest of a shoot. Opening or closing it
by hand is remembered, so a re-check cannot fold it away under someone reading it.

### Files

| File | What |
| :-- | :-- |
| `index.html`, `app.js`, `app.css` | The app and its UI wiring, including step 1's dependency checks |
| `shoot.js` | Listing a folder, grouping by badge, renaming and moving — DOM-free, so it is testable |
| `exif.js` | Capture time from a JPEG's EXIF, no dependency; falls back to the file date |
| `identify.js` | Reading a name off a badge with the Prompt API (Gemini Nano) |
| `faces.js` | Checking a run of headshots really is one person: face crop → embedding → cosine similarity |
| `doc.js` | Building a roster from a document: PDF → page images + text layer → faces → the name printed with each |
| `demo.js` | A sample shoot for testing — drawn badges and stand-in portraits, with EXIF spliced in. Reachable at `index.html?sample=1`, and used for `check.html`'s fixtures |
| `db.js` | A key/value corner of IndexedDB, so a shoot survives closing the tab |
| `sw.js`, `manifest.webmanifest`, `icon-*.png` | PWA shell: offline cache, install metadata, icons |
| `check.html` | What this browser supports, plus a self-test of the renaming |

### Step 1: everything settled in advance

Dependencies used to be fetched where they were first needed, which meant a
19 MB MediaPipe download appearing at the *face check*, a 1.7 MB pdf.js download
appearing when a PDF was dropped in, and Chrome's model downloading on the first
badge scan. That is three interruptions in the middle of the work, and the last
one could fail on a machine that had never been checked.

Step 1 now reports all of it at once and fetches it on request, so a machine can
be prepared before an event rather than during one:

| | Size | Needed for |
| :-- | :-- | :-- |
| Renaming files in your folder | — | a browser capability, not a download |
| Face models (MediaPipe runtime, detector, embedder) | 19.2 MB | finding and comparing faces, reading a programme |
| PDF reader (Mozilla's pdf.js) | 1.72 MB | reading a PDF programme |
| Chrome's built-in model | Chrome's own (~2 GB) | reading badges, matching names to faces |

*Set everything up* does the three in sequence; each row also has its own button,
and *Check again* re-reads the state. **Nothing downstream may start a download.**
Downloading Chrome's model is not sufficient either: creating the first session
can still fetch, which is why a model "set up" in step 1 was seen downloading
again when a document was read. Step 1 therefore also *starts* the session and
keeps it, and every later use asks `modelReady()` — session in hand, or
availability exactly `"available"` — and quietly does without the model rather
than fetching it. Opening a folder now runs the badge pass automatically, so this
matters more than it did: without the rule, picking a folder could have set a
multi-gigabyte download going.

The first three are hard requirements for a shoot and gate step 2. The model is
**advisory**: some devices genuinely cannot run it, and without it badges are
marked by hand and names typed, which the blocker at the top of the page says
plainly. Triggering Chrome's download needs a user gesture, so `downloadModel()`
creates a session purely to start the fetch and destroys it again.

**Downloaded is set up.** Whether a live session exists was briefly treated as
part of readiness, which was wrong twice over: a session belongs to a page and
cannot survive a refresh, so every reload asked to "start" an already-ready model
and step 1 could never report itself finished. A session is created on first
actual use, which fetches nothing once availability is `"available"`.

Step 1 folds to its own heading once there is nothing left to do. Opening it by
hand is remembered — but only a real click counts: listening for `toggle` caught
this code's own calls to `.open`, marked the panel as touched on the first render,
and left it stuck open permanently.

### The grouping rule

Photos are sorted by **EXIF `DateTimeOriginal`**, falling back to the file's own
date for screenshots and PNGs (`captureTime()` reports which was used). Only the
order matters, so a camera clock that is wrong is harmless.

**A badge has to carry a name the model actually read off it.** The model's own
classification was trusted, and on a real shoot it called almost every photograph
an identity frame — unsurprisingly, since event portraits nearly all have writing
in them: sponsor backdrops, step-and-repeat banners, signage, worn lanyards.
Every false badge starts a new person, so the grouping collapsed to roughly one
person per photograph. A frame whose subject really is someone's name yields that
name; one that does not is treated as a portrait and labelled *"writing, but no
name — not a badge"*, so it can be promoted by hand in one click. The count of
demotions is reported.

That gives up the earlier rule where an unreadable badge still started a new
person. It was the wrong side of the trade: a missed badge merges two people and
is now caught by the change of face, whereas a false badge shatters the whole
shoot.

**Badges are not guaranteed, so they cannot be the only thing that separates
people.** Plenty of subjects are photographed without one, and a badge can be
unreadable or simply missed. So a new person begins at a badge **or** when the
face changes: `groupPhotos` takes a `startsNew(photo, current)` predicate and the
app supplies a face comparison, against the most recent frame in the group that
had a face so one unusable frame cannot split somebody in two.

A capture-time gap was tried first and was the wrong idea. It asked the operator
to name a number of minutes as a proxy for the thing actually being detected —
the subject changing — and nothing about a shoot makes that number knowable in
advance. The face comparison needs no setting at all.

Two cases it has to get right, both now tested:

- **Nobody wore a badge.** `current` being null used to mean no person could
  begin, so a badge-free shoot produced no people whatever — every frame fell
  into `leading`. A face with nobody current now starts one.
- **A frame with no detectable face never starts a person.** That is what keeps
  test frames, venue shots and the badge photographs themselves out of the
  people list.

Its honest limit: the first frame after a badge is taken as that badge-holder's,
because there is nothing yet to compare it against.

Finding the badges is **not a step**. It is not a decision anyone has to make, so
it runs as part of reading the folder, in the same pass that embeds every face —
nothing to press, and no progress to babysit. Correcting a badge belongs where
you look at people, so *badge* / *not a badge* lives in the review and regroups
immediately.

Filing is not gated behind a confirmation. A tick-box asking you to confirm the
people were right was added and removed: the whole step is already a review, the
button says what it will do, and nothing it does is irreversible — so the box
asked for a promise instead of preventing a mistake.

Photos before the first person cannot be attributed and are left where they are,
as is any person still without a name.

Filing writes `<Name> 01.jpg`, `<Name> 02.jpg`, … into `done/`, with the badge
frame as `<Name> - badge.jpg`. Numbering continues past whatever is already
there, so a second sitting for the same person cannot overwrite the first.
`safeName()` strips the characters no filesystem will take, and the trailing dots
Windows silently drops. Moving uses `FileSystemHandle.move()` (Chrome 102+); the
fallback copies, checks the copy's byte count, and only then removes the
original, so a failed write cannot lose a photo.

### The face check

Time order says which badge a photo follows; it cannot say whether the person
changed. **Check the faces match** crops the biggest face in each headshot,
turns it into a vector with MediaPipe's `ImageEmbedder` (MobileNet v3 small) and
compares them by cosine similarity — `ImageEmbedder.cosineSimilarity`, both
already in the bundle we vendor, so only a 4 MB model was added.

Measured on one event's photos (2026-10-30 — 4 people, 12 photos, same backdrop
and lighting, i.e. the hard case):

| | pairs | min | mean | max |
| :-- | :-- | :-- | :-- | :-- |
| Same person | 12 | **0.61** | 0.77 | 0.97 |
| Different people | 54 | 0.17 | 0.32 | **0.48** |

No overlap, so `SAME_MIN` = **0.55** sits in the gap; run through `faces.js`
itself it classified all 66 pairs correctly. Each photo is scored by its *mean*
similarity to the others in its group, so one odd frame cannot drag the group
down, and two groups whose most typical photos score ≥ 0.55 are flagged as
"possibly the same person — one badge may have been missed".

It **flags, never decides**: nothing is regrouped or filed on the strength of a
face. The thinnest margin is the group-photo case (0.61 against 0.48), where the
biggest face may not be the subject. A photo with no detectable face is reported
as such, not treated as a mismatch, and a manual regroup clears the scores rather
than showing stale ones.

These are generic image embeddings, not face recognition. They answer "do these
two crops look alike", only within one shoot, and no identity is stored or
matched against any database — the promise on the score page still holds.

The ~19 MB this needs (runtime, face detector, embedder — not the landmark or
pose models) is downloaded from this site on request, SHA-256 checked, and kept
in this app's own Cache Storage. `check.html` has a panel to run the comparison
on your own photos and see whether 0.55 separates them.

### Building a roster from a document (optional step 2)

A programme, delegate list or press pack usually pairs each person's photograph
with their printed name. Dropping one in gives every later step a roster: a
headshot whose badge was missed can then be matched to a name **by face**,
without anyone typing a list.

Each page is rendered to an image by Mozilla's pdf.js (our vendored copy), every
face on it is found, and the name printed with that face is attached to it. Images
and screenshots are accepted too and used as a single page.

Two different jobs are involved here, and conflating them is what went wrong
first:

| | Done by | Why |
| :-- | :-- | :-- |
| **Where the words are** | the PDF's own text layer | verbatim, exact, free, unfakeable |
| **Which face they belong to** | the on-device model | it is a judgement about a picture, which is what a model is for |

The model does the matching, and **cannot contribute a name of its own**: it is
given the page's names as a closed list and a response schema whose `enum`
admits nothing else, so an invented name is unrepresentable rather than merely
discouraged. That matters because free-text reading was measured failing three
ways on one test programme whose real guests were Anthony Wonke, Ashley Walters,
Adam Pearson and Bella Ramsey:

| Attempt | Result |
| :-- | :-- |
| Cut-out too short | Read the step-and-repeat banner *inside* the photograph ("BFI LONDON FILM FESTIVAL") and invented four names |
| Cut-out widened | One correct read, but a **correct** "Adam Pearson" was thrown away because the model returned an empty transcription |
| Transcription forced first | Invented all four names — "Denzel Washington", "Steve McQueen", "Stephen Fry", "Emerald Fennell" — **and** invented a transcription agreeing with each one |

The third attempt is the one that settled it. The guard was a code check that
every word of the name must appear in the model's own transcription of the
image; once the model wrote the transcription to match the name it had invented,
the guard passed every hallucination. **A model's output cannot be audited
against the same model's output** — it had only ever worked by luck, when the
model happened to leave the transcription honest.

The conclusion was not "don't use the model", it was "don't let it supply the
strings". Asked to *choose* among names the document itself prints, it has
nothing to invent with, and the enum enforces that in the protocol rather than
in a check afterwards.

Position is still worked out, independently, as a second opinion. The two
normally agree; where they disagree the face is **flagged for a human** with both
candidates offered, rather than resolved silently. Because both answers come from
the page's own text, a disagreement is only ever about *which* printed name is
right — never about a fabricated one. Each card says which way its name was
arrived at, because "both methods agree" is worth more than either alone.

Two details of what the model is shown matter, and both came from watching it
decline:

- **Its crop is measured against the page, not the face**, for the same reason
  the positional reach is. Before that, it answered `(none)` for the two smallest
  faces — correctly, since their crops stopped short of the caption. The enum had
  done its job: with nothing to read it declined instead of inventing. Widening
  the crop fixed the case it was aimed at, and the 82px face it had abstained on
  is now matched.
- **The face being asked about is outlined in the crop**, and the prompt refers to
  that outline. A crop generous enough to contain the caption is also generous
  enough to contain a neighbour's photograph, which makes "the face in the middle"
  untrue.

### The layout is learned, not assumed

Everything below used to be a guess hardcoded from the first document that worked,
and each guess broke on the second one. What replaced them rests on one
observation: **a document is laid out consistently**, so whatever holds for one
photograph holds for the rest, and the page can simply be asked.

**The grid comes from the text's own baselines.** `gridPitch()` groups lines into
bands and takes the median gap between their centres: 390px on a four-column cast
sheet, 795px on a two-column programme. Two earlier units were measured failing:

- *Fractions of the page.* A `SAME_COLUMN` of 0.12 page-widths is itself wider
  than a column in a four-column sheet, so every caption window straddled its
  left-hand neighbour and — ties on a shared baseline resolving leftmost-first —
  every name came back one cell to the left. The same unit gave the model a crop
  two columns across, and one person's name came back for three different faces.
- *The faces.* Measuring the pitch off the photographs instead seemed obviously
  better and was worse. A face sits at a different height inside each photograph,
  so nine portraits in three rows grouped into **five** pseudo-rows and the column
  gap came out as 1174px against a true 390px. That reproduced the original
  left-shift exactly, which is how it was caught.

**Which line is the name comes from repetition.** `looksLikeName()` — two or more
capitalised words, no digits — is gone. It dropped mononyms (*Zendaya*), every
name with a lowercase particle (*Ludwig van Beethoven*, *Hassan al-Banna*,
*Catherine de Medici*) and every uncased script, so a Japanese programme produced
no names whatever; and it cheerfully accepted *EXECUTIVE PRODUCER* and *Director
of Photography* as people. Instead: roles repeat down a page — CAST, CAST, CAST,
PRODUCER — and names do not. For each line of the caption, the share of distinct
values across every face on the page is measured, and the most distinct line is
the name. No wordlist, no language, no case. It handles a role printed *above* the
name for free.

**Which side the captions are on is also learned.** Captions were assumed to be
below, so a page with names beside the photographs found nothing at all. All four
directions are now scored across every face at once and the best wins: coverage ×
how distinct its most name-like line is. A heading above a row of photographs is
the same text for all of them, so "above" scores badly wherever the captions are
really below. With a single photograph there is no repetition to judge by, so the
nearest caption wins instead.

The one assumption left is that a caption is near its photograph, in a consistent
place, with consistently-structured lines.

`namesOn()` then returns exactly the names this page's own layout yields — which
is the closed list the model chooses from, so it holds no headings and no job
titles. `captionFor()` is the positional second opinion. Both work off the page's
text runs with their rendered boxes (`page.getTextContent()`, mapped through the
viewport transform), grouped into lines. Four further rules, each measured rather
than guessed:

- **A wide horizontal gap splits a line.** Captions in a grid share a baseline
  across columns, so grouping purely by baseline produced the single line
  `"Anthony WonkeAshley Walters"`, which then matched neither face. A gap only has
  to beat a word space to split, so it is measured against the font height.
- **The column window is generous sideways.** A caption is left-aligned to the
  photograph while the face is centred in it, so a window measured off the face
  box clips the start of the name — "Adam Pearson" came back as "earson". The
  window is therefore at least 12% of the page width to each side, and only has
  to *overlap* a line rather than contain it.
- **How far to look is a property of the page, not of the face.** In face-heights
  it lost exactly the people whose faces were small: an 82px face in a tall
  photograph reached y=1152 while its caption was printed at y=1280, so two of
  four people on a page were reported as having no caption. The reach is 35% of
  the page. A generous reach is safe because the *nearest* qualifying line wins,
  so it cannot steal the row below.
- **Which side of a face a line sits on is judged by its centre, not its edges.**
  An edge test discards a caption wider than the photograph above it — "Sharon
  Duncan-Brewster" reached past her picture and was dropped, leaving only the role
  printed beneath her.
- **A name that wraps is one entry.** A long surname on a second line was landing
  in the field below it: "Sharon Duncan-Brewster" came out as "Sharon" with
  "Duncan-Brewster" filed as the organisation. Lines in the same font, tightly
  stacked, whose text appears only once on the page are joined — and joined
  without a space after a hyphen, since the break falls inside the name. The font
  alone is not enough (a document setting name and role in one font would have the
  role swallowed); the one-off test is what distinguishes half a name from a role,
  because a role repeats down the page. Merging before the slot analysis also
  keeps the slots aligned: otherwise one wrapped name shifts that person's role
  into a different slot from everyone else's.
- **A caption block is grouped on both axes.** Beside-the-photo layouts are
  selected by row, so a cell could see the previous cell's lines at the same
  height and hand back the neighbour's name. Centres rather than edges again,
  because centred captions of differing widths share a centre and not a left edge.
- **A line must look like a name** to be taken as one: two or more words, every
  one capitalised, no digits. That is what keeps "Festival Programme 2026" and
  "Guest speaker" out of the name field — the latter is kept as the organisation
  when it follows the name closely enough. The organisation is looked up relative
  to the *name* line rather than the face, because searching the face's reach
  window missed one by three pixels.
- **The nearest caption, then the line closest to this face.** Taking the first
  in reading order instead silently prefers the left-hand neighbour whenever two
  names share a baseline — which is every grid.

Print-to-photo matching was measured before trusting it, since the 0.55 threshold
was calibrated photo-to-photo and a roster compares a *rendered PDF portrait*
against a *camera photo*. On nine printed portraits against the four source
photographs: same person **0.679–0.816** (mean 0.775), different people
**0.151–0.518**, 9 of 9 correct with 0.55 sitting in the gap. (A first run
appeared to show the opposite — same-person mean *below* different-person mean —
because `rosterFrom` returns faces biggest-first, not in cell order, so the
pairing was wrong. The names, not the order, say who is who.)

Measured on two layouts (2026-10-30, Chrome 156). A **four-column cast sheet**
of nine people, names and roles centred under each portrait: **9 of 9 names and
9 of 9 roles correct**, captions found below, column pitch 390px, the model's crop
429px — one cell. And a two-page **two-column programme** whose guests are
Anthony Wonke, Ashley Walters, Adam Pearson and Bella Ramsey:

| | Result |
| :-- | :-- |
| Names correct | **4 of 4**, with their organisations |
| Invented names | **0** |
| Model and layout agreed | 3 of 4 |
| Resolved by the layout alone | 1 of 4 — the model answered `(none)` |
| Positional matching alone, no model | 4 of 4 in 69 ms |

The one abstention is not a crop problem: that face is 154px and its caption is
well inside the crop, so the model is simply unsure there and the second opinion
covers it. That is the arrangement working as intended rather than a fault —
neither method has to be right every time for the pair to be.

The two spurious low-confidence detections inside the event photographs are
dropped by a 0.5 confidence floor, which a printed portrait comfortably clears.

Reading a document shows real progress. Rendering, finding faces and matching
names each take a share of the bar, and the name phase reports `face N of M`,
because on a page of nine people the whole read previously looked frozen.

A face that neither method can name is reported as having no caption, and a page
with a text layer but no name-shaped line in it is never handed to the free-text
reader — there is nothing on such a page to attribute, so asking would only
invent something.

#### What it still will not do

Worth being plain about, since "works on any sensible PDF" is a bigger claim than
this earns:

- **A scan or a screenshot has no text layer**, so there is nothing to take names
  from and the model has to read them. Those are marked `unverified`.
- **The caption has to belong to its photograph.** A legend elsewhere on the page
  — "clockwise from top left: …" — is not a caption, and nothing here will map it.
- **A face has to be found** (confidence ≥ 0.5). A portrait the detector misses is
  a person missing from the roster, and a photograph containing two people yields
  two entries.
- **If every caption on a page reads the same**, repetition cannot tell a name
  from a role and the first line is taken. Two people with the same name on one
  page collapse into one candidate.
- **One photograph on a page** leaves nothing to learn from, so the nearest
  caption is taken on trust.

Scans and screenshots have no text layer at all, so there is no candidate list to
choose from and the model has to read after all. Those names come back marked
`unverified`, render as *"read by the model — check it"*, and step 2 says on the
page that the model has been caught inventing names. The finding above is exactly
why they are not treated as facts.

Face detection on a page needed its own fix. The detector scales whatever it is
given down to its own small input, so a portrait that is small within a big page
disappears: on a 1801x2548 render a 150px face lands at about 11px, and only 1 of
4 portraits was found. `facesIn(page, { tile: true })` therefore also searches
overlapping tiles (760px, 25% overlap) and de-duplicates by box overlap.

### What it needs, and what it does not

- **Chrome or Edge on desktop.** `showDirectoryPicker` is Chrome 86+/Edge only —
  **not Firefox, not Safari**, on any platform (browser-compat-data, checked
  2026-10-30). `FileSystemHandle.move()` does exist in Firefox 111 and Safari
  15.2, but only for the browser's private storage, which cannot reach a real
  folder, so it does not help.
- **Chrome 148+** for the built-in model (`LanguageModel`; Edge 138 only behind a
  flag, no mobile at all). Per Google's requirements: Windows 10/11, macOS 13+,
  Linux or Chromebook Plus; 22 GB free on the Chrome profile's volume; >4 GB VRAM
  or 16 GB RAM with 4+ cores. The model is Chrome's, downloaded once on first
  use — we ship nothing. Output is constrained with `responseConstraint`
  (JSON Schema, Chrome 137+) so the answer is parsed, not interpreted.
- **Without the model it still works**: mark the badge frames by hand in step 4
  and type the names. Step 1 says so before you start, rather than failing later.
- **Nothing is uploaded.** Chrome's own documentation states no data is sent to
  Google or any third party when using the model. The single network call is the
  Wikipedia look-up in the report, behind a button, which sends only the names —
  and reports which of those articles have **no photo**, which is the point of the
  rest of this site.
- **It reads what is written on a badge, and picks between names a document
  already prints.** It does not recognise faces and does not identify anyone from
  their appearance, matching the promise on the score page. Face comparison is
  only ever used to ask whether two photos in the same job look like the same
  person.

### Trying and testing it

The sample shoot — two drawn badges with real text and six stand-in portraits,
each with EXIF spliced in — builds in the browser's private storage, so every
step including the renaming can be exercised without going near a real photo. It
is **a testing hook, not a feature**: the button only appears at
`index.html?sample=1`, because it was clutter in a tool whose users have their
own photos. `check.html` uses the same builder for its fixtures.

`check.html` reports what the browser supports and runs an 18-assertion self-test
of the pipeline against that private storage: EXIF ordering, grouping, the native
`move()`, numbering continuation, and filename safety. Measured 2026-10-30 in
Chrome 156:

| Suite | Assertions | Covers |
| :-- | :-- | :-- |
| `check.html` self-test | **18/18** | EXIF ordering, badge grouping, native `move()`, numbering, filename safety |
| End-to-end, driving the app | **24/24** | step 1's downloads, the sample shoot, hand-marked badges, the face check, the badge-confirmation gate, filing, the report, the Wikipedia look-up |
| `groupPhotos` rules (Node) | **18/18** | badges only, people nobody badged, time meaning nothing on its own, a frame with no usable face, mixed badged/unbadged, a shoot with no badge anywhere, faceless frames inventing nobody |
| Badge classification (Node) | **15/15** | a real badge kept; a portrait against a backdrop demoted; an invented name dropped and not a badge; an unverifiable claim demoted; portraits and other frames untouched; a name split across fields; accents and case; unparseable and thrown answers never badges |
| Learned layout (Node) | **26/26** | captions below / right / above / left; multi-word job titles not taken for names; a role printed above the name; mononyms, lowercase particles, Japanese, Arabic, Cyrillic, Icelandic; the candidate list holding names only; a heading not taken as a caption; one photo with nothing to learn from; a single column with no measurable pitch |

`check.html` also has panels to run the face comparison, the document roster and
the badge reading on your own files, which is how each of the findings above was
measured.

**The model has now been run** (2026-10-30, Chrome 156, a headless test profile
that downloaded it) and the result changed the design. Asked to read names off
portraits it confidently returned famous names that were not on the page, and
when asked to transcribe what it had read, invented a transcription agreeing with
them. Details and the three measured rounds are above, under *Building a roster
from a document*.

What follows from that, and holds for the badge step too:

- **A name from the model is a suggestion, never a fact.** Every one is shown for
  confirmation before anything is filed under it, and names taken from a PDF's
  text layer are marked apart from names a model produced.
- **Checking a model against itself does not work.** The transcription guard in
  `identify.js` is kept because it does catch the easy case — a name with no
  supporting text — and it distinguishes "invented" from "could not be checked"
  so a correct read is not thrown away. It is not relied on.
- The badge path still has no ground truth to check against, since a badge
  photograph has no text layer. So badge names are treated the same way:
  suggestions, confirmed by the photographer in step 4.

## Trial photo score (`score.html`)

A **trial**. For one person — an article link on any Wikipedia, or a Commons
photo of them — every Commons photo with depicts (P180) = that person (the same
lookup as Photo Gaps' person mode, up to `PHOTO_CAP` = 300), each analysed **in
the browser** with Google's MediaPipe and scored by simple rules shown on the page.

### The saved copy (consent, versions, integrity)

- The page links our copy (`vendor/mediapipe/` on GitHub) and Google's originals
  (npm `@mediapipe/tasks-vision`, the model files on `storage.googleapis.com`).
- Nothing is downloaded until the visitor presses **Agree**. The files (22.9 MB:
  runtime 12.2 MB — `vision_bundle.mjs`, `vision_wasm_internal.{js,wasm}`, SIMD
  build only — plus `blaze_face_full_range.tflite` 1.1 MB, `face_landmarker.task`
  3.8 MB and `pose_landmarker_lite.task` 5.8 MB) come from this site, are checked against the SHA-256 in
  `vendor/mediapipe/versions.json`, and are kept in **Cache Storage** under
  `score-mediapipe-<release>` (not the HTTP cache, so the page can see what's
  there, verify it and remove it). A file that doesn't match is refused and
  nothing is kept.
- Every visit re-reads `versions.json` (no-store). If the saved release isn't the
  current one, the page says *out of date* and scoring is off until **Update**;
  older copies are deleted after a successful update. **Remove** deletes it.
- MediaPipe is loaded only from that saved copy: the bundle via `import()` of a
  blob URL, the WASM loader and binary as blob URLs (`wasmLoaderPath`,
  `wasmBinaryPath`), the models as `modelAssetBuffer`. Photos are 960 px Commons
  thumbnails loaded with `crossOrigin="anonymous"` (Wikimedia sends
  `Access-Control-Allow-Origin: *`); nothing leaves the browser.

### What it measures, and the trial rules

Every photo is assumed to show at least one face, so a measurement that can't
be made is **unknown (?)**, not a fail. Three steps (CPU delegate):

1. **Find faces two ways.** Face Landmarker on the whole photo (its built-in
   finder is BlazeFace *short-range*: sure of close-ups) at confidence ≥ **0.8**,
   and the full-range **Face Detector** (made for faces up to ~5 m) down to 0.3.
   A face counts when either is at ≥ 0.8; the best one is kept even below that,
   flagged "small, turned or partly covered?" (dashed box).
2. **Read the main face** (the largest): straight from the whole-photo result
   when the face model found it, else from a 512 px crop 2.2× the detector's
   box, at 0.8 and once more at 0.5 (shown). With several faces the card says
   the details are for the largest, which may not be the depicted person.
3. **Pose Landmarker lite** (`numPoses` 5, ≥ 0.8): framing, and — when step 2
   couldn't read the face — a rough head direction from the ears and nose.

Measured 2026-10-15 on Boots Riley's 9 photos: before, the face was missed on
two full-length shots; with steps 1–2, 8 of 9 were read (one from a 0.56
detection) and the ninth fell back to body points; 1.1 s for all 9.

For the main face: its height as a share of the
photo, head **turned / tipped / tilted** (yaw `asin(-R20)`, pitch
`atan2(R21, R22)`, roll `atan2(R10, R00)` from the column-major 4×4 matrix),
eyes open (`eyeBlinkLeft/Right`) and look-away (max of the eight `eyeLook*`
scores). Framing from the body points inside the photo (visibility ≥ 0.5):
ankles → full body, knees → three-quarter, hips → half body, shoulders → head &
shoulders; no body but a face ≥ 25% high → head & shoulders.

The seven checks (`CHECKS` in the page), 1 point each: exactly one face · face
≥ 20% of the photo's height · eyes open (blink < 0.5) · head turned and tipped
≤ 20° · eyes towards the camera (every eye-look < 0.5) · framing head &
shoulders or half body · ≥ 2 MP.

Plus **age points** (taken, else upload date): up to 6 months **+1** (new); up
to 12 months **+0.5** (fine only if the other checks pass); from 1 year the
points fall steadily to **−3.5** at 10 years; **10 years or older is always red**,
whatever the other checks say. Score = checks passed + age points, out of 8:
green ≥ 7, amber ≥ 4, red below. For a photo that passes all seven checks:

| Age | 6 months | 1 year | 2 years | 3 years | 5 years | 8 years | 10+ years |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| Score | 8 green | 7.5 green | 7.1 green | 6.6 amber | 5.7 amber | 4.4 amber | red |

Unknowns are shown, not counted.

**Two final results** head every card: **Generic photo** (good = the score above
is green; the total is rounded to one decimal *before* the colour is chosen) and
**Infobox** (good only when every `INFOBOX_CHECKS` entry passes): exactly one face
· face ≥ 30% of the height · head turned, tipped **and tilted** ≤ 15° (measured,
not estimated from body points) · blink < 0.4 · look-away < 0.35 · head &
shoulders · ≥ 2 MP (of the crop, when one is needed) · taken within 3 years.
Otherwise *potentially problematic*, with "fails: … · couldn't check: …".

**✂ Croppable** (`cropFor()`): when the face is under the needed share (20%
generic, 30% infobox) or the framing is too wide, a 4:5 portrait crop around the
face, sized so the face is that share of its height (face centre 38% down,
clamped to the photo), is computed in the original's pixels; if it is still ≥ 2
MP the check passes as "crop" (counts as passed; ✂ in the list) and the crop is
drawn as a dashed box. Order: infobox-good first, then generic-good, then 10+
years last, highest score, fewest unknowns, newest. Status line: "N good for an
infobox (M after a crop), K good as a generic photo". (Finder, gaps and history still use the flat
`STALE_MONTHS` = 12 rule.)

It detects faces and bodies; it does not recognise or identify anyone.

### Keeping the copy current

`scripts/sync-mediapipe.mjs` picks the newest stable npm release published at
least **14 days** ago (and models whose `Last-Modified` is at least 14 days
old), verifies the npm tarball against the registry's `integrity` (sha512), and
writes `vendor/mediapipe/<release>/` plus `versions.json`. The release id names
the parts, e.g. `tv-1.0.1_fd-20260311_fl-20230503_pl-20230427` (runtime 1.0.1,
full-range Face Detector of 2026-03-11, Face Landmarker of 2023-05-03, Pose
Landmarker of 2023-04-27). The weekly workflow
(`check-mediapipe.yml`, Wednesdays 05:41 UTC, or *Run workflow*) never touches
`main`: a newer release goes to branch `mediapipe-update/<release>` and an issue
assigned to Landsil links the comparison. Merging it updates the site; visitors
then see *out of date* until they press Update.

**Never automatically backwards.** `upgradeReason()` proposes a release only when
the runtime version is strictly newer (semver) or a model is newer or newly added.
Comparing release ids for mere inequality once let the weekly run "update"
1.1.1 → **1.1.0** (issue #2, 2026-10-21): 1.1.0 had just become the newest
release old enough to pass the 14-day bar, so it looked like a change. An
explicit `--version` may still move either way, deliberately.

**Taking a specific version now:** *Run workflow* with **version** (e.g.
`1.1.1`) skips the minimum age for the runtime only — an explicit choice, noted
in `versions.json` (`runtime.explicit`) and `NOTICE.md`. It still goes through
the branch + issue, and the npm integrity check.

History: the first copy (1.0.1, July 2026) was fetched on a maintainer's machine
whose security tool blocks npm packages published too recently to be vetted
(1.1.x, October 2026, was blocked there). 1.1.1 was then taken on 2026-10-15 by
an explicit *Run workflow* on GitHub's runner — not on that machine — to be
tested on another one. The 14-day minimum age keeps the automatic proposals in
the vetting spirit.

Licences: the runtime is Apache-2.0 (npm `license` field, and the MediaPipe
repository); the model cards (BlazeFace short- and full-range, Face Mesh V2, Blendshape V2,
BlazePose GHUM 3D) link the Apache License 2.0; their wording was read and checked by
the maintainer on 2026-10-15. `LICENSE` and `NOTICE.md` sit next to the files.

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
| `STALE_MONTHS` | 12 | Age at which a photo is flagged stale (finder, gaps, history; not the score page) |
| `NEW_MONTHS` / `FINE_MONTHS` / `BAD_YEARS` | 6 / 12 / 10 | (score) Age bands: new, fine if the rest passes, always bad |
| `AGE_POINTS_NEW` / `AGE_POINTS_FINE` / `AGE_POINTS_AT_BAD` | 1 / 0.5 / −3.5 | (score) Age points at those bands; linear between 1 and 10 years |
| `GOOD_SCORE` / `OK_SCORE` | 7 / 4 | (score) Totals out of 8 for green / amber |
| `INFOBOX_FACE_SHARE` / `INFOBOX_HEAD_DEG` / `INFOBOX_BLINK` / `INFOBOX_EYE_LOOK` / `INFOBOX_MAX_YEARS` | 0.30 / 15 / 0.4 / 0.35 / 3 | (score) The infobox standard |
| `CROP_ASPECT` / `CROP_FACE_Y` | 0.8 / 0.38 | (score) Suggested crop: 4:5, face centre 38% down |
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
