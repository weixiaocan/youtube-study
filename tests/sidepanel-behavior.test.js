const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class FakeClassList {
  add() {}
  remove() {}
  toggle() {}
}

class FakeElement {
  constructor() {
    this.classList = new FakeClassList();
    this.children = [];
    this.style = { setProperty() {} };
    this.dataset = {};
    this.value = "";
    this.files = [];
    this.textContent = "";
    this.listeners = new Map();
    this.queries = new Map();
  }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  async dispatch(type, event = {}) {
    const listener = this.listeners.get(type);
    return listener ? listener(event) : undefined;
  }
  setAttribute() {}
  append(...children) {
    this.children.push(...children);
    for (const child of children) {
      if (child?.className) this.queries.set(`.${child.className}`, child);
    }
  }
  appendChild(child) { this.append(child); }
  focus() {}
  scrollIntoView() {}
  replaceChildren(...children) { this.children = children; }
  querySelector(selector) {
    if (!this.queries.has(selector)) this.queries.set(selector, new FakeElement());
    return this.queries.get(selector);
  }
  querySelectorAll() { return []; }
  getContext() { return { drawImage() {} }; }
  toDataURL() { return "data:image/webp;base64,"; }
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function createSidepanelHarness(options = {}) {
  const elements = new Map();
  const runtimeListeners = [];
  const pendingStorage = new Map();
  const runtimeMessages = [];
  const tabMessages = [];
  let controlledStorage = false;
  let screenshotCounter = 0;

  function element(selector) {
    if (!elements.has(selector)) elements.set(selector, new FakeElement());
    return elements.get(selector);
  }

  const document = {
    hidden: false,
    title: "",
    documentElement: element("html"),
    querySelector: element,
    querySelectorAll() { return []; },
    createElement() { return new FakeElement(); },
    createTextNode(text) { return { textContent: text }; }
  };
  const window = {
    location: { search: "" },
    getSelection() { return null; }
  };
  const initialState = options.initialState || {
    video: { videoId: "initial1", title: "Initial" },
    transcript: [],
    currentTime: 0,
    sessionPath: ""
  };
  const chrome = {
    tabs: {
      async query() { return [{ id: 7, url: "https://www.youtube.com/watch?v=initial1" }]; },
      async sendMessage(_tabId, message) {
        tabMessages.push(message);
        if (message.type === "SAVE_TO_VAULT") {
          return { ok: true, sessionPath: "D:/vault/saved.md" };
        }
        return { ok: true };
      }
    },
    runtime: {
      onMessage: { addListener(listener) { runtimeListeners.push(listener); } },
      async sendMessage(message) {
        runtimeMessages.push(message);
        if (message.type === "ENSURE_CONTENT_SCRIPT") return { ok: true, state: initialState };
        if (message.type === "STORE_SCREENSHOT") {
          screenshotCounter += 1;
          return {
            ok: true,
            screenshot: { id: `${String(screenshotCounter).padStart(10, "0")}-aaaaaaaaaa.webp`, size: 10 }
          };
        }
        if (message.type === "CACHE_STATUS") {
          return options.cacheStatus || { ok: true, removableCount: 0, removableBytes: 0 };
        }
        if (message.type === "CLEANUP_CACHE") {
          return options.cleanupResult || { ok: true, removableCount: 0, removableBytes: 0, removed: [] };
        }
        return { ok: true, records: [] };
      }
    },
    storage: {
      local: {
        get(key) {
          if (!controlledStorage) return Promise.resolve({ [key]: options.initialRecords || [] });
          const request = deferred();
          pendingStorage.set(key, request);
          return request.promise;
        },
        async set() {}
      },
      session: {
        async get() { return {}; },
        async set() {},
        async remove() {}
      }
    }
  };

  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "..", "extension", "sidepanel.js"), "utf8"),
    {
      chrome,
      document,
      window,
      URLSearchParams,
      ResizeObserver: class { observe() {} },
      createImageBitmap: async () => ({ width: 1, height: 1, close() {} }),
      FileReader: class {},
      Image: class {},
      Promise,
      Map,
      Math,
      Date,
      console,
      confirm: () => options.confirmCleanup !== false,
      setInterval() { return 1; },
      setTimeout,
      clearTimeout
    },
    { filename: "sidepanel.js" }
  );
  await tick();
  await tick();

  return {
    beginControlledStorage() { controlledStorage = true; },
    emitVideo(videoId) {
      runtimeListeners[0]({
        type: "VIDEO_STATE_READY",
        state: {
          video: { videoId, title: videoId },
          transcript: [],
          currentTime: 0,
          sessionPath: ""
        }
      });
    },
    resolveRecords(videoId, records) {
      const key = `records:${videoId}`;
      pendingStorage.get(key).resolve({ [key]: records });
    },
    recordCount() { return element("#record-count").textContent; }
    ,transcriptRowCount() { return element("#transcript-list").children.length; }
    ,transcriptSearchValue() { return element("#transcript-search").value; }
    ,async click(selector) { return element(selector).dispatch("click", { preventDefault() {} }); }
    ,tabMessages
    ,runtimeMessages
    ,saveStatus() { return element("#save-status").textContent; }
    ,setValue(selector, value) { element(selector).value = value; }
    ,setFiles(selector, files) { element(selector).files = files; }
    ,async dispatch(selector, type) { return element(selector).dispatch(type, { preventDefault() {} }); }
    ,async settle() { await tick(); await tick(); }
    ,async recordAction(index, selector) {
      return element("#records-list").children[index].querySelector(selector).dispatch("click");
    }
    ,async draftScreenshotAction(index, selector) {
      return element("#screenshot-preview-list").children[index].querySelector(selector).dispatch("click");
    }
  };
}

