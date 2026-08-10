#!/usr/bin/env python3
"""
Wikimedia Infobox Finder
========================
Finds recently-uploaded, *unused* photos in a Wikimedia Commons category that
depict a subject (via Structured Data "depicts", P180), and pairs each against
the depicted person's current Wikipedia infobox photo (Wikidata P18) for
side-by-side comparison. Useful for spotting fresh portraits that could replace
a stale infobox image.

--------------------------------------------------------------------------------
USAGE
--------------------------------------------------------------------------------
Requirements:  Python 3.8+ and the `requests` library.

    pip install requests

Run the server:

    python3 app.py            # serves on http://localhost:8000/
    python3 app.py 9000       # or pick a port

Then open the printed URL in a browser and fill in the form:
  - Category:  a Commons category name, with or without the "Category:" prefix
               (e.g. "Photographs by Mateusz Malta").
  - Start/End: upload-date window. Defaults to the last three months; the
               "Previous month" / "This month" / "This year" buttons prefill
               other common ranges.

The tool lists each unused candidate photo beside the subject's current infobox
photo. Everything runs locally; no data leaves your machine except the read-only
API calls to Wikimedia. Stop the server with Ctrl+C.
"""

import html
import json
import re
import sys
import time
import traceback
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import quote, unquote_plus, urlsplit

import requests

COMMONS_API = "https://commons.wikimedia.org/w/api.php"
WIKIDATA_API = "https://www.wikidata.org/w/api.php"

HEADERS = {
    "User-Agent": (
        "WikimediaInfoboxChecker/1.0 "
        "(https://github.com/Landsil/Wikimedia-Infobox-Checker; photo@landsil.net)"
    )
}

BATCH = 50  # titles=/ids= are capped at 50 per request for non-bot clients
THUMB_WIDTH = 320
MAX_BODY_BYTES = 64 * 1024  # a search payload is a few hundred bytes; cap hard
# Loopback hostnames we answer to. The server binds 127.0.0.1, but the Host
# header is attacker-controllable (DNS rebinding), so we still validate it and
# reject cross-origin POSTs (CSRF) rather than trusting the bind address alone.
LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}
STALE_MONTHS = 12          # infobox photo flagged red when older than this
LOW_RES_MP = 2.0           # infobox/candidate resolution flagged red below this (megapixels)
NON_WIKIPEDIA_WIKIS = {
    "commonswiki", "wikidatawiki", "specieswiki", "metawiki",
    "mediawikiwiki", "incubatorwiki", "sourceswiki", "foundationwiki",
    "outreachwiki", "wikimaniawiki", "testwiki",
}

SESSION = requests.Session()
SESSION.headers.update(HEADERS)

MAX_RETRIES = 6           # attempts per request before giving up
BACKOFF_BASE = 1.0        # seconds; doubled each retry when no Retry-After given


def api_get(base, params):
    # Wrap SESSION.get with retry/backoff on genuine throttling (429/503) and on
    # connection/timeout errors.
    #
    # Deliberately NO maxlag parameter. MediaWiki's guidance is that maxlag is
    # for non-interactive work: "Interactive tasks (where a user is waiting for
    # the result) may omit the maxlag parameter. Noninteractive tasks should
    # always use it." (Manual:Maxlag_parameter, API:Etiquette.) Someone is
    # sitting here waiting for a search, and reads have no hard rate limit --
    # meta=userinfo&uiprop=ratelimits lists only writes/expensive actions, none
    # for reads. Sending maxlag=5 made us refuse requests the servers were happy
    # to serve: it also trips on Wikidata Query Service lag (host wdqs*), which
    # this tool never queries, so a degraded SPARQL node blocked plain entity
    # reads while the databases themselves were under a second behind.
    #
    # Etiquette for reads is still followed: serial (not parallel) requests,
    # 50-item batching, generators, and a descriptive User-Agent.
    for attempt in range(MAX_RETRIES):
        try:
            resp = SESSION.get(base, params=params, timeout=30)
        except (requests.ConnectionError, requests.Timeout):
            if attempt < MAX_RETRIES - 1:
                time.sleep(BACKOFF_BASE * 2 ** attempt)
                continue
            raise

        if resp.status_code in (429, 503):
            if attempt < MAX_RETRIES - 1:
                time.sleep(retry_delay(resp, attempt))
                continue
            raise RuntimeError(
                f"MediaWiki still rate-limiting after {MAX_RETRIES} attempts "
                f"({base}); aborting rather than returning partial results."
            )

        resp.raise_for_status()
        return resp


def retry_delay(resp, attempt):
    retry_after = resp.headers.get("Retry-After")
    if retry_after and retry_after.isdigit():
        return float(retry_after)
    return BACKOFF_BASE * 2 ** attempt


def chunked(seq, size=BATCH):
    for i in range(0, len(seq), size):
        yield seq[i:i + size]


def strip_html(value):
    if not value:
        return ""
    text = re.sub(r"<[^>]+>", " ", str(value))
    text = html.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def normalize_category(raw):
    # Accept any spelling: spaces, underscores, "+", "%20", and an optional
    # "Category:" prefix in any casing. MediaWiki treats spaces/underscores as
    # equivalent in titles; canonicalize to a spaced "Category:Name".
    name = unquote_plus(raw).replace("_", " ").strip()
    if not name:
        raise ValueError("category is required")
    if name.lower().startswith("category:"):
        name = name[len("category:"):].strip()
    return "Category:" + name


def normalize_bounds(start_date, end_date):
    # Input dates are date-only; imageinfo.timestamp is a full ISO instant.
    # Append time bounds so string comparison is correct and end date is
    # inclusive of its whole day.
    start = f"{start_date}T00:00:00Z" if start_date else None
    end = f"{end_date}T23:59:59Z" if end_date else None
    return start, end


def in_range(timestamp, start, end):
    if start and timestamp < start:
        return False
    if end and timestamp > end:
        return False
    return True


def mw_query(base, params):
    # Runs action=query, following the `continue` protocol across pages.
    params = dict(params)
    params["action"] = "query"
    params["format"] = "json"
    while True:
        resp = api_get(base, params)
        data = resp.json()
        if "query" in data:
            yield data["query"]
        if "continue" in data:
            params.update(data["continue"])
        else:
            break


def wbgetentities(base, ids, props, extra=None):
    params = {
        "action": "wbgetentities",
        "format": "json",
        "ids": "|".join(ids),
        "props": props,
    }
    if extra:
        params.update(extra)
    resp = api_get(base, params)
    return resp.json().get("entities", {})


def parse_author(artist_html):
    # extmetadata's Artist is raw HTML that usually wraps the uploader's name in
    # a link to their Commons user page. The display name ("Bryan Berlin") often
    # differs from the username ("Berlination"), so take the URL from the first
    # anchor rather than deriving it from the name. Returns (name, url).
    if not artist_html:
        return "", None
    m = re.search(r'<a\b[^>]*\bhref="([^"]+)"[^>]*>(.*?)</a>', artist_html,
                  re.IGNORECASE | re.DOTALL)
    if m:
        href, inner = m.group(1), strip_html(m.group(2))
        href = sanitize_href(href)
        return inner or strip_html(artist_html), href
    return strip_html(artist_html), None


def sanitize_href(href):
    # extmetadata Artist is raw HTML from Commons; don't trust the href scheme.
    # Rewrite protocol-relative/site-relative forms to absolute https, allow
    # only http(s), and drop anything else (javascript:, data:, ...) so the
    # client never renders a hostile link. Returns a safe URL or None.
    href = html.unescape((href or "").strip())
    if href.startswith("//"):
        return "https:" + href
    if href.startswith("/"):
        return "https://commons.wikimedia.org" + href
    if re.match(r"https?://", href, re.IGNORECASE):
        return href
    return None


def extract_imageinfo_meta(info):
    # DateTimeOriginal is unreliable, so fall back to the upload timestamp.
    ext = info.get("extmetadata", {}) or {}
    uploaded = info.get("timestamp", "")
    taken = strip_html(ext.get("DateTimeOriginal", {}).get("value")) or uploaded
    author, author_url = parse_author(ext.get("Artist", {}).get("value"))
    width = info.get("width")
    height = info.get("height")
    return {
        "taken": taken,
        "uploaded": uploaded,
        "description": strip_html(ext.get("ImageDescription", {}).get("value")),
        "author": author,
        "author_url": author_url,
        "width": width,
        "height": height,
        "megapixels": round(width * height / 1_000_000, 1) if width and height else None,
    }


