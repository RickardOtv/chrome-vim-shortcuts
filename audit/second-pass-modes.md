# Audit: modes / frontend (audit-modes)

Scope: content_scripts/vimium_frontend.js, mode_normal.js, mode_visual.js, mode_find.js, mode.js,
mode_insert.js, mode_key_handler.js, scroller.js, lib/handler_stack.js, lib/find_mode_history.js.
Calls traced into: lib/utils.js (forTrusted, addChromeRuntimeOnMessageListener), content_scripts/hud.js,
content_scripts/ui_component.js, pages/hud_page.js, pages/ui_component_messenger.js,
background_scripts/main.js (sendRequestHandlers, initializeFrame), background_scripts/tab_operations.js,
lib/url_utils.js, manifest.json.

Summary: 0 High, 0 Medium, 2 Low, 6 Info.

## 1. Findings

### F1. Low - Page-controlled text can open privileged URL schemes (chrome://, chrome-extension://, file://, about:)
- Entry points in my files:
  - content_scripts/mode_visual.js:469-474 (visual mode `p` / `P`: selection text -> `openUrlInCurrentTab` / `openUrlInNewTab`)
  - content_scripts/mode_normal.js:185-200 (`openCopiedUrlInNewTab` / `openCopiedUrlInCurrentTab`: clipboard text -> same handlers)
- Root cause (cross-cutting, confirmed): background_scripts/tab_operations.js:11-15 `toNavigableUrl` only blocks
  `javascript:|data:|vbscript:` (lib/url_utils.js:112). `convertToUrl` (url_utils.js:92-103) returns the string as-is
  for `about:`, `view-source:`, `extension:`, `chrome-extension:` (url_utils.js:105-108), and `isUrl` accepts any
  `scheme://` string (url_utils.js:44, 117), so `chrome://...` and `file:///...` pass too. The result goes to
  `chrome.tabs.update` / `chrome.tabs.create`, which (as an extension API) can open URLs a web page itself is never
  allowed to navigate to.
- What an attacker can do: get the extension to open, in the current or a new tab, any `chrome://` page,
  any other extension's internal (non-web-accessible) page with attacker-chosen path/query/hash, and
  possibly `file://` URLs (Chrome may require file-URL access for the last one). Web pages cannot do this
  themselves. Impact depends on the target: other extensions' internal pages that trust their own URL
  parameters are the realistic escalation; chrome:// settings pages still need user clicks.
- Concrete scenario: attacker page shows a link-looking string and hooks the `copy` event
  (`event.clipboardData.setData("text/plain", "chrome-extension://<victim-ext-id>/popup.html#cmd=...")`).
  User copies it and presses `P` (openCopiedUrlInNewTab). Extension opens the privileged URL. Variant: in
  visual mode, the page (which shares the DOM Selection with the content script) watches `selectionchange`
  and swaps the selection to a hidden text node containing `chrome://...` before the user presses `p`; or the
  visible text contains a visually hidden prefix that `Selection.toString()` still includes.
- Suggested fix: in `toNavigableUrl`, switch from a blocklist to an allowlist: parse with `new URL()` and
  accept only `http:`, `https:` (optionally `ftp:`), plus `view-source:` whose inner URL is http(s). Drop the
  `about:` / `extension:` / `chrome-extension:` special case in `hasChromeProtocol`, or allow only the exact
  new-tab URL. Anything else -> null (or treat as search text).

### F2. Low - Find-mode queries are exposed to the page through the DOM selection, including queries typed on other sites
- Files/lines:
  - content_scripts/mode_find.js:141-154 (`findInPlace` runs on every keystroke typed in the HUD find box,
    pages/hud_page.js:146-147) and mode_find.js:463-473 (`highlight` sets the real DOM Selection to the match).
  - content_scripts/mode_find.js:275-284 (`getQuery`: on `n`/`N` it silently adopts the most recent query from
    the global history, i.e. a query typed in any other tab/site).
  - lib/find_mode_history.js:4, 27-31 (single global history in chrome.storage.session, shared by all
    content scripts on all sites; live-updated via onChanged).
  - content_scripts/mode_find.js:303 / 348 (`vimium-find-mode` class on `document.body` tells the page when
    a search is active).
