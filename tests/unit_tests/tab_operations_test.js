import "./test_helper.js";
import "../../lib/settings.js";
import * as to from "../../background_scripts/tab_operations.js";

await Settings.load();

context("TabOperations openurlInCurrentTab", () => {
  should("open a regular URL", async () => {
    let url = null;
    stub(chrome.tabs, "update", (_id, args) => {
      url = args.url;
    });
    const expected = "http://example.com";
    await to.openUrlInCurrentTab({ url: expected });
    assert.equal(expected, url);
  });

  should("open a non-URL as a search with the default search engine", async () => {
    let url = null;
    stub(chrome.tabs, "update", (_id, args) => {
      url = args.url;
    });
    await to.openUrlInCurrentTab({ url: "example query" });
    assert.equal("https://www.google.com/search?q=example%20query", url);
  });

  should("not open javascript: or data: URLs", async () => {
    let called = false;
    stub(chrome.tabs, "update", () => {
      called = true;
    });
    stub(chrome.scripting, "executeScript", () => {
      called = true;
    });
    await to.openUrlInCurrentTab({ url: "javascript:console.log('hello')" });
    await to.openUrlInCurrentTab({ url: " JAVASCRIPT:console.log('hello')" });
    await to.openUrlInCurrentTab({ url: "data:text/html,<h1>hi</h1>" });
    await to.openUrlInCurrentTab({ url: "file:///etc/passwd" });
    await to.openUrlInCurrentTab({ url: "chrome://settings" });
    await to.openUrlInCurrentTab({ url: "chrome-extension://abc/pages/reload.html" });
    assert.isFalse(called);
  });
});

context("TabOperations openUrlInNewTab", () => {
  should("open a regular URL", async () => {
    let config = null;
    stub(chrome.tabs, "create", (_config) => {
      config = _config;
      const newTab = { url: config.url };
      return newTab;
    });
    const expected = "http://example.com";
    const tab = await to.openUrlInNewTab({
      tab: { index: 1 },
      position: "after",
      url: expected,
    });
    assert.equal(2, config.index);
    assert.equal(expected, tab.url);
  });

  should("open a non-URL as a search with the default search engine", async () => {
    let config = null;
    stub(chrome.tabs, "create", (_config) => {
      config = _config;
      return {};
    });
    await to.openUrlInNewTab({ tab: { index: 1 }, position: "after", url: "example query" });
    assert.equal("https://www.google.com/search?q=example%20query", config.url);
    assert.equal(2, config.index);
  });

  should("not open a data: URL", async () => {
    let called = false;
    stub(chrome.tabs, "create", () => {
      called = true;
    });
    const tab = await to.openUrlInNewTab({ tab: { index: 1 }, url: "data:text/html,hi" });
    assert.isFalse(called);
    assert.equal(undefined, tab);
  });
});

context("TabOperations openUrlInNewWindow", () => {
  should("not open a javascript: URL", async () => {
    let called = false;
    stub(chrome.windows, "create", () => {
      called = true;
    });
    await to.openUrlInNewWindow({ url: "javascript:alert(1)" });
    assert.isFalse(called);
  });
});
