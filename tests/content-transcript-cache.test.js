const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class FakeVideoElement {
  constructor() {
    this.currentTime = 0;
    this.paused = true;
    this.playbackRate = 1;
  }
  pause() { this.paused = true; }
  async play() { this.paused = false; }
}

function createContentHarness() {
  const listeners = {};
  const runtimeListeners = [];
  let intervalCallback;
  let loadedOnce = false;
  let timeupdateListener;
  const video = new FakeVideoElement();
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
    querySelector(selector) { return selector === "video" ? video : null; },
    addEventListener(type, listener) { if (type === "timeupdate") timeupdateListener = listener; }
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
    HTMLVideoElement: FakeVideoElement,
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

  function triggerTimeupdate() {
    timeupdateListener?.({ target: video });
  }

  return { publishVideo, sendToContent, video, triggerTimeupdate };
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

test("practice segment plays at the chosen rate and auto-pauses at its end", async () => {
  const harness = createContentHarness();
  harness.publishVideo("videoA1");

  await harness.sendToContent({ type: "PRACTICE_PLAY_SEGMENT", start: 10, end: 20, rate: 0.8 });
  assert.equal(harness.video.currentTime, 10);
  assert.equal(harness.video.playbackRate, 0.8);
  assert.equal(harness.video.paused, false);

  harness.video.currentTime = 20;
  harness.triggerTimeupdate();
  assert.equal(harness.video.paused, true);

  harness.video.currentTime = 21;
  harness.triggerTimeupdate();
  assert.equal(harness.video.paused, true);

  await harness.sendToContent({ type: "PRACTICE_SET_RATE", rate: 1.25 });
  assert.equal(harness.video.playbackRate, 1.25);

  await harness.sendToContent({ type: "PRACTICE_PAUSE" });
  assert.equal(harness.video.paused, true);
});

test("practice playback stops tracking after the video changes", async () => {
  const harness = createContentHarness();
  harness.publishVideo("videoA1");
  await harness.sendToContent({ type: "PRACTICE_PLAY_SEGMENT", start: 5, end: 30, rate: 1 });

  harness.publishVideo("videoB2");
  harness.video.currentTime = 30;
  harness.triggerTimeupdate();
  assert.equal(harness.video.paused, false);
});

