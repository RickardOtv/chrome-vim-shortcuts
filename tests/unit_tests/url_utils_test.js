import "./test_helper.js";
import "../../lib/settings.js";
import "../../lib/url_utils.js";

context("isUrl", () => {
  should("accept valid URLs", async () => {
    assert.isTrue(await UrlUtils.isUrl("www.google.com"));
    assert.isTrue(await UrlUtils.isUrl("www.bbc.co.uk"));
    assert.isTrue(await UrlUtils.isUrl("yahoo.com"));
    assert.isTrue(await UrlUtils.isUrl("nunames.nu"));
    assert.isTrue(await UrlUtils.isUrl("user:pass@ftp.xyz.com/test"));

    assert.isTrue(await UrlUtils.isUrl("localhost/index.html"));
    assert.isTrue(await UrlUtils.isUrl("127.0.0.1:8192/test.php"));

    // IPv6
    assert.isTrue(await UrlUtils.isUrl("[::]:9000"));

    // Long TLDs
    assert.isTrue(await UrlUtils.isUrl("testing.social"));
    assert.isTrue(await UrlUtils.isUrl("testing.onion"));

    // // Internal URLs.
    assert.isTrue(
      await UrlUtils.isUrl(
        "moz-extension://c66906b4-3785-4a60-97bc-094a6366017e/pages/options.html",
      ),
    );
  });

  should("reject invalid URLs", async () => {
    assert.isFalse(await UrlUtils.isUrl("a.x"));
    assert.isFalse(await UrlUtils.isUrl("www-domain-tld"));
    assert.isFalse(await UrlUtils.isUrl("http://www.example.com/ has-space"));
  });
});

context("convertToUrl", () => {
  should("detect and clean up valid URLs", async () => {
    assert.equal("http://www.google.com/", await UrlUtils.convertToUrl("http://www.google.com/"));
    assert.equal(
      "http://www.google.com/",
      await UrlUtils.convertToUrl("    http://www.google.com/     "),
    );
    assert.equal("http://www.google.com", await UrlUtils.convertToUrl("www.google.com"));
    assert.equal("http://google.com", await UrlUtils.convertToUrl("google.com"));
    assert.equal("http://localhost", await UrlUtils.convertToUrl("localhost"));
    assert.equal("http://xyz.museum", await UrlUtils.convertToUrl("xyz.museum"));
    assert.equal("chrome://extensions", await UrlUtils.convertToUrl("chrome://extensions"));
    assert.equal(
      "http://user:pass@ftp.xyz.com/test",
      await UrlUtils.convertToUrl("user:pass@ftp.xyz.com/test"),
    );
    assert.equal("http://127.0.0.1", await UrlUtils.convertToUrl("127.0.0.1"));
    assert.equal("http://127.0.0.1:8080", await UrlUtils.convertToUrl("127.0.0.1:8080"));
    assert.equal("http://[::]:8080", await UrlUtils.convertToUrl("[::]:8080"));
    assert.equal("view-source:    0.0.0.0", await UrlUtils.convertToUrl("view-source:    0.0.0.0"));
  });
});


context("hasChromeProtocol", () => {
  should("detect chrome prefixes of URLs", () => {
    assert.isTrue(UrlUtils.hasChromeProtocol("about:foobar"));
    assert.isTrue(UrlUtils.hasChromeProtocol("view-source:foobar"));
    assert.isTrue(UrlUtils.hasChromeProtocol("chrome-extension:foobar"));
    assert.isFalse(UrlUtils.hasChromeProtocol(""));
    assert.isFalse(UrlUtils.hasChromeProtocol("about"));
    assert.isFalse(UrlUtils.hasChromeProtocol("view-source"));
    assert.isFalse(UrlUtils.hasChromeProtocol("chrome-extension"));
  });
});

context("isSafeToOpen", () => {
  should("allow web pages and the browser's new tab and blank pages", () => {
    assert.isTrue(UrlUtils.isSafeToOpen("https://example.com"));
    assert.isTrue(UrlUtils.isSafeToOpen("http://example.com/a?b"));
    assert.isTrue(UrlUtils.isSafeToOpen("about:newtab"));
    assert.isTrue(UrlUtils.isSafeToOpen("about:blank"));
    assert.isTrue(UrlUtils.isSafeToOpen("view-source:https://example.com"));
  });

  should("refuse everything else", () => {
    assert.isFalse(UrlUtils.isSafeToOpen("file:///etc/passwd"));
    assert.isFalse(UrlUtils.isSafeToOpen("chrome://settings"));
    assert.isFalse(UrlUtils.isSafeToOpen("chrome-extension://abc/pages/reload.html"));
    assert.isFalse(UrlUtils.isSafeToOpen("vscode://file/x"));
    assert.isFalse(UrlUtils.isSafeToOpen("about:config"));
    assert.isFalse(UrlUtils.isSafeToOpen("view-source:file:///etc/passwd"));
    assert.isFalse(UrlUtils.isSafeToOpen("javascript:alert(1)"));
    assert.isFalse(UrlUtils.isSafeToOpen("data:text/html,hi"));
    assert.isFalse(UrlUtils.isSafeToOpen(null));
  });
});

context("isBlockedUrl", () => {
  should("block URLs which can run code or spoof content", () => {
    assert.isTrue(UrlUtils.isBlockedUrl("javascript:foobar"));
    assert.isTrue(UrlUtils.isBlockedUrl("  JavaScript:foobar"));
    assert.isTrue(UrlUtils.isBlockedUrl("data:text/html,hi"));
    assert.isTrue(UrlUtils.isBlockedUrl("vbscript:foobar"));
    assert.isFalse(UrlUtils.isBlockedUrl("http://example.com"));
    assert.isFalse(UrlUtils.isBlockedUrl("javascript tutorial"));
  });
});
