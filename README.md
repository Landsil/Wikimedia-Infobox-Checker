# Wikimedia-Infobox-Checker
Checks photos in a category against current photo in infobox.


## If you want to use a local Python server: 

1. Grab app.py file
2. Install requests via ```pip install requests```
3. Run app with ```python3 app.py``` and access at http://localhost:8000/


## If you want you can also just go to the website and try it there
https://mb-malta.co.uk/Wikimedia-Infobox-Checker/

<img width="1153" height="1194" alt="Screenshot 2026-07-31 at 13 31 01" src="https://github.com/user-attachments/assets/38f24aae-7237-44e2-b17c-fba63feea376" />


## How to use it

Enter a Commons category (with or without the `Category:` prefix), pick an
upload-date window, and hit **Search Candidates**. The tool finds photos in that
category that are **not yet used in any Wikipedia article**, depict a **person**,
and pairs each against that person's **current Wikipedia infobox photo** so you
can compare the new candidate against what's live.

### Date buttons

- **Previous month** / **This month** / **This year** — prefill the start/end
  date fields to a common range. Dates filter by the file's **upload timestamp**.

### Filter toggles (appear after a search)

The search is run once, then these toggles filter the results instantly — no
re-search. The first two are **on** by default; the third is **off**.

- **Hide same-author candidates** — hides a candidate when its author is the
  same as the current infobox photo's author *and* that infobox photo is already
  good (see below). Rationale: if the same photographer already has a good live
  photo, another of theirs adds nothing. Author is matched by Commons user-page
  URL where possible, falling back to the display name.
- **Hide when current photo is good** — hides a match when the current infobox
  photo is already good, regardless of who took it (no need to replace it).
- **Show no-depicts photos** — an **exclusive** view: switches to showing *only*
  the unused category photos that have **no depicts statement at all** (the other
  two toggles are disabled while it's on). These have no subject to compare, so
  they're shown as a "needs a depicts statement added" worklist.

A photo counts as **"good"** when it is present, **not stale**, **not low-res**,
and its resolution is known. **Stale** = the photo was taken (falling back to
upload date) more than **12 months** ago. **Low-res** = under **2 megapixels**.
Stale dates and low resolutions are flagged in red with a ⚠ in the results.

### Row action buttons

- **Copy** (candidate side) — copies just the bare filename (no `File:` prefix)
  so you can paste it straight into an infobox `|image=` field.
- **Edit** (infobox side) — opens the person's Wikipedia article in the wikitext
  editor (`?action=edit`).

## How the links / URLs are built

- **Infobox photo** — the tool shows the image the article *actually displays*
  (via the MediaWiki `pageimages` API), not Wikidata's `P18`, because the two
  often diverge. `P18` is used only as a fallback when the article has no
  resolvable lead image.
- **Article / Edit links** — built from the person's Wikidata sitelink. English
  Wikipedia is preferred; otherwise the first available Wikipedia edition is
  used. The edit link is the article URL with `?action=edit`.

### No-depicts search links

For photos with no depicts statement, the right column offers phrase-search
links to help you find the person's Wikidata/Wikipedia entry. The name is
**guessed from the filename**:

- The filename is assumed to **start with the person's name**, and a **separator
  word** ends it. The separator list is `at` / `in` (e.g. `Hanna Flint at SXSW
  London 2026.jpg` → `Hanna Flint`), and is easy to extend via the
  `NAME_SEPARATORS` array.
- The `File:` prefix, extension, and any trailing sequence number (e.g. `... 2`)
  are stripped. If the result isn't at least two words it's discarded, so
  non-person subjects (e.g. `Waymo`) don't produce a bogus search.
- The links point at each wiki's `Special:Search` in **advanced, exact-phrase**
  mode — i.e. it searches for the quoted `"Hanna Flint"` as an adjacent phrase,
  restricted to the main (article) namespace.
