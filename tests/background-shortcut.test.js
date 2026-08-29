const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function createBackgroundHarness() {
  let commandListener;
  let runtimeListener;
  const removedKeys = [];
  const tabMessages = [];
  const runtimeMessages = [];
  const nativeMessages = [];
  const draftKey = "draft:7:video123";

  const chrome = {
    runtime: {
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: { addListener(listener) { runtimeListener = listener; } },
      async sendMessage(message) { runtimeMessages.push(message); },
      async sendNativeMessage(_host, message) {
        nativeMessages.push(message);
        return { ok: true };
      }
    },
    tabs: {
      onUpdated: { addListener() {} },
      onActivated: { addListener() {} },
      onRemoved: { addListener() {} },
      async get() { return { id: 7, url: "https://www.youtube.com/watch?v=video123" }; },
      async query() { return []; },
      async sendMessage(_tabId, message) {
        tabMessages.push(message);
        if (message.type === "GET_VIDEO_STATE") {
          return { video: { videoId: "video123" } };
        }
        return { ok: true };
      }
    },
    sidePanel: {
      async setPanelBehavior() {},
      async setOptions() {},
      async open() {}
    },
    commands: {
      onCommand: { addListener(listener) { commandListener = listener; } }
    },
    storage: {
      session: {
        async get(key) { return key === draftKey ? { [draftKey]: { note: "unfinished" } } : {}; },
        async remove(key) { removedKeys.push(key); },
        async set() {}
      }
    },
    scripting: { async executeScript() {} }
  };

  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "..", "extension", "background.js"), "utf8"),
    { chrome, URL, Map, Date, Promise, console, setTimeout },
    { filename: "background.js" }
  );

  return {
    async pressShortcut() {
      await commandListener("save-learning-moment", { id: 7 });
    },
    sendRuntime(message) {
      return new Promise((resolve) => {
        const asynchronous = runtimeListener(message, {}, resolve);
        if (asynchronous !== true) resolve(undefined);
      });
    },
    removedKeys,
    tabMessages,
    runtimeMessages,
    nativeMessages
  };
}

test("pressing Alt+N again keeps an unfinished draft", async () => {
  const harness = createBackgroundHarness();

  await harness.pressShortcut();

  assert.deepEqual(harness.removedKeys, []);
  assert.equal(harness.tabMessages.some((message) => message.type === "RESUME_VIDEO"), false);
  assert.equal(harness.runtimeMessages.some((message) => message.type === "DRAFT_READY"), true);
});

test("browser messages preserve the native host action contract", async () => {
  const harness = createBackgroundHarness();

  await harness.sendRuntime({ type: "SAVE_TO_VAULT", videoId: "video123", records: [] });
  await harness.sendRuntime({ type: "SYNC_STUDY_RECORDS", videoId: "video123", records: [] });
  await harness.sendRuntime({ type: "DELETE_SCREENSHOTS", videoId: "video123", screenshotIds: ["one.webp"] });
  await harness.sendRuntime({ type: "CACHE_STATUS" });
  await harness.sendRuntime({ type: "CLEANUP_CACHE" });

  assert.deepEqual(
    harness.nativeMessages.map((message) => message.action),
    ["save_to_vault", "sync_records", "delete_screenshots", "cache_status", "cleanup_cache"]
  );
});