- What an attacker can do: the query itself is typed into the extension-origin HUD iframe (page cannot read
  it), but each keystroke selects the match in the page, and `getSelection()` / `selectionchange` are
  visible to page scripts. A page can learn the query whenever it contains matching text. Because
  `updateQuery` re-collects text nodes on every keystroke (mode_find.js:201), the page can adapt: after
  seeing prefix "pas", it inserts text nodes "pasa".."pasz" so the next keystroke's match reveals the next
  char. A static de Bruijn-style text block reveals any short query outright.
- Cross-site scenario: user once used `/` on attacker page (so `FindMode.query` exists in that frame), later
  searches "Project Falcon" on an internal work site, then returns and presses `n` on the attacker page.
  `getQuery` pulls "Project Falcon" from global history and selects it if present; with a prepared word list
  / short-string corpus the page learns the other site's query.
- Severity rationale: needs user to run find on the attacker page; leak limited to what the page can
  match. Upstream Vimium behaves the same.
- Suggested fix: (a) keep find history per origin (key by `location.origin`), or at least do not
  auto-adopt another tab's query in `getQuery` (only use history when the user explicitly recalls it with
  arrow keys in the HUD); (b) optionally only set the DOM selection on Enter/Escape instead of on every
  keystroke (show live matches via a non-DOM overlay or count only).

### F3. Info - `passNextKeyKeys` live update listens to the wrong storage area
- content_scripts/mode_insert.js:23-27: listener returns unless `areaName == "local"`, but the key is
  written to `chrome.storage.session` (background_scripts/commands.js:328; read at mode_insert.js:19).
- Effect: after the user remaps a pass-next-key key, open tabs keep the old list until reload. Not
  attacker-reachable; plain bug.
- Fix: check `areaName === "session"`.

### F4. Info - GrabBackFocus: `pathName` typo and leaked onMessage listeners
- content_scripts/vimium_frontend.js:145: `target.pathName` / `document.location.pathName` are both
  undefined (property is `pathname`), so the "URL changed" test only compares `search`.
- content_scripts/vimium_frontend.js:87-89, 95-106: each `new GrabBackFocus()` adds a
  chrome.runtime.onMessage listener that is removed only when a `userIsInteractingWithThePage` message
  arrives. With `grabBackFocus` off, the mode exits immediately without broadcasting, so every trusted
  user click on a same-origin link with a different query string leaks one listener. Needs trusted
  (user) clicks (installListener uses forTrusted), so a page cannot amplify it. Memory only.
- Fix: `pathname`; remove the listener in an `onExit` handler.

### F5. Info - Page can trigger trusted hashchange/focus events that make the content script message the background
- content_scripts/vimium_frontend.js:181-195 (hashchange -> checkIfEnabledForUrl when focused),
  242-246 (window focus -> checkIfEnabledForUrl -> `initializeFrame`, main.js:621-670 -> setIcon for top frame).
- `location.hash = ...` in a loop yields trusted hashchange events, each with a changed href, so each
  passes the `previousUrl` guard and sends a message. Effect: a page can generate a stream of
  extension messages / setIcon calls (load on the service worker). No data exposure; no escalation.
- Fix (optional): throttle checkIfEnabledForUrl (e.g. once per 250 ms per frame).

### F6. Info - FindModeHistory incognito init overwrites incognito history on every new incognito tab
- lib/find_mode_history.js:12-21: the first `get(this.key)` result is discarded; every incognito content
  script resets `findModeRawQueryListIncognito` to the normal-mode list. Incognito queries never flow to the
  normal key (good for privacy); normal queries flow into incognito by design. Functional bug only.
- Fix: only seed from the normal list when `result[this.key]` is missing.

### F7. Info - chrome.storage.session opened to untrusted contexts (cross-cutting)
- background_scripts/main.js:21 sets `TRUSTED_AND_UNTRUSTED_CONTEXTS`, needed by find_mode_history.js:4,
  mode_normal.js:15, mode_insert.js:19, ui_component.js. This puts `vimiumSecret`, find history, key
  mappings and tab-recency IDs into reach of every content-script process. Page JS cannot reach
  chrome.storage (isolated world), so this matters only if a renderer is compromised (then the attacker can
  read find queries typed on other sites and the HUD handshake secret). Outside the stated threat model;
  noted for completeness. Mitigation if wanted: fetch these values via runtime.sendMessage from the
  background instead of opening session storage.