def parse_ts(value):
    # Accept ISO instants ("2011-03-14T12:00:00Z") and the date-only form that
    # extmetadata's DateTimeOriginal sometimes carries ("2011-03-14").
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        pass
    m = re.search(r"(\d{4})-(\d{2})-(\d{2})", value)
    if m:
        return datetime(int(m[1]), int(m[2]), int(m[3]), tzinfo=timezone.utc)
    return None


def is_stale(taken, uploaded, now):
    # Age off "date taken" (falling back to upload date), flagged when older
    # than STALE_MONTHS. now is passed in so the whole response uses one clock.
    when = parse_ts(taken) or parse_ts(uploaded)
    if not when:
        return False
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    return when < now - timedelta(days=365.25 / 12 * STALE_MONTHS)


def pick_wikipedia_sitelink(sitelinks):
    # Prefer enwiki, else the first Wikipedia language edition present.
    if not sitelinks:
        return None, None
    if "enwiki" in sitelinks:
        return "enwiki", sitelinks["enwiki"]["title"]
    for site, link in sitelinks.items():
        if site.endswith("wiki") and site not in NON_WIKIPEDIA_WIKIS:
            return site, link["title"]
    return None, None


def wiki_lang(site):
    return site[:-4].replace("_", "-")  # "enwiki" -> "en"


def wikipedia_article_url(site, title):
    return f"https://{wiki_lang(site)}.wikipedia.org/wiki/{quote(title.replace(' ', '_'))}"


def wikipedia_edit_url(site, title):
    return (f"https://{wiki_lang(site)}.wikipedia.org/w/index.php"
            f"?title={quote(title.replace(' ', '_'))}&action=edit")


def wikipedia_api_url(site):
    return f"https://{wiki_lang(site)}.wikipedia.org/w/api.php"


def fetch_article_lead_images(articles):
    # The image an article actually displays is often set locally in wikitext
    # and diverges from Wikidata P18. pageimages returns the real lead/infobox
    # image. `articles` is a list of (site, title); returns {(site, title):
    # commons_filename or None}, grouped and batched per wiki.
    by_site = {}
    for site, title in articles:
        by_site.setdefault(site, set()).add(title)

    lead = {}
    for site, titles in by_site.items():
        api = wikipedia_api_url(site)
        for batch in chunked(sorted(titles)):
            params = {
                "titles": "|".join(batch),
                "prop": "pageimages",
                "piprop": "name",
                "pilicense": "any",
                "redirects": 1,
            }
            # Map any title normalization/redirects back to our requested title.
            alias = {}
            for query in mw_query(api, params):
                for entry in query.get("normalized", []):
                    alias[entry["to"]] = entry["from"]
                for entry in query.get("redirects", []):
                    alias[entry["to"]] = alias.get(entry["from"], entry["from"])
                for page in query.get("pages", {}).values():
                    requested = alias.get(page["title"], page["title"])
                    name = page.get("pageimage")
                    # pageimage uses underscores; Commons titles use spaces.
                    lead[(site, requested)] = (
                        "File:" + name.replace("_", " ") if name else None
                    )
    return lead


def fetch_category_files(category, start, end):
    # generator=categorymembers + prop=imageinfo returns imageinfo in the same
    # paged call. Filter to the upload timeframe.
    params = {
        "generator": "categorymembers",
        "gcmtitle": category,
        "gcmtype": "file",
        "gcmlimit": "max",
        "prop": "imageinfo",
        "iiprop": "timestamp|url|extmetadata|user|size",
        "iiurlwidth": THUMB_WIDTH,
    }
    files = {}
    for query in mw_query(COMMONS_API, params):
        for page in query.get("pages", {}).values():
            infos = page.get("imageinfo")
            if not infos:
                continue
            info = infos[0]
            ts = info.get("timestamp", "")
            if not in_range(ts, start, end):
                continue
            meta = extract_imageinfo_meta(info)
            pageid = page["pageid"]
            files[pageid] = {
                "pageid": pageid,
                "title": page["title"],
                "timestamp": meta["uploaded"],
                "descriptionurl": info.get("descriptionurl", ""),
                "thumb": info.get("thumburl") or info.get("url", ""),
                "taken": meta["taken"],
                "description": meta["description"],
                "author": meta["author"],
                "author_url": meta["author_url"],
                "width": meta["width"],
                "height": meta["height"],
                "megapixels": meta["megapixels"],
            }
    return files


def wikipedia_site_from_host(host):
    # "en.wikipedia.org" -> "enwiki". Returns None for non-Wikipedia projects
    # (wikiquote/wikisource/...), which globalusage also reports.
    parts = (host or "").split(".")
    if len(parts) < 2 or parts[1] != "wikipedia":
        return None
    return parts[0].replace("-", "_") + "wiki"


def filter_unused(files):
    # Split by article usage. Returns (unused, used_usages) where used_usages
    # maps a file title -> list of (site, article_title) it is used on. The
    # article title comes free with guprop=url, and the used bucket powers the
    # "category photo is the current infobox photo" view.
    titles = [f["title"] for f in files.values()]
    used_usages = {}
    for batch in chunked(titles):
        params = {
            "titles": "|".join(batch),
            "prop": "globalusage",
            "guprop": "namespace|url",
            "gulimit": "max",
        }
        for query in mw_query(COMMONS_API, params):
            for page in query.get("pages", {}).values():
                for usage in page.get("globalusage", []):
                    if str(usage.get("ns")) != "0":
                        continue
                    site = wikipedia_site_from_host(usage.get("wiki"))
                    if not site:
                        continue
                    article = (usage.get("title") or "").replace("_", " ")
                    entry = (site, article)
                    lst = used_usages.setdefault(page["title"], [])
                    if entry not in lst:
                        lst.append(entry)
    unused = {pid: f for pid, f in files.items() if f["title"] not in used_usages}
    return unused, used_usages


def find_current_photos(files, used_usages, now):
    # Category photos that ARE an article's current lead image. For every
    # (file, article) usage, compare the article's actual lead image
    # (pageimages) against the file; a match means this photo is live there.
    # One entry per (file, article) — a photo can be current on several wikis,
    # and each wiki has its own edit history.
    by_title = {f["title"]: f for f in files.values()}
    articles = sorted({a for lst in used_usages.values() for a in lst})
    lead = fetch_article_lead_images(articles)

    current = []
    for ftitle, usages in used_usages.items():
        f = by_title.get(ftitle)
        if not f:
            continue
        for site, article in usages:
            if lead.get((site, article)) != ftitle:
                continue
            current.append({
                "title": f["title"],
                "file_page": f["descriptionurl"],
                "thumb": f["thumb"],
                "date_taken": f["taken"],
                "date_uploaded": f["timestamp"],
                "description": f["description"],
                "author": f["author"],
                "author_url": f["author_url"],
                "width": f["width"],
                "height": f["height"],
                "megapixels": f["megapixels"],
                "low_res": f["megapixels"] is not None and f["megapixels"] < LOW_RES_MP,
                "stale": is_stale(f["taken"], f["timestamp"], now),
                "wiki_site": site,
                "wiki_article_title": article,
                "wiki_article_url": wikipedia_article_url(site, article),
                "wiki_edit_url": wikipedia_edit_url(site, article),
                "wiki_history_api": wikipedia_api_url(site),
            })
    current.sort(key=lambda c: c["date_uploaded"], reverse=True)
    return current


def attach_depicts(files):
    # A Commons file's Structured Data entity id is "M" + pageid. Split the
    # unused files into those carrying at least one P180 (depicts) statement
    # (recording every depicted Q-id) and those with none. The SDC claims for
    # every file are fetched here regardless, so the no-depicts bucket is free.
    # Returns (kept, no_depicts) — no_depicts photos need a depicts statement
    # added and have no subject to compare against.
    by_mid = {"M" + str(f["pageid"]): f for f in files.values()}
    kept = {}
    no_depicts = {}
    for batch in chunked(list(by_mid.keys())):
        entities = wbgetentities(COMMONS_API, batch, props="claims")
        for mid, entity in entities.items():
            f = by_mid.get(mid)
            if not f:
                continue
            # Commons MediaInfo entities nest claims under "statements"
            # (Wikidata items use "claims"); accept either.
            statements = entity.get("statements") or entity.get("claims", {})
            qids = all_depicts_qids(statements)
            if qids:
                f["depicted_qids"] = qids
                kept[f["pageid"]] = f
            else:
                no_depicts[f["pageid"]] = f
    return kept, no_depicts


