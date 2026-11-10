//
// Functions for opening URLs in tabs.
//

import * as bgUtils from "../background_scripts/bg_utils.js";
import "../lib/url_utils.js";

// Converts text (a URL, or search terms) into a URL we are willing to open, or null. Anything that
// isn't a URL becomes a search with the default search engine. The result must pass
// UrlUtils.isSafeToOpen, which also covers a bad searchUrl setting.
export async function toNavigableUrl(text) {
  if (text == null || UrlUtils.isBlockedUrl(text)) return null;
  const url = (await UrlUtils.convertToUrl(text)) ??
    UrlUtils.createSearchUrl(text.trim(), Settings.get("searchUrl"));
  return UrlUtils.isSafeToOpen(url) ? url : null;
}

// Opens request.url in the current tab.
export async function openUrlInCurrentTab(request) {
  const url = await toNavigableUrl(request.url);
  if (url == null) return;
  await chrome.tabs.update(request.tabId, { url });
}

// Opens request.url in new tab and switches to it.
// Returns the created tab.
export async function openUrlInNewTab(request) {
  const url = await toNavigableUrl(request.url);
  if (url == null) return;
  const tabConfig = { windowId: request.tab.windowId };
  const position = request.position;
  let tabIndex = null;
  switch (position) {
    case "start":
      tabIndex = 0;
      break;
    case "before":
      tabIndex = request.tab.index;
      break;
    // if on Chrome or on Firefox but without openerTabId, `tabs.create` opens a tab at the end.
    // but on Firefox and with openerTabId, it opens a new tab next to the opener tab
    case "end":
      tabIndex = bgUtils.isFirefox() ? 9999 : null;
      break;
    // "after" is the default case when there are no options.
    default:
      tabIndex = request.tab.index + 1;
  }
  tabConfig.index = tabIndex;
  tabConfig.active = request.active ?? true;
  tabConfig.openerTabId = request.tab.id;
  // Firefox does not support "about:newtab" in chrome.tabs.create, so omit it.
  if (url != UrlUtils.chromeNewTabUrl) {
    tabConfig.url = url;
  }
  return await chrome.tabs.create(tabConfig);
}

// Open request.url in new window and switch to it.
export async function openUrlInNewWindow(request) {
  const url = await toNavigableUrl(request.url);
  if (url == null) return;
  const winConfig = { focused: request.active ?? true };
  // Firefox does not support "about:newtab" in chrome.windows.create, so omit it.
  if (url != UrlUtils.chromeNewTabUrl) {
    winConfig.url = url;
  }
  await chrome.windows.create(winConfig);
}
