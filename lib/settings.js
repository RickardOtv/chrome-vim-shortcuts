// The possible destinations for new tabs opened using Vimium's `createTab` command.
const newTabDestinations = {
  browserNewTabPage: "browserNewTabPage",
  customUrl: "customUrl",
};

const defaultOptions = {
  scrollStepSize: 60,
  smoothScroll: true,
  keyMappings: "# Insert your preferred key mappings here.",
  linkHintCharacters: "sadfjklewcmpgh",
  linkHintNumbers: "0123456789",
  filterLinkHints: false,
  hideHud: false,
  userDefinedLinkHintCss: `\
div > .vimiumHintMarker {
/* linkhint boxes */
background: -webkit-gradient(linear, left top, left bottom, color-stop(0%,#FFF785),
  color-stop(100%,#FFC542));
border: 1px solid #E3BE23;
}

div > .vimiumHintMarker span {
/* linkhint text */
color: black;
font-weight: bold;
font-size: 12px;
}

div > .vimiumHintMarker > .matchingCharacter {
}\
`,
  // Default exclusion rules.
  exclusionRules: [
    // Disable Vimium on Gmail.
    {
      passKeys: "",
      pattern: "https?://mail.google.com/*",
    },
  ],

  // NOTE: If a page contains both a single angle-bracket link and a double angle-bracket link,
  // then in most cases the single bracket link will be "prev/next page" and the double bracket
  // link will be "first/last page", so we put the single bracket first in the pattern string so
  // that it gets searched for first.

  // "\bprev\b,\bprevious\b,\bback\b,<,‹,←,«,≪,<<"
  previousPatterns: "prev,previous,back,older,<,\u2039,\u2190,\xab,\u226a,<<",
  // "\bnext\b,\bmore\b,>,›,→,»,≫,>>"
  nextPatterns: "next,more,newer,>,\u203a,\u2192,\xbb,\u226b,>>",
  // default/fall back search engine
  searchUrl: "https://www.google.com/search?q=",
  newTabDestination: newTabDestinations.browserNewTabPage,
  newTabCustomUrl: "",
  grabBackFocus: false,
  regexFindMode: false,
  waitForEnterForFilteredHints: true,
  helpDialog_showAdvancedCommands: false,
  ignoreKeyboardLayout: false,
};

// The storage keys which hold settings.
const settingsKeys = [...Object.keys(defaultOptions), "settingsVersion"];

/*
 * This class fetches and exposes the view over Vimium's settings data, which is stored in
 * chrome.storage. It merges the user's customizations into the default setting values.
 * It dispatches the "change" event when the settings have been changed.
 */
const Settings = {
  _settings: null,
  _chromeStorageListenerInstalled: false,

  defaultOptions,
  newTabDestinations,

  async onLoaded() {
    if (!this.isLoaded()) {
      await this.load();
    }
  },

  async chromeStorageOnChanged(changes, area) {
    // Settings are stored as top-level keys in storage.local, which also holds other data (global
    // marks). Only reload when a settings key changed.
    if (area == "local" && Object.keys(changes).some((k) => settingsKeys.includes(k))) {
      await this.load();
      this.dispatchEvent("change");
    }
  },

  async load() {
    if (!this._chromeStorageListenerInstalled) {
      this._chromeStorageListenerInstalled = true;
      chrome.storage.onChanged.addListener((changes, area) =>
        this.chromeStorageOnChanged(changes, area)
      );
    }

    const result = await chrome.storage.local.get(settingsKeys);
    result["settingsVersion"] = Utils.getCurrentVersion();
    this._settings = Object.assign(globalThis.structuredClone(defaultOptions), result);
  },

  isLoaded() {
    return this._settings != null;
  },

  get(key) {
    if (!this.isLoaded()) {
      throw new Error(`Getting the setting ${key} before settings have been loaded.`);
    }
    return globalThis.structuredClone(this._settings[key]);
  },

  async set(key, value) {
    if (!this.isLoaded()) {
      throw new Error(`Writing the setting ${key} before settings have been loaded.`);
    }
    this._settings[key] = value;
    await this.setSettings(this._settings);
  },

  getSettings() {
    return globalThis.structuredClone(this._settings);
  },

  async setSettings(settings) {
    // Keep only known settings, so an imported backup can't write arbitrary keys into storage.
    settings = Utils.pick(settings, settingsKeys);
    settings["settingsVersion"] = Utils.getCurrentVersion();
    const result = this.pruneOutDefaultValues(settings);
    // If, after pruning, some keys were removed because their values are now equal to the default
    // values, then explicitly clear those from storage. Otherwise they will remain.
    // NOTE(philc): This kind of sharp edge is a reason to switch to storing the settings object as
    // one big object, rather than as top-level keys in chrome.storage. The tradeoff is that each
    // value in chrome-storage has a maximum size.
    const resultKeys = Object.keys(result);
    const removedKeys = Object.keys(settings).filter((key) => !resultKeys.includes(key));
    await chrome.storage.local.remove(removedKeys);
    await chrome.storage.local.set(result);
    await this.load();
  },

  // Returns a new object, removing the keys from `settings` which are equal to the default values
  // for those keys.
  pruneOutDefaultValues(settings) {
    const clonedSettings = globalThis.structuredClone(settings);
    for (const [k, v] of Object.entries(settings)) {
      if (JSON.stringify(v) == JSON.stringify(defaultOptions[k])) {
        delete clonedSettings[k];
      }
    }
    return clonedSettings;
  },

  // Used only by tests.
  async clear() {
    this._settings = null;
    await chrome.storage.local.remove(settingsKeys);
  },
};

Object.assign(Settings, EventDispatcher);

globalThis.Settings = Settings;
