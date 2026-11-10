import "./test_helper.js";
import "../../lib/settings.js";

context("settings", () => {
  setup(async () => {
    await Settings.load();
  });

  teardown(async () => {
    await Settings.clear();
    await chrome.storage.sync.clear();
  });

  should("save settings to storage.local, not storage.sync", async () => {
    await Settings.set("scrollStepSize", 123);
    assert.equal(123, (await chrome.storage.local.get("scrollStepSize")).scrollStepSize);
    assert.equal({}, await chrome.storage.sync.get(null));
  });

  should("ignore unknown keys, e.g. from an imported backup", async () => {
    await Settings.setSettings({ scrollStepSize: 50, notASetting: "x" });
    assert.equal(undefined, (await chrome.storage.local.get("notASetting")).notASetting);
    assert.equal(50, Settings.get("scrollStepSize"));
  });

  should("not store values equal to the defaults", async () => {
    await Settings.set("scrollStepSize", 123);
    await Settings.set("scrollStepSize", Settings.defaultOptions.scrollStepSize);
    assert.equal(undefined, (await chrome.storage.local.get("scrollStepSize")).scrollStepSize);
  });

  should("drop invalid values from an imported backup", async () => {
    await Settings.setSettings({
      scrollStepSize: "lots",
      searchUrl: "data:text/html,<h1>%s</h1>",
      newTabDestination: '"]',
      newTabCustomUrl: "file:///etc/passwd",
      exclusionRules: "not an array",
      filterLinkHints: true,
    });
    const defaults = Settings.defaultOptions;
    assert.equal(defaults.scrollStepSize, Settings.get("scrollStepSize"));
    assert.equal(defaults.searchUrl, Settings.get("searchUrl"));
    assert.equal(defaults.newTabDestination, Settings.get("newTabDestination"));
    assert.equal(defaults.newTabCustomUrl, Settings.get("newTabCustomUrl"));
    assert.equal(defaults.exclusionRules, Settings.get("exclusionRules"));
    assert.equal(true, Settings.get("filterLinkHints"));
  });

  should("drop exclusion rules with missing fields", () => {
    const rules = [{ pattern: "https://a/*" }];
    assert.equal({}, Settings.validSettings({ exclusionRules: rules }));
  });

  should("ignore invalid values already in storage", async () => {
    await chrome.storage.local.set({ searchUrl: "javascript:alert(%s)" });
    await Settings.load();
    assert.equal(Settings.defaultOptions.searchUrl, Settings.get("searchUrl"));
  });

  should("default to the browser's new tab page", () => {
    assert.equal(
      Settings.newTabDestinations.browserNewTabPage,
      Settings.get("newTabDestination"),
    );
  });
});