def all_depicts_qids(claims):
    qids = []
    for statement in claims.get("P180", []):
        try:
            qid = statement["mainsnak"]["datavalue"]["value"].get("id")
            if qid and qid not in qids:
                qids.append(qid)
        except (KeyError, TypeError):
            continue
    return qids


def is_human(claims):
    # A depicted entity is a person iff its P31 (instance of) includes Q5.
    for statement in claims.get("P31", []):
        try:
            if statement["mainsnak"]["datavalue"]["value"].get("id") == "Q5":
                return True
        except (KeyError, TypeError):
            continue
    return False


def fetch_person_data(files):
    # For every depicted entity: check P31 for human (Q5), and for humans keep
    # label, best Wikipedia sitelink, and current P18 image. Non-human entities
    # are recorded as such so run_search can drop files that depict no person.
    qids = sorted({q for f in files.values() for q in f["depicted_qids"]})
    persons = {}

    for batch in chunked(qids):
        entities = wbgetentities(
            WIKIDATA_API, batch,
            props="claims|sitelinks|labels",
            extra={"languages": "en"},
        )
        for qid, entity in entities.items():
            claims = entity.get("claims", {})
            human = is_human(claims)
            persons[qid] = {"human": human}
            if not human:
                continue
            site, article_title = pick_wikipedia_sitelink(
                entity.get("sitelinks", {})
            )
            persons[qid].update({
                "label": entity.get("labels", {}).get("en", {}).get("value") or qid,
                "p18": first_p18_filename(claims),
                "site": site,
                "article_title": article_title,
            })

    # The infobox image is whatever the article actually displays (via
    # pageimages), which often diverges from Wikidata P18. Fall back to P18
    # only when the article has no resolvable lead image.
    articles = [
        (p["site"], p["article_title"])
        for p in persons.values()
        if p.get("human") and p.get("site") and p.get("article_title")
    ]
    lead = fetch_article_lead_images(articles)

    infobox_files = set()
    for p in persons.values():
        if not p.get("human"):
            continue
        image = None
        if p.get("site") and p.get("article_title"):
            image = lead.get((p["site"], p["article_title"]))
        if not image and p.get("p18"):
            image = "File:" + p["p18"]
        p["infobox_file"] = image
        if image:
            infobox_files.add(image)

    infobox_info = fetch_files_imageinfo(sorted(infobox_files))
    return persons, infobox_info


def first_p18_filename(claims):
    for statement in claims.get("P18", []):
        try:
            filename = statement["mainsnak"]["datavalue"]["value"]
            if filename:
                return filename
        except (KeyError, TypeError):
            continue
    return None


def fetch_files_imageinfo(titles):
    result = {}
    for batch in chunked(titles):
        params = {
            "titles": "|".join(batch),
            "prop": "imageinfo",
            "iiprop": "timestamp|url|extmetadata|user|size",
            "iiurlwidth": THUMB_WIDTH,
        }
        for query in mw_query(COMMONS_API, params):
            for page in query.get("pages", {}).values():
                infos = page.get("imageinfo")
                if not infos:
                    continue
                info = infos[0]
                meta = extract_imageinfo_meta(info)
                result[page["title"]] = {
                    "title": page["title"],
                    "descriptionurl": info.get("descriptionurl", ""),
                    "thumb": info.get("thumburl") or info.get("url", ""),
                    "taken": meta["taken"],
                    "timestamp": meta["uploaded"],
                    "description": meta["description"],
                    "author": meta["author"],
                    "author_url": meta["author_url"],
                    "width": meta["width"],
                    "height": meta["height"],
                    "megapixels": meta["megapixels"],
                }
    return result


INFOBOX_IMAGE_PARAM = re.compile(
    r"\|\s*(?:image|image_name|photo|img)\s*=\s*([^\n|}]+)", re.IGNORECASE)
HISTORY_REV_LIMIT = 50   # revisions per request when content is needed


def infobox_image_in_wikitext(text):
    m = INFOBOX_IMAGE_PARAM.search(text or "")
    if not m:
        return None
    name = m.group(1).strip()
    # Strip a leading "File:"/"Image:" prefix if the param carries one.
    name = re.sub(r"^\s*(?:File|Image)\s*:\s*", "", name, flags=re.IGNORECASE)
    return name or None


def find_previous_photo(site, article, current_author_url, current_author):
    # Walk the article's revisions (newest -> older), extracting the infobox
    # image from each, and return the first EARLIER image whose author differs
    # from the current photo's. The revision that introduced a value is the
    # NEWER of an adjacent pair, so a change between revs[i] and revs[i+1] means
    # revs[i] introduced revs[i]'s image and revs[i+1] still had the older one.
    api = wikipedia_api_url(site)
    params = {
        "prop": "revisions",
        "titles": article,
        "rvprop": "ids|timestamp|user|comment|content",
        "rvslots": "main",
        "rvlimit": str(HISTORY_REV_LIMIT),
        "rvdir": "older",
    }
    revs = []
    for query in mw_query(api, params):
        for page in query.get("pages", {}).values():
            revs.extend(page.get("revisions", []))
        break        # one page of revisions is enough for the common case

    def image_of(rev):
        return infobox_image_in_wikitext(
            (rev.get("slots", {}).get("main", {}) or {}).get("*", ""))

    # Distinct image values, newest first. Walking newest -> older, a run of
    # revisions shares one image value; the revision that INTRODUCED that value
    # is the newest one in the run (the older ones merely still carry it), so
    # keep overwriting `intro` as we walk deeper into the same run.
    timeline = []
    for rev in revs:
        img = image_of(rev)
        if not img:
            continue
        if not timeline or timeline[-1]["image"] != img:
            timeline.append({"image": img, "intro": rev})
        else:
            pass          # same value, older revision: intro stays the newest
    # Flatten to the fields we need.
    timeline = [{
        "image": t["image"],
        "revid": t["intro"].get("revid"),
        "timestamp": t["intro"].get("timestamp"),
        "user": t["intro"].get("user"),
        "comment": t["intro"].get("comment", ""),
    } for t in timeline]

    if len(timeline) < 2:
        return {"found": False,
                "reason": "No earlier infobox photo found in the last "
                          f"{HISTORY_REV_LIMIT} revisions."}

    # Look at each earlier distinct image and keep the first by a different author.
    cur_id = current_author_url or current_author
    candidates = ["File:" + t["image"] for t in timeline[1:]]
    info = fetch_files_imageinfo(candidates)
    for t in timeline[1:]:
        meta = info.get("File:" + t["image"])
        if not meta:
            continue
        other_id = meta["author_url"] or meta["author"]
        if cur_id and other_id and other_id == cur_id:
            continue                      # same author, keep looking further back
        replaced_by = timeline[timeline.index(t) - 1]
        return {
            "found": True,
            "title": meta["title"],
            "file_page": meta["descriptionurl"],
            "thumb": meta["thumb"],
            "date_taken": meta["taken"],
            "date_uploaded": meta["timestamp"],
            "description": meta["description"],
            "author": meta["author"],
            "author_url": meta["author_url"],
            "width": meta["width"],
            "height": meta["height"],
            "megapixels": meta["megapixels"],
            "low_res": meta["megapixels"] is not None
                       and meta["megapixels"] < LOW_RES_MP,
            # When/by whom it stopped being the infobox photo.
            "replaced_on": replaced_by["timestamp"],
            "replaced_by_user": replaced_by["user"],
            "replaced_comment": replaced_by["comment"],
            "diff_url": (f"https://{wiki_lang(site)}.wikipedia.org/w/index.php"
                         f"?diff={replaced_by['revid']}"),
        }

    return {"found": False,
            "reason": "Every earlier infobox photo in the last "
                      f"{HISTORY_REV_LIMIT} revisions is by the same author."}


