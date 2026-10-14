// WikiPortraits photographer badge — shared by finder.html and history.html.
//
// The list is the user pages (namespace 2) of two Commons categories,
// Category:WikiPortraits contributors and its subcategory Category:WikiPortraits
// photographers, merged into one set — someone in both is one entry, so one
// badge. Their other members (photos, subcategories) are ignored. Fetched once
// per page load — one request per category (~260 people in all), so it is
// always current and needs no caching. A credit gets the badge when:
//   - it links to a user page (/wiki/User:Name, or a red link
//     index.php?title=User:Name, on any wiki) and Name is on the list, or
//   - it has no user-page link and its text is exactly a listed username
//     (plain-text credits such as "Harald Krichel").
// The uploader is deliberately NOT used: uploaders on the list also upload
// other people's photos (e.g. credits "Super Festivals", "Gage Skidmore").
// A category that can't be fetched just contributes nobody; if neither can,
// no badges are shown — never a wrong one.
// Classic script (not a module) so finder.html keeps working from file://.
(function () {
  "use strict";
  const CATEGORIES = ["Category:WikiPortraits contributors", "Category:WikiPortraits photographers"];
  const CATEGORY_URL = "https://commons.wikimedia.org/wiki/Category:WikiPortraits_contributors";
  // File:WikiPortraits Logo.png (CC0), as a Commons thumbnail; shown at text height.
  const LOGO = "https://thumb.wikimedia.org/wikipedia/commons/thumb/8/89/WikiPortraits_Logo.png/120px-WikiPortraits_Logo.png";

  // MediaWiki usernames: underscores = spaces, first letter always upper case.
  const norm = s => {
    let t = String(s || "");
    try { t = decodeURIComponent(t); } catch (_) {}
    t = t.replace(/_/g, " ").replace(/\s+/g, " ").trim();
    return t.charAt(0).toUpperCase() + t.slice(1);
  };

  let names = null;   // Set of usernames once loaded; null = not (yet) available
  // One category's user pages, following `continue`; null if it can't be fetched.
  async function usersIn(category) {
    const out = [];
    const params = { action: "query", list: "categorymembers", cmtitle: category, cmnamespace: "2",
                     cmprop: "title", cmlimit: "500", format: "json", origin: "*" };
    try {
      while (true) {
        const r = await fetch("https://commons.wikimedia.org/w/api.php?" + new URLSearchParams(params),
                              { credentials: "omit" });
        const d = await r.json();
        if (!r.ok || d.error) return null;
        for (const m of ((d.query || {}).categorymembers || []))
          out.push(norm(m.title.replace(/^User:/i, "").split("/")[0]));
        if (d.continue) Object.assign(params, d.continue); else return out;
      }
    } catch (_) {
      return null;
    }
  }
  async function load() {
    const lists = await Promise.all(CATEGORIES.map(usersIn));
    if (lists.every(l => l === null)) { names = null; return; }
    names = new Set(lists.flatMap(l => l || []));   // a Set: in both categories = one entry
  }

  function userFromUrl(url) {
    const m = /\/wiki\/User:([^/?#]+)/i.exec(url || "") || /[?&]title=User:([^&#/]+)/i.exec(url || "");
    return m ? norm(m[1]) : null;
  }
  function isPhotographer(name, url) {
    if (!names) return false;
    const user = userFromUrl(url);
    if (user) return names.has(user);
    return !!name && names.has(norm(name));
  }
  // HTML for the badge after a credit, or "".
  function badge(name, url) {
    return isPhotographer(name, url)
      ? `<a class="wp-badge" href="${CATEGORY_URL}" target="_blank" rel="noopener" title="WikiPortraits contributor">`
        + `<img src="${LOGO}" alt="WikiPortraits contributor"></a>`
      : "";
  }

  // `ready` resolves when the list has loaded (or failed); await it before the
  // first render so the badges are there from the start.
  window.WikiPortraits = { ready: load(), badge, isPhotographer };
})();