test("a stale video render cannot replace the current video's records", async () => {
  const harness = await createSidepanelHarness();
  harness.beginControlledStorage();

  harness.emitVideo("videoA1");
  harness.emitVideo("videoB2");
  harness.resolveRecords("videoB2", [{ timestamp: "0:02", time: 2, text: "B" }]);
  await tick();
  harness.resolveRecords("videoA1", [
    { timestamp: "0:01", time: 1, text: "A1" },
    { timestamp: "0:02", time: 2, text: "A2" }
  ]);
  await tick();

  assert.equal(harness.recordCount(), 1);
});

test("a visible knowledge note is created only after the user clicks save", async () => {
  const harness = await createSidepanelHarness({
    initialState: {
      video: { videoId: "video123", title: "Explicit save" },
      transcript: [{ start: 1, text: "Only on click." }],
      currentTime: 0,
      sessionPath: ""
    }
  });

  assert.equal(harness.tabMessages.some((message) => message.type === "SAVE_TO_VAULT"), false);
  await harness.click("#save-to-vault-button");

  assert.equal(harness.tabMessages.filter((message) => message.type === "SAVE_TO_VAULT").length, 1);
  assert.equal(harness.saveStatus(), "已入库");
});

test("saved records can seek, edit, and delete through the side panel", async () => {
  const harness = await createSidepanelHarness({
    initialState: {
      video: { videoId: "video123", title: "Saved video" },
      transcript: [{ start: 12, text: "Original source." }],
      currentTime: 12,
      sessionPath: "D:/vault/saved.md"
    },
    initialRecords: [{
      videoId: "video123",
      timestamp: "0:12",
      time: 12,
      text: "Original source.",
      note: "Old note",
      screenshots: []
    }]
  });

  await harness.recordAction(0, ".record-time");
  assert.equal(harness.tabMessages.some((message) => message.type === "SEEK_TO" && message.seconds === 12), true);

  await harness.recordAction(0, ".edit-button");
  harness.setValue("#draft-note", "Updated note");
  await harness.click("#save-button");
  const editSync = harness.runtimeMessages.filter((message) => message.type === "SYNC_STUDY_RECORDS").at(-1);
  assert.equal(editSync.records[0].note, "Updated note");

  await harness.recordAction(0, ".delete-button");
  const deleteSync = harness.runtimeMessages.filter((message) => message.type === "SYNC_STUDY_RECORDS").at(-1);
  assert.deepEqual(deleteSync.records, []);
  assert.equal(harness.recordCount(), 0);
});

test("editing a record can add several screenshots and remove one", async () => {
  const harness = await createSidepanelHarness({
    initialState: {
      video: { videoId: "video123", title: "Visual video" },
      transcript: [{ start: 12, text: "Diagram." }],
      currentTime: 12,
      sessionPath: "D:/vault/saved.md"
    },
    initialRecords: [{
      videoId: "video123",
      timestamp: "0:12",
      time: 12,
      text: "Diagram.",
      note: "Visual note",
      screenshots: []
    }]
  });

  await harness.recordAction(0, ".edit-button");
  harness.setFiles("#screenshot-input", [
    { type: "image/png", size: 100 },
    { type: "image/png", size: 100 }
  ]);
  await harness.dispatch("#screenshot-input", "change");
  await harness.settle();

  assert.equal(harness.runtimeMessages.filter((message) => message.type === "STORE_SCREENSHOT").length, 2);
  await harness.draftScreenshotAction(0, ".remove-screenshot");
  await harness.settle();
  assert.equal(harness.runtimeMessages.some((message) => message.type === "DELETE_SCREENSHOTS"), true);

  await harness.click("#save-button");
  const sync = harness.runtimeMessages.filter((message) => message.type === "SYNC_STUDY_RECORDS").at(-1);
  assert.equal(sync.records[0].screenshots.length, 1);
});

test("search filters transcript rows and clearing restores them", async () => {
  const harness = await createSidepanelHarness({
    initialState: {
      video: { videoId: "video123", title: "Searchable video" },
      transcript: [
        { start: 1, text: "Attention mechanism." },
        { start: 5, text: "Sparse attention." },
        { start: 9, text: "Context window." }
      ],
      currentTime: 1,
      sessionPath: ""
    }
  });

  assert.equal(harness.transcriptRowCount(), 3);

  harness.setValue("#transcript-search", "attention");
  await harness.dispatch("#transcript-search", "input");
  assert.equal(harness.transcriptRowCount(), 2);

  harness.setValue("#transcript-search", "window");
  await harness.dispatch("#transcript-search", "input");
  assert.equal(harness.transcriptRowCount(), 1);

  harness.setValue("#transcript-search", "");
  await harness.dispatch("#transcript-search", "input");
  assert.equal(harness.transcriptRowCount(), 3);
});

test("cache cleanup previews expired data and requires confirmation", async () => {
  const harness = await createSidepanelHarness({
    cacheStatus: { ok: true, removableCount: 2, removableBytes: 4096 },
    cleanupResult: { ok: true, removableCount: 2, removableBytes: 4096, removed: ["old111", "old222"] },
    confirmCleanup: true
  });

  await harness.click("#clean-cache-button");

  assert.equal(harness.runtimeMessages.some((message) => message.type === "CACHE_STATUS"), true);
  assert.equal(harness.runtimeMessages.some((message) => message.type === "CLEANUP_CACHE"), true);
});
