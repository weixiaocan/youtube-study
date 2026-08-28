chrome.runtime.onInstalled.addListener(() => initializeSidePanels().catch(() => {}));
chrome.runtime.onStartup.addListener(() => initializeSidePanels().catch(() => {}));

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || tab.url) configureSidePanel(tabId, tab.url).catch(() => {});
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await configureSidePanel(tabId, tab.url);
  } catch (_) {}
});

const lastCaptureByTab = new Map();
const NATIVE_HOST = "com.lianqian.youtube_study";

async function initializeSidePanels() {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  await chrome.sidePanel.setOptions({ enabled: false });
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map((tab) => (
    tab.id ? configureSidePanel(tab.id, tab.url) : Promise.resolve()
  )));
}

async function configureSidePanel(tabId, urlValue) {
  const enabled = isYouTubeUrl(urlValue);
  await chrome.sidePanel.setOptions({
    tabId,
    ...(enabled ? { path: "sidepanel.html" } : {}),
    enabled
  });
}

function isYouTubeUrl(urlValue) {
  try {
    const url = new URL(urlValue);
    return url.protocol === "https:"
      && (url.hostname === "youtube.com" || url.hostname.endsWith(".youtube.com"));
  } catch (_) {
    return false;
  }
}

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== "save-learning-moment" || !tab?.id) return;
  await captureForTab(tab.id);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "ENSURE_CONTENT_SCRIPT" && Number.isInteger(message.tabId)) {
    ensureContentScript(message.tabId).then(sendResponse);
    return true;
  }

  if (message?.type === "CAPTURE_SHORTCUT" && sender.tab?.id) {
    captureForTab(sender.tab.id).then(sendResponse);
    return true;
  }

  if (message?.type === "FETCH_CAPTION_TRACK" && message.url) {
    fetchCaptionTrack(message.url).then(sendResponse);
    return true;
  }

  if (message?.type === "LOAD_TRANSCRIPT") {
    nativeRequest({ action: "load_transcript", video: message.video }).then(sendResponse);
    return true;
  }

  if (message?.type === "RESTORE_TRANSCRIPT") {
    nativeRequest({ action: "restore_transcript", videoId: message.videoId }).then(sendResponse);
    return true;
  }

  if (message?.type === "SAVE_TO_VAULT") {
    nativeRequest({ action: "save_to_vault", videoId: message.videoId, records: message.records }).then(sendResponse);
    return true;
  }

  if (message?.type === "SYNC_STUDY_RECORDS") {
    nativeRequest({ action: "sync_records", videoId: message.videoId, records: message.records }).then(sendResponse);
    return true;
  }

});

async function nativeRequest(payload) {
  try {
    const result = await chrome.runtime.sendNativeMessage(NATIVE_HOST, payload);
    return result || { ok: false, error: "本地连接器没有返回结果" };
  } catch (error) {
    return {
      ok: false,
      error: `本地连接器不可用（${error.message}）`
    };
  }
}

async function fetchCaptionTrack(url) {
  try {
    const response = await fetch(url, { credentials: "include" });
    return {
      ok: response.ok,
      status: response.status,
      contentType: response.headers.get("content-type") || "",
      text: await response.text()
    };
  } catch (error) {
    return { ok: false, status: 0, text: "", error: String(error) };
  }
}

async function captureForTab(tabId) {
  const now = Date.now();
  if (now - (lastCaptureByTab.get(tabId) || 0) < 600) return { duplicate: true };
  lastCaptureByTab.set(tabId, now);

  try {
    // Chrome 只允许在用户手势仍然有效时打开侧边栏，因此必须先打开，
    // 再执行字幕捕获和存储等异步操作。
    await chrome.sidePanel.open({ tabId });
    const ready = await ensureContentScript(tabId);
    if (!ready.ok) return ready;
    const key = `draft:${tabId}`;
    const stored = await chrome.storage.session.get(key);
    if (stored[key]) {
      await chrome.storage.session.remove(key);
      await chrome.tabs.sendMessage(tabId, { type: "RESUME_VIDEO" });
      chrome.runtime.sendMessage({ type: "DRAFT_CANCELLED", tabId }).catch(() => {});
      return { ok: true, cancelled: true, resumed: true };
    }

    let draft = await chrome.tabs.sendMessage(tabId, { type: "CAPTURE_MOMENT" });
    if (!draft?.videoId) return { ok: false };
    if (!draft.text) {
      const transcriptResult = await chrome.tabs.sendMessage(tabId, { type: "LOAD_TRANSCRIPT" });
      if (transcriptResult?.ok) {
        draft = await chrome.tabs.sendMessage(tabId, { type: "CAPTURE_MOMENT" });
      }
    }

    await chrome.storage.session.set({ [key]: draft });
    chrome.runtime.sendMessage({ type: "DRAFT_READY", tabId }).catch(() => {});
    return { ok: true };
  } catch (error) {
    console.warn("无法保存当前片段", error);
    return { ok: false, error: String(error) };
  }
}

async function ensureContentScript(tabId) {
  let injected = false;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      const state = await chrome.tabs.sendMessage(tabId, { type: "GET_VIDEO_STATE" });
      if (state?.video?.videoId) return { ok: true, state };
    } catch (_) {
      if (!injected) {
        try {
          await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
          injected = true;
        } catch (error) {
          return { ok: false, error: `无法连接 YouTube 页面：${error.message}` };
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return { ok: false, error: "尚未读取到当前视频，请稍后再试" };
}