### F8. Info - Extension is detectable / mode activity observable by pages
- Visible DOM side effects: `vimium-find-mode` class on body (mode_find.js:303), `#vimiumInputMarkerContainer`
  (mode_normal.js:519-526), highlighted-frame div (vimium_frontend.js:280-302), HUD shadow host, console log
  "An auto-focusing action on this page was blocked by Vimium." (vimium_frontend.js:117).
- Effect: sites can fingerprint that the user runs this extension and see when find/focusInput is active.
  No data leak beyond F2.

## 2. Coverage

| File | Lines | Status |
|---|---|---|
| content_scripts/vimium_frontend.js | 494 | read in full |
| content_scripts/mode_normal.js | 551 | read in full |
| content_scripts/mode_visual.js | 615 | read in full |
| content_scripts/mode_find.js | 511 | read in full |
| content_scripts/mode.js | 327 | read in full |
| content_scripts/mode_insert.js | 142 | read in full |
| content_scripts/mode_key_handler.js | 149 | read in full |
| content_scripts/scroller.js | 470 | read in full |
| lib/handler_stack.js | 172 | read in full |
| lib/find_mode_history.js | 64 | read in full |

Also read (to trace calls, not full audit): content_scripts/hud.js (full), lib/utils.js:1-22 and 265-277,
pages/ui_component_messenger.js:1-50, content_scripts/ui_component.js:60-100, pages/hud_page.js:120-160,
background_scripts/main.js:560-720, background_scripts/tab_operations.js:1-70, lib/url_utils.js:1-121,
manifest.json (content_scripts, web_accessible_resources).

## 3. Notable things that are safe

- All page-facing DOM listeners go through `forTrusted` (vimium_frontend.js:21,31,181,207,242,333; mode_find.js:393): `dispatchEvent` / `element.click()` from the page cannot drive commands.
- Listeners are installed at document_start on `window` capture before page scripts run (vimium_frontend.js:227-239, 405), so keys Vimium consumes are stopped before the page sees them.
- handleMessage dispatches only whitelisted handler names (utils.js:268 + vimium_frontend.js:410-413); content-script onMessage only receives extension messages; no `externally_connectable` in manifest.
- `runInTopFrame` lookup `NormalModeCommands[registryEntry.command]` (vimium_frontend.js:364) is reachable only from extension contexts; prototype names (`constructor`, etc.) resolve to harmless functions.
- No innerHTML / insertAdjacentHTML / document.write / eval / Function / string setTimeout / dynamic import / fetch / postMessage in any of my 10 files (grep + read).
- flashFrame `@import url(...)` (vimium_frontend.js:292) uses `chrome.runtime.getURL` constant only.
- HUD text (incl. `No matches for '<query>'`, `Yanked <url>`) is rendered with textContent in the extension-origin HUD iframe (hud_page.js:101), not in page DOM.
- copyCurrentUrl / toggleViewSource get the top tab URL from the background (main.js:572) but only pass it to HUD/background, never into page DOM, so cross-origin iframes cannot read it.
- Clipboard read happens in the extension-origin HUD iframe; text returns over a private MessagePort set up with a secret and exact targetOrigin (ui_component.js:80-88, ui_component_messenger.js:8-21); never written to page DOM.
- `confirm()` in commandHandler (mode_normal.js:44) and DOM methods like `scrollBy` run in the isolated world: page cannot monkey-patch them; content-script expandos (`wordCount`, `originalIndex`, mode_normal.js:449,455) are invisible to page JS and page expandos invisible to us.
- `findLink` RegExp (mode_normal.js:469-471) is built from the user's own nextPatterns/previousPatterns settings, not page data.
- Find-mode RegExp is built from the user's typed query; invalid patterns are caught (mode_find.js:194-199); zero-length matches break the loop (mode_find.js:453).
- goNext/goPrevious (mode_normal.js:388-397) navigate/click within the page's own frame via content-script `location.href` / simulated click: no privilege beyond what the page already has (and javascript: there would run in the page's own world).
- Scroller only reads/writes scroll properties via fixed property-name tables (scroller.js:31-42); `specialScrollingElementMap` selectors are constants.
- Mode/HandlerStack: only internal callers push handlers; return-value sentinels are private objects, page cannot forge them.
