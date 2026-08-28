const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function createContentHarness() {
  const listeners = {};
  const runtimeListeners = [];
  let intervalCallback;
  let loadedOnce = false;
  const video = { currentTime: 0, paused: true, pause() {}, play: async () => {} };
  const location = { href: "https://www.youtube.com/watch?v=videoA1" };
  const window = {
    addEventListener(type, listener) { listeners[type] = listener; },
    postMessage() {},
    getSelection() { return null; }
  };
  const document = {
    documentElement: { dataset: {}, appendChild() {} },
    head: { appendChild() {} },
    createElement() { return { remove() {} }; },
    querySelector(selector) { return selector === "video" ? video : null; }
  };
  const chrome = {
    runtime: {
      getURL: (file) => file,
      onMessage: { addListener(listener) { runtimeListeners.push(listener); } },
      async sendMessage(message) {
        if (message.type === "LOAD_TRANSCRIPT") {
          loadedOnce = true;
          return {
            ok: true,
            transcript: [{ id: 0, start: 3, duration: 2, text: "cached line" }],
            sessionPath: ""
          };
        }
        if (message.type === "RESTORE_TRANSCRIPT" && loadedOnce && message.videoId === "videoA1") {
          return {
            ok: true,
            transcript: [{ id: 0, start: 3, duration: 2, text: "cached line" }],
            sessionPath: ""
          };
        }
        return { ok: true };
      }
    }
  };
  const context = {
    chrome,
    document,
    location,
    window,
    URL,
    Map,
    Date,
    Math,
    Promise,
    console,
    DOMParser: class {},
    HTMLInputElement: class {},
    HTMLTextAreaElement: class {},
    clearTimeout() {},
    setTimeout(callback) { callback(); return 1; },
    setInterval(callback) { intervalCallback = callback; return 1; }
  };
  window.window = window;
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "..", "extension", "content.js"), "utf8"),
    context,
    { filename: "content.js" }
  );

  function publishVideo(videoId) {
    location.href = `https://www.youtube.com/watch?v=${videoId}`;
    intervalCallback();
    listeners.message({
      source: window,
      data: {
        source: "youtube-study-bridge",
        type: "PLAYER_DATA",
        payload: { videoId, title: videoId, author: "author" }
      }
    });
  }

  function sendToContent(message) {
    return new Promise((resolve) => {
      const asyncResponse = runtimeListeners[0](message, {}, resolve);
      if (asyncResponse !== true) resolve(undefined);
    });
  }

  return { publishVideo, sendToContent };
}

test("restores a previously fetched transcript after leaving and returning to a video", async () => {
  const harness = createContentHarness();
  harness.publishVideo("videoA1");
  const firstLoad = await harness.sendToContent({ type: "LOAD_TRANSCRIPT" });
  assert.equal(firstLoad.transcript[0].text, "cached line");

  harness.publishVideo("videoB2");
  harness.publishVideo("videoA1");
  await new Promise((resolve) => setImmediate(resolve));

  const restored = await harness.sendToContent({ type: "GET_VIDEO_STATE" });
  assert.equal(restored.video.videoId, "videoA1");
  assert.equal(restored.transcript[0]?.text, "cached line");
});
