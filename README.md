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
| `gaps.html` | **Photo Gaps** — Wikipedia category → living people whose article has a missing/poor infobox photo |
| `style.css` | Shared styles for all three pages |

Each tool page embeds its own JS pipeline (they don't share a script), so a page
is independently openable. Deployed on GitHub Pages from `main` /root.

Everything is client-side. That has one consequence worth knowing: **browsers
forbid setting `User-Agent`**, so requests go out with the browser's UA plus
`&origin=*` rather than a descriptive tool UA. (An earlier local Python server,
`app.py`, sent a proper UA; it was retired once the browser build covered
everything.)


## Usage

Enter a Commons category, pick an upload-date window, hit **Search Candidates**.

- **Category** — with or without the `Category:` prefix. `normalize_category()`
  accepts spaces, underscores, `+` and `%20` in any casing and canonicalises to
  `Category:Name` (MediaWiki treats spaces and underscores as equivalent).
- **Start / End** — filters by **upload timestamp**. Defaults to the last three
  months (1st of the month two months back → end of the current month).
  **Previous month** / **This month** / **This year** prefill other ranges.
  Dates are formatted from local date parts, not `toISOString()`, which would
  roll the day back under timezones ahead of UTC (e.g. BST).

### URL parameters

The form can be prefilled from the query string, so searches are shareable:

```
?category=WikiPortraits_photos_by_John_Manard
?category=Photographs+by+Mateusz+Malta&start=2026-05-01&end=2026-07-31&search=1
```

- `category` — underscores/`+` become spaces. A `Category:` prefix is fine.
- `start`, `end` — `YYYY-MM-DD`; ignored (falling back to the default) if malformed.
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
| 1 | `fetch_category_files` | Commons `generator=categorymembers` + `prop=imageinfo` | paged via `continue`, `gcmlimit=max` |
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
50-item batching, generators, and a descriptive `User-Agent` from `app.py`.

There is no published SLA or typical-response-time figure for the Wikimedia
APIs; WDQS lag is tracked only on Grafana dashboards with no documented "normal"
value, so there is nothing meaningful to gate on anyway.

### Would an API key help?

Not really. Wikimedia has no read key; registering an account would only add
`apihighlimits` (batches 50 → 500), which for a typical search means 4 calls
instead of 8. For the static build it would mean either leaking a credential in
public source or forcing every visitor through an OAuth login.


## Photo Gaps pipeline (`gaps.html`)

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


## Tunables

At the top of each tool's `<script>`:

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


## Licence

See [LICENCE](LICENCE).
