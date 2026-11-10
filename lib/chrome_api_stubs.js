//
// Mock the Chrome extension API for our tests. In Deno and Pupeteer, the Chrome extension APIs are
// not available.
//

// Never install stubs inside the real extension: a website can frame hud_page.html with
// ?dom_tests=true, and the stubs would disable the secret check in ui_component_messenger.js.
const isRealExtension = globalThis.chrome?.runtime?.id != null;
const shouldInstallStubs = !isRealExtension &&
  (globalThis.document?.location.pathname.includes("dom_tests.html") ||
    // This query string is added to pages that we load in iframes from dom_tests.html, like
    // hud_page.html
    globalThis.document?.location.search.includes("dom_tests=true"));

if (shouldInstallStubs) {
  globalThis.chromeMessages = [];

  document.hasFocus = () => true;

  globalThis.forTrusted = (handler) => handler;

  const fakeManifest = {
    version: "1.51",
  };

  globalThis.chrome = {
    runtime: {
      id: 123456,

      connect() {
        return {
          onMessage: {
            addListener() {},
          },
          onDisconnect: {
            addListener() {},
          },
          postMessage() {},
        };
      },
      onMessage: {
        addListener() {},
      },
      sendMessage(message) {
        // TODO(philc): This stub should return a an empty Promise, not the length of the
        // chromeMessages array. Some portion fo the dom_tests.html setup depends on this value, so
        // the tests break. Fix.
        return chromeMessages.unshift(message);
      },
      getManifest() {
        return fakeManifest;
      },
      getURL(url) {
        return `../../${url}`;
      },
    },
    storage: {
      local: {
        async get() {
          return await {};
        },
        async set() {},
      },
      sync: {
        async get() {
          return await {};
        },
        async set() {},
      },
      session: {
        async get() {
          return await {};
        },
        async set() {},
      },
      onChanged: {
        addListener() {},
      },
    },
    extension: {
      inIncognitoContext: false,
      getURL(url) {
        return chrome.runtime.getURL(url);
      },
    },
  };
}
