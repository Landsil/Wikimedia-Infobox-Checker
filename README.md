# Wikimedia-Infobox-Checker

Checks photos in a Wikimedia Commons category against the current photo in the
subject's Wikipedia infobox.

It finds photos in a category that are **not yet used in any Wikipedia article**
and **depict a person**, then pairs each with that person's **current Wikipedia
infobox photo** so you can judge whether the new photo is an improvement. It also
lists category photos that have **no depicts statement**, and ones that are
**already in use** as an infobox photo (with a lookup for the photo they replaced).

> This README is the developer-facing document: how it's built, which APIs it
> calls, and where the gotchas are. The in-app **About** button covers the same
> ground for someone who just wants to use the tool.


## Try it

**Website (no install):** https://mb-malta.co.uk/Wikimedia-Infobox-Checker/

**Local Python server:**

1. Grab `app.py`
2. Install requests: `pip install requests`
3. Run: `python3 app.py` (or `python3 app.py 9000` for another port) and open
   http://localhost:8000/

<img width="1153" height="1194" alt="Screenshot 2026-07-31 at 13 31 01" src="https://github.com/user-attachments/assets/38f24aae-7237-44e2-b17c-fba63feea376" />


## Two interfaces, one behaviour

| | `app.py` | `index.html` |
| :-- | :-- | :-- |
| Runs as | local `ThreadingHTTPServer` (stdlib only + `requests`) | static page, no server |
| Pipeline runs | in Python, on the server | in the browser, via `fetch` |
| Talks to APIs | `requests.Session`, custom `User-Agent` | `fetch` + `&origin=*` (anonymous CORS) |
| Endpoints | `GET /`, `POST /api/search`, `POST /api/previous-photo` | none |
| Hosted at | localhost | GitHub Pages |

They are **not** the same file: `app.py` embeds a thin client (`INDEX_HTML`) that
POSTs to its own endpoints, while `index.html` embeds the whole pipeline. Both
share the same UI, CSS, render helpers, filter logic and thresholds.

**When changing pipeline logic or the frontend, update both.** The shared surface
must stay in sync; only the transport layer differs.

Browsers forbid setting `User-Agent`, so the static build can't send the
descriptive UA that `app.py` does — a documented limitation, not a bug.


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
| Hide same-author candidates | on | Hides a candidate when the current infobox photo is by the same author **and** is already good |
| Hide when current photo is good | on | Hides a match when the infobox photo is already good, whoever took it |
| Show no-depicts photos | off | **Exclusive view**: only unused photos with no `P180` |
| Show category photos already in use | off | **Exclusive view**: only category photos that *are* an article's current infobox photo |

The two exclusive views replace the comparison results and disable the other
toggles (and each other). Author matching prefers the Commons **user-page URL**
over the display name, because display names differ from usernames.

Note that "hide same-author" is a strict subset of "hide when current photo is
good" (it only fires when the current photo is good). Its value is letting you
hide *your own* redundant duplicates while keeping good photos by *other*
photographers visible — turn the second toggle off, first on.

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


## Pipeline

`run_search()` / `runSearch()` in order. Each step feeds the next a shrinking set.

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

On the already-in-use view, the button walks the article's revision history
**on click** (it's the expensive call, so it stays out of the main search):

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

For photos with no depicts statement, the right column offers phrase-search links
to help find the person's entry. The name is **guessed from the filename**:

- The filename is assumed to **start with the name**, and a **separator word**
  ends it — `NAME_SEPARATORS` = `at` / `in`, easy to extend
  (`Hanna Flint at SXSW London 2026.jpg` → `Hanna Flint`).
- The `File:` prefix, extension and any trailing sequence number are stripped.
  A result under two words is discarded, so `Waymo` produces no bogus search.
- Links target each wiki's `Special:Search` in **advanced, exact-phrase** mode:
  the quoted `"Hanna Flint"` as an adjacent phrase, restricted to namespace 0.


## Rate limiting and reliability

All calls go through `api_get()` / `apiGet()`, which sends `maxlag=5` so
MediaWiki sheds load rather than straining lagged replicas, and retries with
backoff (`MAX_RETRIES` = 6, honouring `Retry-After`).

**A `maxlag` throttle is HTTP 200, not a 5xx.** The body is
`{"error": {"code": "maxlag"}}` with no data. Retrying only on status codes means
a lagged replica silently returns *zero results that look like a legitimate
"nothing found"* — so the body is inspected, and on exhaustion the code **raises**
rather than returning an empty response. If a search reports that the wiki is
busy, Wikidata is lagging; wait and retry.

An API key wouldn't help much. Wikimedia has no read key; registering an account
would only add `apihighlimits` (batches 50 → 500), which for a typical search
means 8 calls instead of 4. It wouldn't affect maxlag throttling at all, and for
the static build it would mean either leaking a credential in public source or
forcing every visitor through an OAuth login.


## Tunables

All at the top of `app.py`, mirrored in `index.html`:

| Constant | Value | Meaning |
| :-- | :-- | :-- |
| `BATCH` | 50 | Items per `titles=`/`ids=` request (non-bot cap) |
| `THUMB_WIDTH` | 320 | Requested thumbnail width |
| `STALE_MONTHS` | 12 | Age at which a photo is flagged stale |
| `LOW_RES_MP` | 2.0 | Megapixels below which resolution is flagged |
| `MAX_RETRIES` | 6 | Attempts per request before aborting |
| `MAXLAG` | 5 | Replica lag threshold (seconds) |
| `HISTORY_REV_LIMIT` | 50 | Revisions fetched per history lookup |
| `MAX_BODY_BYTES` | 64 KiB | `app.py` request-body cap |

`app.py` also validates the `Host` header and rejects cross-origin POSTs, since
it binds loopback but the `Host` header is attacker-controllable (DNS rebinding).


## Licence

See [LICENCE](LICENCE).
