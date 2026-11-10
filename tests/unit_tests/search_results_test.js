import "./test_helper.js";
import "../../content_scripts/search_results.js";

context("SearchResults.getSite", () => {
  const site = (url) => SearchResults.getSite(new URL(url))?.name;

  should("match Google result pages", () => {
    assert.equal("Google", site("https://www.google.com/search?q=a"));
    assert.equal("Google", site("https://www.google.co.uk/search?q=a"));
    assert.equal("Google", site("https://google.se/search?q=a"));
  });

  should("not match other pages", () => {
    assert.equal(undefined, site("https://www.google.com/"));
    assert.equal(undefined, site("https://mail.google.com/search"));
    assert.equal(undefined, site("https://google.com.evil.example/search"));
    assert.equal(undefined, site("https://example.com/search"));
  });
});
