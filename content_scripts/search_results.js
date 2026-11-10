//
// Moving between results on search engine result pages with the arrow keys.
//
// The selected result's link is focused, so the browser's own keys work on it: Enter opens it,
// Ctrl/Cmd+Enter opens it in a new tab.
//
// Sites change their markup. When a site breaks, fix its entry in `sites` below.
//

const SearchResults = {
  // Each site: which pages to match, and a CSS selector for the result links.
  sites: [
    {
      name: "Google",
      // google.<tld> or google.co(m).<cc>, e.g. google.se, google.co.uk, google.com.au.
      host: /^(www\.)?google\.([a-z]{2,3}|co\.[a-z]{2}|com\.[a-z]{2})$/,
      path: /^\/search/,
      results: "#search a:has(h3)",
    },
  ],

  getSite(location = globalThis.location) {
    return this.sites.find((site) =>
      site.host.test(location.hostname) && site.path.test(location.pathname)
    );
  },

  // The visible result links on this page, in page order.
  getResults(site) {
    return Array.from(document.querySelectorAll(site.results))
      .filter((el) => el.getClientRects().length > 0);
  },

  // Moves the selection `count` results down (positive) or up (negative). Returns false if this
  // isn't a supported results page, so the caller can fall back to scrolling.
  move(count) {
    const site = this.getSite();
    if (!site) return false;
    const results = this.getResults(site);
    if (results.length == 0) return false;

    const current = results.indexOf(document.activeElement);
    let index;
    if (current >= 0) {
      index = current + count;
    } else {
      // Nothing selected yet: start from the first (or last) result in view.
      const inView = results.map((el) => {
        const rect = el.getBoundingClientRect();
        return rect.bottom > 0 && rect.top < globalThis.innerHeight;
      });
      const start = count > 0 ? inView.indexOf(true) : inView.lastIndexOf(true);
      index = (start >= 0 ? start : 0) + count - Math.sign(count);
    }
    index = Math.max(0, Math.min(results.length - 1, index));

    const el = results[index];
    el.focus({ focusVisible: true });
    el.scrollIntoView({ block: "nearest" });
    return true;
  },
};

globalThis.SearchResults = SearchResults;