def run_search(category, start_date, end_date):
    start, end = normalize_bounds(start_date, end_date)
    now = datetime.now(timezone.utc)

    all_files = fetch_category_files(category, start, end)
    files, used_usages = filter_unused(all_files)
    current_photos = find_current_photos(all_files, used_usages, now)
    files, no_depicts_files = attach_depicts(files)
    persons, infobox_info = fetch_person_data(files)

    results = []
    for f in files.values():
        # Pick the depicted entity that is actually a person; skip files whose
        # depicts are all non-human (companies, vehicles, logos, etc.).
        qid = next(
            (q for q in f["depicted_qids"] if persons.get(q, {}).get("human")),
            None,
        )
        if not qid:
            continue
        person = persons.get(qid, {})

        candidate = {
            "title": f["title"],
            "file_page": f["descriptionurl"],
            "thumb": f["thumb"],
            "depicted_label": person.get("label", qid),
            "depicted_qid": qid,
            "wikidata_url": f"https://www.wikidata.org/wiki/{qid}",
            "date_taken": f["taken"],
            "date_uploaded": f["timestamp"],
            "description": f["description"],
            "author": f["author"],
            "author_url": f["author_url"],
            "width": f["width"],
            "height": f["height"],
            "megapixels": f["megapixels"],
            "low_res": f["megapixels"] is not None and f["megapixels"] < LOW_RES_MP,
        }

        infobox_file = person.get("infobox_file")
        info = infobox_info.get(infobox_file) if infobox_file else None
        site = person.get("site")
        article_title = person.get("article_title")
        infobox = {
            "has_image": bool(info),
            "title": info["title"] if info else None,
            "file_page": info["descriptionurl"] if info else None,
            "thumb": info["thumb"] if info else None,
            "wiki_article_title": article_title,
            "wiki_article_url": (
                wikipedia_article_url(site, article_title)
                if site and article_title else None
            ),
            "wiki_edit_url": (
                wikipedia_edit_url(site, article_title)
                if site and article_title else None
            ),
            "wiki_site": site,
            "date_taken": info["taken"] if info else None,
            "date_uploaded": info["timestamp"] if info else None,
            "description": info["description"] if info else None,
            "author": info["author"] if info else None,
            "author_url": info["author_url"] if info else None,
            "width": info["width"] if info else None,
            "height": info["height"] if info else None,
            "megapixels": info["megapixels"] if info else None,
            # Flags for the current infobox photo: red if stale (>12m) or low-res.
            "stale": bool(info) and is_stale(info["taken"], info["timestamp"], now),
            "low_res": bool(info) and info["megapixels"] is not None
                       and info["megapixels"] < LOW_RES_MP,
        }

        results.append({"candidate": candidate, "infobox": infobox})

    results.sort(key=lambda r: r["candidate"]["date_uploaded"], reverse=True)

    # Unused files with no depicts statement at all: no subject to compare, so
    # they're returned as a flat list (a "needs a depicts statement" worklist).
    no_depicts = [
        {
            "title": f["title"],
            "file_page": f["descriptionurl"],
            "thumb": f["thumb"],
            "date_taken": f["taken"],
            "date_uploaded": f["timestamp"],
            "description": f["description"],
            "author": f["author"],
            "author_url": f["author_url"],
            "width": f["width"],
            "height": f["height"],
            "megapixels": f["megapixels"],
        }
        for f in no_depicts_files.values()
    ]
    no_depicts.sort(key=lambda f: f["date_uploaded"], reverse=True)

    return {
        "results": results,
        "no_depicts": no_depicts,
        "current_photos": current_photos,
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _send(self, code, body, content_type):
        payload = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _host_ok(self):
        # Reject requests whose Host isn't loopback. Defends against DNS
        # rebinding, where a malicious page resolves its own domain to
        # 127.0.0.1 to reach this server; the browser then sends that domain
        # as Host. Strip the optional :port before comparing.
        host = self.headers.get("Host", "").rsplit(":", 1)[0].strip("[]").lower()
        return host in LOCAL_HOSTS

    def _origin_ok(self):
        # CSRF guard for state-changing/expensive POSTs: if an Origin header is
        # present (browsers set it on cross-origin and same-origin POSTs), its
        # host must be loopback. Non-browser clients (curl) send none; allow.
        origin = self.headers.get("Origin")
        if not origin:
            return True
        try:
            host = urlsplit(origin).hostname or ""
        except ValueError:
            return False
        return host.lower() in LOCAL_HOSTS

    def do_GET(self):
        if not self._host_ok():
            self._send(403, "Forbidden", "text/plain; charset=utf-8")
            return
        # Compare the path only: "/?category=..." must still serve the page, since
        # the client reads those query params to prefill the form.
        path = urlsplit(self.path).path or "/"
        if path in ("/", "/index.html"):
            self._send(200, INDEX_HTML, "text/html; charset=utf-8")
        else:
            self._send(404, "Not found", "text/plain; charset=utf-8")

    def do_POST(self):
        if not self._host_ok() or not self._origin_ok():
            self._send(403, json.dumps({"error": "Forbidden"}), "application/json")
            return
        if self.path not in ("/api/search", "/api/previous-photo"):
            self._send(404, json.dumps({"error": "Not found"}),
                       "application/json")
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            self._send(400, json.dumps({"error": "Invalid Content-Length"}),
                       "application/json")
            return
        if length < 0 or length > MAX_BODY_BYTES:
            self._send(413, json.dumps({"error": "Request body too large"}),
                       "application/json")
            return
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            self._send(400, json.dumps({"error": "Invalid JSON body"}),
                       "application/json")
            return
        if not isinstance(payload, dict):
            self._send(400, json.dumps({"error": "JSON body must be an object"}),
                       "application/json")
            return

        if self.path == "/api/previous-photo":
            site = payload.get("wiki_site") or ""
            article = payload.get("wiki_article_title") or ""
            if not site or not article:
                self._send(400, json.dumps(
                    {"error": "wiki_site and wiki_article_title are required"}),
                    "application/json")
                return
            try:
                found = find_previous_photo(
                    site, article,
                    payload.get("author_url"), payload.get("author"))
                self._send(200, json.dumps(found), "application/json")
            except Exception:
                self.log_message("previous-photo failed: %s", traceback.format_exc())
                self._send(500, json.dumps({"error": "Internal server error"}),
                           "application/json")
            return

        try:
            category = normalize_category(payload.get("category") or "")
        except ValueError as exc:
            # normalize_category raises with our own text ("category is
            # required"), so it's safe to surface verbatim.
            self._send(400, json.dumps({"error": str(exc)}), "application/json")
            return
        try:
            search = run_search(
                category,
                payload.get("start_date", ""),
                payload.get("end_date", ""),
            )
            self._send(200, json.dumps({
                "results": search["results"],
                "count": len(search["results"]),
                "no_depicts": search["no_depicts"],
                "no_depicts_count": len(search["no_depicts"]),
                "current_photos": search["current_photos"],
                "current_photos_count": len(search["current_photos"]),
            }), "application/json")
        except Exception:
            # Unexpected failure (e.g. an upstream API error): log the detail
            # server-side, return a generic message so internals (paths,
            # library errors) don't leak to the client.
            self.log_message("search failed: %s", traceback.format_exc())
            self._send(500, json.dumps({"error": "Internal server error"}),
                       "application/json")


INDEX_HTML = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Wikimedia Infobox Finder</title>
<style>
  :root {
    --bg: #f6f7f9; --panel: #fff; --ink: #1c1e21; --muted: #6b7178;
    --line: #dfe3e8; --accent: #2b6cb0; --accent-ink: #fff; --new: #276749;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI",
         Roboto, Helvetica, Arial, sans-serif; background: var(--bg); color: var(--ink); }
  header { background: var(--panel); border-bottom: 1px solid var(--line);
           padding: 18px 24px; }
  /* Title row: heading left, About button pinned right. */
  .titlebar { display: flex; align-items: center; justify-content: space-between;
              gap: 12px; margin: 0 0 12px; }
  h1 { margin: 0; font-size: 20px; }
  #about_btn { padding: 6px 14px; background: #eef2f7; color: var(--accent); font-size: 13px; }
  .quick { margin: 0 0 12px; display: flex; gap: 8px; }
  .quick button { padding: 5px 12px; background: #eef2f7; color: var(--accent); font-size: 12px; }
  form { display: grid; grid-template-columns: 1fr 150px 150px auto auto;
         gap: 12px; align-items: end; max-width: 1100px; }
  /* Secondary action (copy shareable URL) sits next to the search button. */
  button.secondary { background: #eef2f7; color: var(--accent); }
  button.secondary:hover { background: #e2e8f0; }
  button.secondary.copied { background: #d7f0e0; color: var(--new); }
  /* Post-search filter toggle bar. */
  .filters { display: flex; flex-wrap: wrap; gap: 10px 28px; margin-bottom: 14px; }
  .filter-item { display: flex; align-items: center; gap: 10px; }
  .toggle { padding: 7px 14px; border: 1px solid var(--line); border-radius: 20px;
            background: #fff; color: var(--ink); font-size: 13px; font-weight: 600;
            cursor: pointer; display: inline-flex; align-items: center; gap: 8px; }
  .toggle::before { content: ""; width: 26px; height: 15px; border-radius: 999px;
                    background: #cbd2d9; position: relative; transition: background .15s; }
  .toggle::after { content: ""; width: 11px; height: 11px; border-radius: 50%;
                   background: #fff; position: absolute; margin-left: 2px;
                   transition: transform .15s; }
  .toggle[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); }
  .toggle[aria-pressed="true"]::before { background: var(--accent); }
  .toggle[aria-pressed="true"]::after { transform: translateX(11px); }
  .toggle:disabled { opacity: .4; cursor: default; }
  .filter-item:has(.toggle:disabled) .filter-note { opacity: .5; }
  .filter-note { color: var(--muted); font-size: 12px; }
  label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 4px; }
  input { width: 100%; padding: 8px 10px; border: 1px solid var(--line);
          border-radius: 6px; font-size: 14px; background: #fff; }
  button { padding: 9px 18px; border: 0; border-radius: 6px; background: var(--accent);
           color: var(--accent-ink); font-size: 14px; font-weight: 600; cursor: pointer; }
  button:disabled { opacity: .6; cursor: default; }
  main { padding: 20px 24px; max-width: 1100px; margin: 0 auto; }
  #status { color: var(--muted); margin-bottom: 14px; min-height: 20px; }
  #status.error { color: #b91c1c; }

  /* Column headers, shown once above all pairs. */
  .pair-head { display: grid; grid-template-columns: 1fr 220px 220px 1fr; gap: 0 16px;
               padding: 4px 16px 10px; }
  .pair-head div { font-size: 12px; font-weight: 700; text-transform: uppercase;
                   letter-spacing: .04em; text-align: center; }
  .pair-head .h-left { grid-column: 1 / 3; color: var(--new); }
  .pair-head .h-right { grid-column: 3 / 5; color: var(--muted); }

  /* Each pair: unused text | unused photo | current photo | current text.
     align-items: start keeps every column top-aligned; centering made the
     shorter text column look like it had a leading blank line. */
  .pair { display: grid; grid-template-columns: 1fr 220px 220px 1fr; gap: 0 16px;
          align-items: start; background: var(--panel); border: 1px solid var(--line);
          border-radius: 10px; padding: 14px 16px; margin-bottom: 14px; }
  /* No-depicts photos: file metadata | photo | search links on the right
     (mirrors the comparison layout so the search block is prominent). */
  .pair-solo { grid-template-columns: 1fr 220px 1fr; }
  .pair-solo .meta.left { text-align: right; }
  .section-head { font-size: 13px; font-weight: 700; text-transform: uppercase;
                  letter-spacing: .04em; color: var(--muted); margin: 22px 0 10px; }
  .photo img { width: 100%; max-height: 240px; object-fit: contain; background: #eef0f3;
               border-radius: 6px; display: block; }
  .photo .none { padding: 40px 8px; background: #eef0f3; border-radius: 6px; }
  .meta { font-size: 13px; }
  .meta.left { text-align: right; }
  .meta.right { text-align: left; }
  .meta .row { margin: 4px 0; }
  .meta .k { color: var(--muted); font-size: 12px; }
  .meta .k::after { content: ": "; }
  .meta .v { word-break: break-word; }
  .meta .author { color: var(--muted); font-size: 12px; margin-top: 2px; }
  .meta .warn { color: #b91c1c; font-weight: 600; }
  .meta .warn::after { content: " \26A0"; }
  /* Small inline action buttons (edit article, copy filename). */
  .mini { display: inline-block; padding: 1px 7px; margin-left: 6px; border: 1px solid var(--line);
          border-radius: 4px; background: #eef2f7; color: var(--accent); font-size: 11px;
          font-weight: 600; cursor: pointer; text-decoration: none; vertical-align: baseline; }
  .mini:hover { background: #e2e8f0; text-decoration: none; }
  .mini.copied { background: #d7f0e0; color: var(--new); border-color: #b7e0c6; }
  .none { color: var(--muted); font-style: italic; text-align: center; padding: 20px; }
  a { color: var(--accent); text-decoration: none; } a:hover { text-decoration: underline; }

  /* About overlay: sits over the current view so results are kept behind it. */
  .overlay { position: fixed; inset: 0; background: rgba(28,30,33,.55);
             display: flex; align-items: flex-start; justify-content: center;
             padding: 40px 20px; overflow-y: auto; z-index: 50; }
  .overlay[hidden] { display: none; }
  .about { background: var(--panel); border-radius: 10px; max-width: 720px; width: 100%;
           padding: 24px 28px 28px; box-shadow: 0 10px 40px rgba(0,0,0,.25); }
  .about h2 { margin: 0; font-size: 19px; }
  .about h3 { margin: 20px 0 6px; font-size: 14px; text-transform: uppercase;
              letter-spacing: .04em; color: var(--muted); }
  .about p, .about li { font-size: 14px; line-height: 1.5; }
  .about ul { margin: 6px 0; padding-left: 20px; }
  .about li { margin: 5px 0; }
  .about .close-row { display: flex; justify-content: space-between; align-items: center; }
  .about .flag { color: #b91c1c; font-weight: 600; }

  /* Footer */
  footer { border-top: 1px solid var(--line); margin-top: 30px; padding: 18px 24px 26px;
           text-align: center; color: var(--muted); font-size: 13px; }

  @media (max-width: 860px) {
    .pair, .pair-head, .pair-solo { grid-template-columns: 1fr 1fr; }
    .pair-head .h-left { grid-column: 1 / 2; }
    .pair-head .h-right { grid-column: 2 / 3; }
    .meta.left { text-align: left; }
    .pair-solo .meta.left { text-align: left; }
  }
</style>
</head>
<body>
<header>
  <div class="titlebar">
    <h1>Wikimedia Infobox Finder</h1>
    <button type="button" id="about_btn">About</button>
  </div>
  <div class="quick">
    <button type="button" id="q_prev_month">Previous month</button>
    <button type="button" id="q_month">This month</button>
    <button type="button" id="q_year">This year</button>
  </div>
  <form id="f">
    <div><label>Category</label>
      <input id="category" value="Photographs by Mateusz Malta"></div>
    <div><label>Start date</label><input id="start_date" type="date"></div>
    <div><label>End date</label><input id="end_date" type="date"></div>
    <button id="go" type="submit">Search Candidates</button>
    <button id="copy_url" type="button" class="secondary">Copy static URL</button>
  </form>
</header>
<main>
  <div id="status"></div>
  <div id="filters" class="filters" hidden>
    <div class="filter-item">
      <button type="button" id="hide_same_author" class="toggle" aria-pressed="true">
        Hide same-author candidates</button>
      <span class="filter-note">Author matches the infobox photo's, and that photo
        isn't old or low-res.</span>
    </div>
    <div class="filter-item">
      <button type="button" id="hide_good_current" class="toggle" aria-pressed="true">
        Hide when current photo is good</button>
      <span class="filter-note">Infobox photo is already fresh and good quality
        (not old, not low-res).</span>
    </div>
    <div class="filter-item">
      <button type="button" id="show_no_depicts" class="toggle" aria-pressed="false">
        Show no-depicts photos</button>
      <span class="filter-note">Unused category photos with no depicts statement
        at all (nothing to compare — they need one added).</span>
    </div>
    <div class="filter-item">
      <button type="button" id="show_current" class="toggle" aria-pressed="false">
        Show category photos already in use</button>
      <span class="filter-note">Category photos that are an article's current
        infobox photo — with a button to fetch the previous one.</span>
    </div>
  </div>
  <div id="head" class="pair-head" hidden>
    <div class="h-left">Unused Commons photo (new candidate)</div>
    <div class="h-right">Current Wikipedia infobox photo (existing)</div>
  </div>
  <div id="results"></div>
  <div id="nodepicts"></div>
  <div id="current"></div>
</main>

<div class="overlay" id="about_overlay" hidden>
  <div class="about" role="dialog" aria-modal="true" aria-labelledby="about_title">
    <div class="close-row">
      <h2 id="about_title">About this tool</h2>
      <button type="button" id="about_close">Close</button>
    </div>

    <p>Finds photos in a Wikimedia Commons category that are <strong>not yet used
    in any Wikipedia article</strong> and <strong>depict a person</strong>, then
    pairs each with that person's <strong>current Wikipedia infobox photo</strong>
    so you can see whether the new photo is an improvement.</p>

    <h3>Searching</h3>
    <ul>
      <li><strong>Category</strong> — a Commons category, with or without the
        <code>Category:</code> prefix. Spaces, underscores and <code>+</code> all work.</li>
      <li><strong>Start / End date</strong> — filters by the file's
        <strong>upload</strong> date. Defaults to the last three months;
        <em>Previous month</em>, <em>This month</em> and <em>This year</em>
        prefill other common ranges.</li>
    </ul>
    <p>You can prefill the form from the URL:
    <code>?category=Photographs_by_Mateusz_Malta</code>, optionally with
    <code>&amp;start=2026-05-01&amp;end=2026-07-31</code>, and
    <code>&amp;search=1</code> to run it immediately.
    <strong>Copy static URL</strong> (next to the search button) builds that link
    from whatever is currently in the form, so you can share a search without
    assembling it by hand.</p>

    <h3>Toggles</h3>
    <ul>
      <li><strong>Hide same-author candidates</strong> (on) — hides a candidate when
        the current infobox photo is by the same photographer <em>and</em> is already
        good, so another of their photos adds nothing.</li>
      <li><strong>Hide when current photo is good</strong> (on) — hides a match when
        the infobox photo is already good, whoever took it.</li>
      <li><strong>Show no-depicts photos</strong> (off) — switches to showing
        <em>only</em> unused photos with no depicts statement. Nothing to compare, so
        these are a "needs a depicts statement added" list, with search links that
        guess the person's name from the filename.</li>
      <li><strong>Show category photos already in use</strong> (off) — switches to
        showing <em>only</em> category photos that <em>are</em> an article's current
        infobox photo, each with a button to fetch the previous photo by a
        different author.</li>
    </ul>
    <p>The last two are exclusive views: turning one on replaces the comparison
    results and disables the other toggles.</p>

    <h3>What "good" means</h3>
    <p>A photo counts as good when it is present, <strong>not stale</strong> (taken
    within the last 12 months, falling back to its upload date) and
    <strong>not low-res</strong> (2 megapixels or more). Stale dates and low
    resolutions are marked <span class="flag">in red</span>.</p>

    <h3>Buttons on each row</h3>
    <ul>
      <li><strong>Copy</strong> — copies the bare filename (no <code>File:</code>
        prefix) ready to paste into an infobox <code>|image=</code> field.</li>
      <li><strong>Edit</strong> — opens the article in the wikitext editor.</li>
      <li><strong>Find previous photo by a different author</strong> — walks the
        article's revision history and shows the previous infobox photo that
        someone else took, with when and by whom it was replaced.</li>
    </ul>

    <h3>Notes</h3>
    <ul>
      <li>The "current infobox photo" is the image the article actually displays,
        which often differs from the photo set on Wikidata.</li>
      <li>A photo can be live on several language Wikipedias; each appears as its
        own row, because each wiki has its own history.</li>
      <li>All data comes from read-only calls to the public Wikimedia APIs. If a
        search fails with a "busy" message, Wikimedia is briefly rate-limiting
        us — wait a moment and retry.</li>
    </ul>
  </div>
</div>

<footer>
  <a href="https://github.com/Landsil/Wikimedia-Infobox-Checker" target="_blank"
     rel="noopener">Wikimedia-Infobox-Checker on GitHub</a>
</footer>
<script>
const $ = id => document.getElementById(id);
const esc = s => (s == null ? "" : String(s)).replace(/[&<>"]/g,
  c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

const link = (url, text) =>
  url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(text)}</a>` : esc(text);
// A metadata row; pass warn=true to render the value in red with a warning mark.
const row = (k, v, warn) =>
  `<div class="row"><span class="k">${k}</span><span class="v${warn ? " warn" : ""}">${v || "&mdash;"}</span></div>`;
const authorLine = (author, authorUrl) =>
  author ? `<div class="author">by ${authorUrl ? link(authorUrl, author) : esc(author)}</div>` : "";
// Bare filename for pasting into an infobox |image= field: drop the "File:"
// prefix (Commons page titles carry it) and any "File " label artefact.
const bareFilename = title => (title || "").replace(/^\s*File\s*:\s*/i, "");
// Infobox file row: the title already begins "File:...", so no "File" key/label
// (that produced a doubled "File File:..."). Author shown beneath.
const fileRow = (page, title, author, authorUrl) =>
  `<div class="row"><span class="v">${link(page, title)}`
  + authorLine(author, authorUrl) + `</span></div>`;
// Candidate file row: same style, plus a copy button that puts just the bare
// filename (no "File:" prefix) on the clipboard.
const candidateFileRow = (page, title, author, authorUrl) =>
  `<div class="row"><span class="v">${link(page, title)}`
  + `<button type="button" class="mini copy-file" data-file="${esc(bareFilename(title))}">Copy</button>`
  + authorLine(author, authorUrl) + `</span></div>`;
// "3.2 MP (2048×1562)" or a dash when dimensions are unknown.
const resolution = o => (o.megapixels != null && o.width && o.height)
  ? `${o.megapixels} MP (${o.width}×${o.height})` : "";
// Show dates without a time or timezone. Both "2026-06-04 18:34:01" and
// "2026-07-11T17:03:40Z" reduce to the date; free-text dates that extmetadata
// sometimes carries (e.g. "March 4, 2018") are left as they are.
const dateOnly = v => {
  const s = (v == null ? "" : String(v)).trim();
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m ? m[1] : s;
};

// Words that mark the end of the person's name in a filename ("Name at Event",
// "Name in Year"). Extend this list as new patterns show up.
const NAME_SEPARATORS = ["at", "in"];
// Best-effort person name from a filename: assume it starts with the name, and
// a separator word (\b at | in \b) ends it. Strips "File:", extension, and any
// trailing sequence number. Returns "" if the result isn't a plausible name
// (needs >=2 words), so companies like "Waymo" don't produce a bogus search.
function nameFromFilename(title) {
  let t = String(title || "").replace(/^\s*File\s*:\s*/i, "")
    .replace(/\.\w{2,4}$/, "").replace(/_/g, " ").trim();
  const sep = new RegExp("\\b(?:" + NAME_SEPARATORS.join("|") + ")\\b", "i");
  const m = sep.exec(t);
  let name = (m ? t.slice(0, m.index) : t).trim();
  name = name.replace(/\s+\d+$/, "").trim();     // drop trailing sequence number
  return name.split(/\s+/).filter(Boolean).length >= 2 ? name : "";
}

// A phrase ("Name") search URL, as the Special:Search/<phrase> PATH form.
// Passing the quoted phrase via ?search= makes MediaWiki also try to resolve it
// as a page title, so the results page carries a noisy 'The page "James Dow"
// does not exist; did you mean James Dow?' notice above the (correct) results.
// The path form searches without that title lookup. Spaces must be "+" encoded:
// %20 or _ in the path bring the notice back. Verified on en.wikipedia and
// wikidata: same phrase results, no notice.
function phraseSearchUrl(host, name) {
  const phrase = encodeURIComponent('"' + name + '"').replace(/%20/g, "+");
  return `https://${host}/wiki/Special:Search/${phrase}?fulltext=1&ns0=1`;
}

// Right-column search block for a no-depicts photo: the name guessed from the
// filename (shown once) with phrase-search links to Wikidata and Wikipedia.
function searchMeta(title) {
  const name = nameFromFilename(title);
  if (!name) {
    return `<div class="meta right">
      ${row("Search", "&mdash; (couldn't read a name from the filename)")}
    </div>`;
  }
  return `<div class="meta right">
    ${row("Search", "<strong>" + esc(name) + "</strong> on "
      + link(phraseSearchUrl("www.wikidata.org", name), "Wikidata") + " · "
      + link(phraseSearchUrl("en.wikipedia.org", name), "Wikipedia"))}
  </div>`;
}

function candidateMeta(c) {
  return `<div class="meta left">
    ${candidateFileRow(c.file_page, c.title, c.author, c.author_url)}
    ${row("Depicted", link(c.wikidata_url, c.depicted_label + " (" + c.depicted_qid + ")"))}
    ${row("Resolution", resolution(c), c.low_res)}
    ${row("Date taken", esc(dateOnly(c.date_taken)))}
    ${row("Date uploaded", esc(dateOnly(c.date_uploaded)))}
    ${row("Description", esc(c.description))}
  </div>`;
}

// Article link followed by an "Edit" button that opens the wikitext editor.
const editBtn = b => b.wiki_edit_url
  ? ` <a class="mini" href="${esc(b.wiki_edit_url)}" target="_blank" rel="noopener">Edit</a>` : "";

function infoboxMeta(b) {
  if (!b.has_image) {
    return `<div class="meta right">
      ${row("Article", b.wiki_article_url ? link(b.wiki_article_url, b.wiki_article_title) + editBtn(b) : "&mdash;")}
    </div>`;
  }
  return `<div class="meta right">
    ${fileRow(b.file_page, b.title, b.author, b.author_url)}
    ${row("Article", b.wiki_article_url ? link(b.wiki_article_url, b.wiki_article_title + " (" + b.wiki_site + ")") + editBtn(b) : "&mdash;")}
    ${row("Resolution", resolution(b), b.low_res)}
    ${row("Date taken", esc(dateOnly(b.date_taken)), b.stale)}
    ${row("Date uploaded", esc(dateOnly(b.date_uploaded)))}
    ${row("Description", esc(b.description))}
  </div>`;
}

const candidatePhoto = c => `<div class="photo"><img src="${esc(c.thumb)}" alt="" loading="lazy"></div>`;
const infoboxPhoto = b => b.has_image
  ? `<div class="photo"><img src="${esc(b.thumb)}" alt="" loading="lazy"></div>`
  : `<div class="photo"><div class="none">No image set in infobox</div></div>`;

const pairRow = r =>
  `<div class="pair">${candidateMeta(r.candidate)}${candidatePhoto(r.candidate)}`
  + `${infoboxPhoto(r.infobox)}${infoboxMeta(r.infobox)}</div>`;

// Left-column file metadata for a no-depicts photo (no depicted subject).
function noDepictsMeta(c) {
  return `<div class="meta left">
    ${candidateFileRow(c.file_page, c.title, c.author, c.author_url)}
    ${row("Resolution", resolution(c), c.low_res)}
    ${row("Date taken", esc(dateOnly(c.date_taken)))}
    ${row("Date uploaded", esc(dateOnly(c.date_uploaded)))}
    ${row("Description", esc(c.description))}
  </div>`;
}

// No-depicts row: file metadata | photo | search links (right, for visibility).
const noDepictsRow = c =>
  `<div class="pair pair-solo">${noDepictsMeta(c)}${candidatePhoto(c)}${searchMeta(c.title)}</div>`;

// ---- "Category photo is the current infobox photo" rows ------------------ //
// Left metadata for a live category photo, including the article it's live on.
function currentPhotoMeta(c) {
  return `<div class="meta left">
    ${candidateFileRow(c.file_page, c.title, c.author, c.author_url)}
    ${row("Article", link(c.wiki_article_url, c.wiki_article_title + " (" + c.wiki_site + ")") + editBtn(c))}
    ${row("Resolution", resolution(c), c.low_res)}
    ${row("Date taken", esc(dateOnly(c.date_taken)), c.stale)}
    ${row("Date uploaded", esc(dateOnly(c.date_uploaded)))}
    ${row("Description", esc(c.description))}
  </div>`;
}

// Right side starts as a button; the fetched previous photo replaces it in place.
const previousPhotoSlot = i =>
  `<div class="photo" id="prevphoto-${i}"></div>`
  + `<div class="meta right" id="prevmeta-${i}">`
  + `<button type="button" class="mini find-prev" data-idx="${i}">`
  + `Find previous photo by a different author</button></div>`;

// Rendered once the lookup returns: same formatting as every other photo block.
function previousPhotoHtml(p) {
  if (!p.found) return { photo: "", meta: row("Previous photo", esc(p.reason)) };
  return {
    photo: `<img src="${esc(p.thumb)}" alt="" loading="lazy">`,
    meta: fileRow(p.file_page, p.title, p.author, p.author_url)
      + row("Resolution", resolution(p), p.low_res)
      + row("Date taken", esc(dateOnly(p.date_taken)))
      + row("Date uploaded", esc(dateOnly(p.date_uploaded)))
      + row("Replaced on", esc(dateOnly(p.replaced_on)) + " by " + esc(p.replaced_by_user)
          + (p.diff_url ? ` <a class="mini" href="${esc(p.diff_url)}" target="_blank" rel="noopener">Diff</a>` : ""))
      + row("Description", esc(p.description)),
  };
}

// Row: live category photo (left) | photo | previous-photo slot (right).
const currentPhotoRow = (c, i) =>
  `<div class="pair">${currentPhotoMeta(c)}${candidatePhoto(c)}${previousPhotoSlot(i)}</div>`;

// Format local Y-M-D. toISOString() shifts to UTC and can roll the day back by
// one under timezones ahead of UTC (e.g. BST).
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function setRange(startDate, endDate) {
  $("start_date").value = iso(startDate);
  $("end_date").value = iso(endDate);
}
function thisMonth() {
  const n = new Date();
  setRange(new Date(n.getFullYear(), n.getMonth(), 1),
           new Date(n.getFullYear(), n.getMonth() + 1, 0));
}
function prevMonth() {
  const n = new Date();
  // Day 0 of the current month is the last day of the previous month; JS
  // normalizes a month index of -1 to December of the prior year.
  setRange(new Date(n.getFullYear(), n.getMonth() - 1, 1),
           new Date(n.getFullYear(), n.getMonth(), 0));
}
function thisYear() {
  const n = new Date();
  setRange(new Date(n.getFullYear(), 0, 1), new Date(n.getFullYear(), 11, 31));
}
// Default on load: a 3-month window — the 1st of the month two months back
// through the end of the current month. A negative month index rolls the year
// back automatically (January -> November of the previous year).
function lastThreeMonths() {
  const n = new Date();
  setRange(new Date(n.getFullYear(), n.getMonth() - 2, 1),
           new Date(n.getFullYear(), n.getMonth() + 1, 0));
}
$("q_prev_month").addEventListener("click", prevMonth);
$("q_month").addEventListener("click", thisMonth);
$("q_year").addEventListener("click", thisYear);
lastThreeMonths();

// ---- Prefill from the URL query string ----------------------------------- //
// ?category=... overrides the default category (underscores and "+" are fine —
// normalize_category handles them). ?start=/?end= (YYYY-MM-DD) override the
// default 3-month range. ?search=1 also runs the search immediately, so a link
// can share a ready-made result.
function applyUrlParams() {
  const q = new URLSearchParams(location.search);
  const category = q.get("category");
  if (category) $("category").value = category.replace(/_/g, " ").trim();
  const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(v || "");
  const start = q.get("start"), end = q.get("end");
  if (isDate(start)) $("start_date").value = start;
  if (isDate(end)) $("end_date").value = end;
  return q.get("search") === "1";
}
const autoSearch = applyUrlParams();

// "Copy static URL": the inverse of applyUrlParams() — encode the current form
// state into a shareable link (including &search=1 so it runs on open).
function staticUrl() {
  const q = new URLSearchParams();
  q.set("category", $("category").value.trim());
  if ($("start_date").value) q.set("start", $("start_date").value);
  if ($("end_date").value) q.set("end", $("end_date").value);
  q.set("search", "1");
  return `${location.origin}${location.pathname}?${q.toString()}`;
}
$("copy_url").addEventListener("click", async () => {
  const btn = $("copy_url");
  const ok = await copyText(staticUrl());
  const original = btn.textContent;
  btn.textContent = ok ? "URL copied!" : "Copy failed";
  btn.classList.toggle("copied", ok);
  setTimeout(() => { btn.textContent = original; btn.classList.remove("copied"); }, 1500);
});

// ---- About overlay ------------------------------------------------------- //
const setAbout = open => { $("about_overlay").hidden = !open; };
$("about_btn").addEventListener("click", () => setAbout(true));
$("about_close").addEventListener("click", () => setAbout(false));
// Click the backdrop (but not the panel) to dismiss.
$("about_overlay").addEventListener("click", e => {
  if (e.target === $("about_overlay")) setAbout(false);
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && !$("about_overlay").hidden) setAbout(false);
});

// Results are fetched once, then filtered client-side so the toggle is instant.
let allResults = [];
let allNoDepicts = [];
let allCurrent = [];

const pressed = id => $(id).getAttribute("aria-pressed") === "true";

// The current infobox photo is already "good": present, fresh, and confirmed
// high-res. Unknown resolution (megapixels == null) counts as NOT good, so we
// never hide a candidate on the strength of a photo we can't vouch for.
const currentIsGood = b =>
  b.has_image && !b.stale && !b.low_res && b.megapixels != null;

// Commons crops are conventionally named "<original> (cropped).jpg" (also
// "(cropped 2)", "(head crop)", ...). Derive the parent filename so the tool can
// tell that an infobox photo is the *same photo* as a candidate, just cropped.
// Commons also records this structurally via {{Extracted from}} in the file's
// wikitext, which is authoritative but costs one non-batchable parse call per
// file; the naming convention covers it for free.
const CROP_SUFFIX = /^(?<base>.+?)\s*\((?:[^)]*crop[^)]*)\)(?<ext>\.\w+)$/i;
function cropParent(title) {
  const m = CROP_SUFFIX.exec(title || "");
  return m ? m.groups.base + m.groups.ext : null;
}
// The infobox photo is a crop of this candidate -> already the same photo.
const infoboxIsCropOfCandidate = r =>
  r.infobox.has_image && cropParent(r.infobox.title) === r.candidate.title;

// Filter 1: hide when the candidate's author matches the infobox photo's author
// AND that photo is good (same photographer already has a good live photo, so
// this candidate adds nothing). Match on author_url (canonical) else the name.
function sameAuthorRedundant(r) {
  // A crop of the candidate is the candidate, already in use: redundant whatever
  // the crop's resolution is (a tight crop can fall under the low-res bar).
  if (infoboxIsCropOfCandidate(r)) return true;
  if (!currentIsGood(r.infobox)) return false;
  const bId = r.infobox.author_url || r.infobox.author;
  const cId = r.candidate.author_url || r.candidate.author;
  return !!bId && !!cId && bId === cId;
}

// Filter 2: hide when the current infobox photo is already good, regardless of
// who took it (there's no need to replace a fresh, high-res photo).
const currentGoodRedundant = r => currentIsGood(r.infobox);

// A result is hidden if any enabled filter flags it.
function isHidden(r) {
  if (pressed("hide_same_author") && sameAuthorRedundant(r)) return true;
  if (pressed("hide_good_current") && currentGoodRedundant(r)) return true;
  return false;
}

function renderResults() {
  // The no-depicts and already-in-use views are exclusive: when either is on,
  // show ONLY that list (the hide-filters apply to the comparison view only).
  const showND = pressed("show_no_depicts");
  const showCur = pressed("show_current");
  const exclusive = showND || showCur;
  $("hide_same_author").disabled = exclusive;
  $("hide_good_current").disabled = exclusive;
  // The two exclusive views are mutually exclusive too.
  $("show_no_depicts").disabled = showCur;
  $("show_current").disabled = showND;

  if (exclusive) { $("head").hidden = true; $("results").innerHTML = ""; }

  if (showCur) {
    $("nodepicts").innerHTML = "";
    $("current").innerHTML = allCurrent.length
      ? `<div class="section-head">Category photos already in use as the infobox photo (${allCurrent.length})</div>`
        + allCurrent.map(currentPhotoRow).join("")
      : `<div class="none">No category photos are currently used as an infobox photo.</div>`;
    $("status").textContent =
      `Showing ${allCurrent.length} category photo(s) that are an article's current infobox photo.`;
    return;
  }
  $("current").innerHTML = "";

  if (showND) {
    $("nodepicts").innerHTML = allNoDepicts.length
      ? `<div class="section-head">No depicts statement (${allNoDepicts.length}) — need one added</div>`
        + allNoDepicts.map(noDepictsRow).join("")
      : `<div class="none">No photos without a depicts statement.</div>`;
    $("status").textContent =
      `Showing ${allNoDepicts.length} unused photo(s) with no depicts statement.`;
    return;
  }

  const shown = allResults.filter(r => !isHidden(r));
  const hiddenCount = allResults.length - shown.length;
  $("nodepicts").innerHTML = "";
  $("head").hidden = shown.length === 0;
  $("results").innerHTML = shown.map(pairRow).join("")
    || `<div class="none">No matching candidates.</div>`;

  let msg = `Found ${allResults.length} unused category photo(s) with a depicted subject.`;
  if (hiddenCount) msg += ` Showing ${shown.length}; ${hiddenCount} hidden by filters.`;
  if (allNoDepicts.length) msg += ` ${allNoDepicts.length} more have no depicts statement.`;
  if (allCurrent.length) msg += ` ${allCurrent.length} are already in use.`;
  $("status").textContent = msg;
}

function bindToggle(id) {
  $(id).addEventListener("click", () => {
    $(id).setAttribute("aria-pressed", pressed(id) ? "false" : "true");
    renderResults();
  });
}
bindToggle("hide_same_author");
bindToggle("hide_good_current");
bindToggle("show_no_depicts");
bindToggle("show_current");

// "Find previous photo by a different author" — fetched on click (the revision
// history walk is the expensive part, so it stays out of the main search).
// The local server does the walk so it keeps our custom User-Agent.
document.addEventListener("click", async e => {
  const btn = e.target.closest(".find-prev");
  if (!btn) return;
  const i = Number(btn.dataset.idx);
  const c = allCurrent[i];
  if (!c) return;
  btn.disabled = true; btn.textContent = "Looking through history…";
  try {
    const resp = await fetch("/api/previous-photo", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        wiki_site: c.wiki_site, wiki_article_title: c.wiki_article_title,
        author_url: c.author_url, author: c.author,
      }),
    });
    const p = await resp.json();
    if (!resp.ok) throw new Error(p.error || ("HTTP " + resp.status));
    const out = previousPhotoHtml(p);
    const photoEl = $(`prevphoto-${i}`), metaEl = $(`prevmeta-${i}`);
    if (photoEl) photoEl.innerHTML = out.photo;
    if (metaEl) metaEl.innerHTML = out.meta;
  } catch (err) {
    btn.disabled = false;
    btn.textContent = "Failed: " + err.message;
  }
});

// Copy the candidate filename to the clipboard (delegated, survives re-render).
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (_) {}
    document.body.removeChild(ta);
    return ok;
  }
}
// Delegate on document so copy works in both #results and #nodepicts.
document.addEventListener("click", async e => {
  const btn = e.target.closest(".copy-file");
  if (!btn) return;
  const ok = await copyText(btn.dataset.file);
  const original = btn.textContent;
  btn.textContent = ok ? "Copied!" : "Copy failed";
  btn.classList.toggle("copied", ok);
  setTimeout(() => { btn.textContent = original; btn.classList.remove("copied"); }, 1500);
});

$("f").addEventListener("submit", async e => {
  e.preventDefault();
  const status = $("status"), results = $("results"), go = $("go");
  status.className = ""; status.textContent = "Searching… (this can take a while)";
  results.innerHTML = ""; $("nodepicts").innerHTML = ""; $("current").innerHTML = "";
  $("head").hidden = true; $("filters").hidden = true;
  go.disabled = true;
  try {
    const resp = await fetch("/api/search", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        category: $("category").value, start_date: $("start_date").value,
        end_date: $("end_date").value,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || ("HTTP " + resp.status));
    allResults = data.results;
    allNoDepicts = data.no_depicts || [];
    allCurrent = data.current_photos || [];
    $("filters").hidden =
      allResults.length === 0 && allNoDepicts.length === 0 && allCurrent.length === 0;
    renderResults();
  } catch (err) {
    status.className = "error"; status.textContent = "Error: " + err.message;
  } finally {
    go.disabled = false;
  }
});

// ?search=1 in the URL: run the prefilled search straight away.
if (autoSearch) $("f").requestSubmit ? $("f").requestSubmit() : $("go").click();
</script>
</body>
</html>
"""


def main():
    port = 8000
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            sys.exit(f"Invalid port {sys.argv[1]!r}: must be an integer (e.g. 9000).")
        if not 1 <= port <= 65535:
            sys.exit(f"Invalid port {port}: must be between 1 and 65535.")
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"Wikimedia Infobox Finder running at http://localhost:{port}/")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.shutdown()


if __name__ == "__main__":
    main()
