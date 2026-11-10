import * as TabOperations from "./tab_operations.js";

// This returns the key which is used for storing mark locations in chrome.storage.local.
// Exported for tests.
export function getLocationKey(markName) {
  return `vimiumGlobalMark|${markName}`;
}

// Get the part of a URL we use for matching here (that is, everything up to the first anchor).
function getBaseUrl(url) {
  return url.split("#")[0];
}

// Local marks are stored under a SHA-256 hash of the frame's URL, so storage never holds a
// readable list of the pages you visited (URLs can carry tokens in their query string).
async function getLocalMarkKey(url, markName) {
  const bytes = new TextEncoder().encode(getBaseUrl(url));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
  return `vimiumMark|${hex}|${markName}`;
}

const isValidMarkName = (name) => typeof name == "string" && name.length > 0 && name.length <= 2;

// Save a local mark for the sending frame's URL. `mark` is the JSON string from content marks.js.
export async function setLocal({ markName, mark }, sender) {
  if (!isValidMarkName(markName) || typeof mark != "string" || mark.length > 1000) return;
  await chrome.storage.local.set({ [await getLocalMarkKey(sender.url, markName)]: mark });
}

// Returns the sending frame's local mark, or null.
export async function getLocal({ markName }, sender) {
  if (!isValidMarkName(markName)) return null;
  const key = await getLocalMarkKey(sender.url, markName);
  return (await chrome.storage.local.get(key))[key] ?? null;
}

// Create a global mark. We record vimiumSecret with the mark so that we can tell later, when the
// mark is used, whether this is the original Vimium session or a subsequent session. This affects
// whether or not tabId can be considered valid.
export async function create(req, sender) {
  const items = await chrome.storage.session.get("vimiumSecret");
  const markInfo = {
    vimiumSecret: items.vimiumSecret,
    markName: req.markName,
    url: getBaseUrl(sender.tab.url),
    tabId: sender.tab.id,
    scrollX: req.scrollX,
    scrollY: req.scrollY,
  };

  if ((markInfo.scrollX != null) && (markInfo.scrollY != null)) {
    saveMark(markInfo);
  } else {
    // The front-end frame hasn't provided the scroll position (because it's not the top frame
    // within its tab). We need to ask the top frame what its scroll position is.
    chrome.tabs.sendMessage(sender.tab.id, { handler: "getScrollPosition" }, (response) => {
      if (response == null) return;
      saveMark(Object.assign(markInfo, { scrollX: response.scrollX, scrollY: response.scrollY }));
    });
  }
}

function saveMark(markInfo) {
  const item = {};
  item[getLocationKey(markInfo.markName)] = markInfo;
  chrome.storage.local.set(item);
}

// Goto a global mark. We try to find the original tab. If we can't find that, then we try to find
// another tab with the original URL, and use that. And if we can't find such an existing tab, then
// we create a new one. Whichever of those we do, we then set the scroll position to the original
// scroll position.
export async function goto(req) {
  const vimiumSecret = (await chrome.storage.session.get("vimiumSecret"))["vimiumSecret"];
  const key = getLocationKey(req.markName);
  const items = await chrome.storage.local.get(key);
  const markInfo = items[key];
  if (markInfo == null) return;
  if (markInfo.vimiumSecret !== vimiumSecret) {
    // This is a different Vimium instantiation, so markInfo.tabId is definitely out of date.
    Utils.debugLog("marks: vimiumSecret is incorrect.");
    await focusOrLaunch(markInfo, req);
  } else {
    // Check whether markInfo.tabId still exists. According to
    // https://developer.chrome.com/extensions/tabs, tab Ids are unqiue within a Chrome
    // session. So, if we find a match, we can use it.
    let tab;
    // This will throw an error if the tab doesn't exist.
    try {
      tab = await chrome.tabs.get(markInfo.tabId);
    } catch {
      // Swallow.
    }
    const originalTabStillExists = tab?.url && (markInfo.url === getBaseUrl(tab.url));
    if (originalTabStillExists) {
      await gotoPositionInTab(markInfo);
    } else {
      await focusOrLaunch(markInfo, req);
    }
  }
}

// Focus an existing tab and scroll to the given position within it.
async function gotoPositionInTab({ tabId, scrollX, scrollY }) {
  const tab = await chrome.tabs.update(tabId, { active: true });
  chrome.windows.update(tab.windowId, { focused: true });
  chrome.tabs.sendMessage(tabId, { handler: "setScrollPosition", scrollX, scrollY });
}

// The tab we're trying to find no longer exists. We either find another tab with a matching URL and
// use it, or we create a new tab.
async function focusOrLaunch(markInfo, req) {
  // If we're not going to be scrolling to a particular position in the tab, then we choose all tabs
  // with a matching URL prefix. Otherwise, we require an exact match (because it doesn't make sense
  // to scroll unless there's an exact URL match).
  const markIsScrolled = markInfo.scrollX > 0 || markInfo.scrollY > 0;
  const query = markIsScrolled ? markInfo.url : `${markInfo.url}*`;
  const tabs = await chrome.tabs.query({ url: query });
  if (tabs.length > 0) {
    // There is at least one matching tab. Pick one and go to it.
    const tab = await pickTab(tabs);
    gotoPositionInTab(Object.assign(markInfo, { tabId: tab.id }));
  } else {
    // There is no existing matching tab. We'll have to create one.
    const tab = await TabOperations.openUrlInNewTab(
      Object.assign(req, { url: getBaseUrl(markInfo.url) }),
    );
    if (tab == null) return;
    // Note. tabLoadedHandlers is defined in "main.js". The handler below will be called when the
    // tab is loaded, its DOM is ready and it registers with the background page.
    tabLoadedHandlers[tab.id] = () => gotoPositionInTab(Object.assign(markInfo, { tabId: tab.id }));
  }
}

// Given a list of tabs candidate tabs, pick one. Prefer tabs in the current window and tabs with
// shorter (matching) URLs.
async function pickTab(tabs) {
  // NOTE(philc): We assume getCurrent() can return null, but I didn't confirm this. Also, it should
  // be impossible for the user to invoke Vimium-related keys if all windows are closed.
  const window = await chrome.windows.getCurrent();
  const windowId = window?.id;
  // Prefer tabs in the current window, if there are any.
  const tabsInWindow = tabs.filter((tab) => tab.windowId === windowId);
  if (tabsInWindow.length > 0) tabs = tabsInWindow;
  // If more than one tab remains and the current tab is still a candidate, then don't pick the
  // current tab (because jumping to it does nothing).
  if (tabs.length > 1) {
    tabs = tabs.filter((t) => !t.active);
  }

  // Prefer shorter URLs.
  tabs.sort((a, b) => a.url.length - b.url.length);
  return tabs[0];
}
