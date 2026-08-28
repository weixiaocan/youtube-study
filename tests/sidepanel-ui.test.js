const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const extensionDir = path.join(__dirname, "..", "extension");
const html = fs.readFileSync(path.join(extensionDir, "sidepanel.html"), "utf8");
const css = fs.readFileSync(path.join(extensionDir, "sidepanel.css"), "utf8");
const js = fs.readFileSync(path.join(extensionDir, "sidepanel.js"), "utf8");

test("keeps the interaction hooks used by the extension", () => {
  [
    "save-to-vault-button",
    "load-transcript-button",
    "load-transcript-cta",
    "transcript-list",
    "records-list",
    "draft-note",
    "add-screenshots-button",
    "screenshot-input",
    "screenshot-preview-list",
    "save-button"
  ].forEach((id) => assert.match(html, new RegExp(`id=["']${id}["']`)));
});

test("supports several user-provided screenshots without tab capture permissions", () => {
  const manifest = fs.readFileSync(path.join(extensionDir, "manifest.json"), "utf8");
  assert.match(html, /id="screenshot-input"[^>]*multiple/);
  assert.match(js, /addScreenshotFiles/);
  assert.match(js, /clipboardData/);
  assert.match(js, /dataTransfer/);
  assert.match(js, /draft\.note = elements\.draftNote\.value/);
  assert.match(js, /chrome\.storage\.session\.set/);
  assert.doesNotMatch(manifest, /activeTab/);
  assert.doesNotMatch(js, /captureVisibleTab/);
});

test("uses the warm learning-workbench design tokens", () => {
  ["#f7f0e3", "#c96f3a", "#6f7d4e", "#4a3324"].forEach((color) => {
    assert.match(css.toLowerCase(), new RegExp(color));
  });
  assert.match(css, /prefers-reduced-motion/);
  assert.doesNotMatch(css.toLowerCase(), /linear-gradient\([^)]*(blue|purple|#[0-9a-f]{6})/);
});

test("avoids browser-default blockquotes and exposes clear save state", () => {
  assert.doesNotMatch(html, /<blockquote/i);
  assert.doesNotMatch(js, /<blockquote/i);
  assert.match(html, /id="save-status"/);
  assert.match(html, /id="transcript-count"/);
  assert.match(js, /已入库/);
  assert.match(js, /待入库/);
});

test("developer preview cannot replace normal Chrome initialization", () => {
  assert.match(js, /if \(isPreview\) initializePreview\(\);\s*else initialize\(\);/);
  assert.match(js, /if \(!isPreview\) \{\s*chrome\.runtime\.onMessage/);
});
