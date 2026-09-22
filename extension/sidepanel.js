const elements = {
  empty: document.querySelector("#empty-state"),
  transcriptPanel: document.querySelector("#transcript-panel"),
  recordsPanel: document.querySelector("#records-panel"),
  transcriptList: document.querySelector("#transcript-list"),
  transcriptToolbar: document.querySelector("#transcript-toolbar"),
  transcriptSearch: document.querySelector("#transcript-search"),
  practiceEntry: document.querySelector("#practice-entry"),
  practiceView: document.querySelector("#practice-view"),
  practiceBack: document.querySelector("#practice-back"),
  practiceListHead: document.querySelector("#practice-list-head"),
  practiceEmpty: document.querySelector("#practice-empty"),
  practiceList: document.querySelector("#practice-list"),
  practicePanel: document.querySelector("#practice-panel"),
  practiceRange: document.querySelector("#practice-range"),
  practiceSubtitles: document.querySelector("#practice-subtitles"),
  practiceRepeat: document.querySelector("#practice-repeat"),
  practiceRateGroup: document.querySelectorAll(".practice-rate"),
  practiceSubtitleToggle: document.querySelector("#practice-subtitle-toggle"),
  practiceExit: document.querySelector("#practice-exit"),
  practiceFinish: document.querySelector("#practice-finish"),
  practiceNext: document.querySelector("#practice-next"),
  shadowingStart: document.querySelector("#shadowing-start"),
  shadowingListen: document.querySelector("#shadowing-listen"),
  shadowingNext: document.querySelector("#shadowing-next"),
  shadowingProgress: document.querySelector("#shadowing-progress"),
  shadowingSentence: document.querySelector("#shadowing-sentence"),
  shadowingStatus: document.querySelector("#shadowing-status"),
  recordsList: document.querySelector("#records-list"),
  transcriptCount: document.querySelector("#transcript-count"),
  recordCount: document.querySelector("#record-count"),
  saveStatus: document.querySelector("#save-status"),
  saveToVaultButton: document.querySelector("#save-to-vault-button"),
  cleanCacheButton: document.querySelector("#clean-cache-button"),
  loadTranscriptButton: document.querySelector("#load-transcript-button"),
  loadTranscriptCta: document.querySelector("#load-transcript-cta"),
  transcriptEmpty: document.querySelector("#transcript-empty"),
  composer: document.querySelector("#composer"),
  composerTitle: document.querySelector("#composer-title"),
  draftTime: document.querySelector("#draft-time"),
  draftText: document.querySelector("#draft-text"),
  draftNote: document.querySelector("#draft-note"),
  addScreenshotsButton: document.querySelector("#add-screenshots-button"),
  screenshotInput: document.querySelector("#screenshot-input"),
  screenshotHint: document.querySelector("#screenshot-hint"),
  screenshotPreviewList: document.querySelector("#screenshot-preview-list"),
  cancelEditButton: document.querySelector("#cancel-edit-button"),
  saveButton: document.querySelector("#save-button"),
  toast: document.querySelector("#toast")
};

let activeTabId = null;
let state = null;
let records = [];
let draft = null;
let composerVideoId = null;
let currentTranscriptIndex = -1;
let activePanel = "transcript";
let isAddingScreenshots = false;
let editingRecordIndex = -1;
let transcriptFilter = "";
let lastUserScrollAt = 0;
let suppressScrollTracking = false;
// Listening Practice (V2)：与笔记功能独立，围绕学习笔记自动切段，只读现有字幕与播放器。
let practice = null;          // { videoId, segments, index, rate, showSubtitles } 当前片段视图
let practiceViewOpen = false; // 独立练习界面是否打开
let practicePlaying = false;
let practiceActiveEnd = 0;
let shadowing = null;         // { index } 或 null
const screenshotPreviews = new Map();
const isPreview = new URLSearchParams(window.location.search).has("preview");

setComposerIdle();
if (isPreview) initializePreview();
else initialize();

async function initialize() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id;
  if (!activeTabId || !tab.url?.startsWith("https://www.youtube.com/")) return;

  try {
    const ready = await chrome.runtime.sendMessage({ type: "ENSURE_CONTENT_SCRIPT", tabId: activeTabId });
    if (!ready?.ok) throw new Error(ready?.error || "无法连接 YouTube 页面");
    state = ready.state;
    await renderState();
  } catch (error) {
    showEmpty(error.message || "无法连接 YouTube 页面");
  }
}

if (!isPreview) {
  // 拉取播放时间：面板可见时才向页面查询，页面不再持续推送，service worker 无谓唤醒被消除。
  setInterval(async () => {
    if (document.hidden || (activePanel !== "transcript" && !practice && !practiceViewOpen)) return;
    if (!activeTabId || !state?.video) return;
    try {
      const result = await chrome.tabs.sendMessage(activeTabId, { type: "GET_TIME" });
      if (result?.videoId === state.video.videoId) {
        updateCurrentTranscript(result.time);
        if (practice && practicePlaying && practiceActiveEnd > 0 && result.time >= practiceActiveEnd) {
          handlePracticePlaybackEnd();
        }
      }
    } catch (_) {}
  }, 700);

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "VIDEO_STATE_READY") {
      state = message.state;
      renderState();
    }
    if (message.type === "DRAFT_READY" && message.tabId === activeTabId
      && message.videoId === state?.video?.videoId) loadDraft();
    if (message.type === "DRAFT_CANCELLED" && message.tabId === activeTabId
      && message.videoId === state?.video?.videoId) discardDraft();
  });
}

document.querySelectorAll(".tab").forEach((button) => {
  button.addEventListener("click", () => switchTab(button.dataset.tab));
});

elements.saveButton.addEventListener("click", saveDraft);
elements.cancelEditButton.addEventListener("click", cancelDraft);
elements.draftNote.addEventListener("input", () => {
  if (!draft) return;
  draft.note = elements.draftNote.value;
  persistDraft();
});
elements.draftNote.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    saveDraft();
  }
  if (event.key === "Escape") cancelDraft();
});
elements.loadTranscriptButton.addEventListener("click", requestTranscript);
elements.loadTranscriptCta.addEventListener("click", requestTranscript);
elements.saveToVaultButton.addEventListener("click", saveToVault);
elements.cleanCacheButton.addEventListener("click", cleanExpiredCache);
elements.transcriptSearch.addEventListener("input", () => {
  transcriptFilter = elements.transcriptSearch.value.trim().toLowerCase();
  renderTranscriptList();
});
elements.transcriptList.addEventListener("scroll", () => {
  if (suppressScrollTracking) return;
  lastUserScrollAt = Date.now();
});
elements.practiceEntry.addEventListener("click", openPracticeView);
elements.practiceBack.addEventListener("click", closePracticeView);
elements.practiceRepeat.addEventListener("click", playPracticeSegment);
elements.practiceSubtitleToggle.addEventListener("click", togglePracticeSubtitles);
elements.practiceExit.addEventListener("click", showPracticeList);
elements.practiceFinish.addEventListener("click", showPracticeList);
elements.practiceNext.addEventListener("click", nextPracticeSegment);
elements.shadowingStart.addEventListener("click", startShadowing);
elements.shadowingListen.addEventListener("click", () => {
  if (shadowing) playShadowingSentence(shadowing.index);
});
elements.shadowingNext.addEventListener("click", nextShadowingSentence);
elements.practiceRateGroup.forEach((button) => {
  button.addEventListener("click", () => setPracticeRate(Number(button.dataset.rate)));
});
elements.addScreenshotsButton.addEventListener("click", () => elements.screenshotInput.click());
elements.screenshotInput.addEventListener("change", () => {
  addScreenshotFiles(elements.screenshotInput.files);
  elements.screenshotInput.value = "";
});
elements.composer.addEventListener("paste", (event) => {
  const images = [...(event.clipboardData?.files || [])].filter((file) => file.type.startsWith("image/"));
  if (!images.length || !draft) return;
  event.preventDefault();
  addScreenshotFiles(images);
});
elements.composer.addEventListener("dragover", (event) => {
  if (!draft) return;
  event.preventDefault();
  elements.composer.classList.add("drop-active");
});
elements.composer.addEventListener("dragleave", () => elements.composer.classList.remove("drop-active"));
elements.composer.addEventListener("drop", (event) => {
  elements.composer.classList.remove("drop-active");
  if (!draft) return;
  event.preventDefault();
  addScreenshotFiles(event.dataTransfer?.files || []);
});
new ResizeObserver(([entry]) => {
  document.documentElement.style.setProperty("--composer-offset", `${Math.ceil(entry.contentRect.height) + 34}px`);
}).observe(elements.composer);

async function renderState() {
  if (!state?.video) return showEmpty("当前页面没有可读取的视频。");
  const renderVideoId = state.video.videoId;
  if (composerVideoId !== renderVideoId) {
    // 换视频后 composer 跟随新视频：编辑模式退出、草稿视图清空，
    // 原视频的草稿仍留在 session 存储里，切回时再载入。
    editingRecordIndex = -1;
    draft = null;
    setComposerIdle();
    composerVideoId = renderVideoId;
    loadDraft();
  }
  document.title = state.video.title || "YouTube 学习记录";
  elements.empty.classList.add("hidden");
  elements.transcriptPanel.classList.toggle("hidden", activePanel !== "transcript");
  elements.recordsPanel.classList.toggle("hidden", activePanel !== "records");
  elements.loadTranscriptButton.disabled = false;

  const hasTranscript = state.transcript.length > 0;
  const isSaved = Boolean(state.sessionPath);
  if (practice && practice.videoId !== state.video.videoId) closePracticeView();
  elements.transcriptCount.textContent = state.transcript.length;
  elements.saveStatus.className = `status-chip ${isSaved ? "saved" : hasTranscript ? "ready" : "idle"}`;
  elements.saveStatus.textContent = isSaved ? "已入库" : hasTranscript ? "待入库" : "未读取";
  elements.saveToVaultButton.disabled = !hasTranscript || isSaved;
  elements.saveToVaultButton.querySelector("span").textContent = isSaved ? "已保存到知识库" : "保存到知识库";
  elements.transcriptEmpty.classList.toggle("hidden", hasTranscript);
  elements.transcriptToolbar.classList.toggle("hidden", !hasTranscript);
  elements.transcriptList.classList.toggle("hidden", !hasTranscript);
  elements.loadTranscriptButton.querySelector("span").textContent = hasTranscript ? "重新获取" : "获取字幕";
  renderTranscriptList();

  if (!isPreview) {
    const recordsKey = `records:${renderVideoId}`;
    const stored = await chrome.storage.local.get(recordsKey);
    if (state?.video?.videoId !== renderVideoId) return;
    records = stored[recordsKey] || [];
    if (!records.length && isSaved) {
      // 换设备/清过扩展存储后本地为空，但笔记已入库：从 vault 缓存恢复。
      const restored = await chrome.runtime.sendMessage({
        type: "LOAD_RECORDS",
        videoId: renderVideoId
      }).catch(() => null);
      if (state?.video?.videoId !== renderVideoId) return;
      if (restored?.ok && Array.isArray(restored.records) && restored.records.length) {
        records = restored.records;
        await chrome.storage.local.set({ [recordsKey]: records });
        if (state?.video?.videoId !== renderVideoId) return;
      }
    }
  }
  renderRecords();
  updateCurrentTranscript(state.currentTime);
}

function renderTranscriptList() {
  if (!state?.transcript) return;
  const items = state.transcript
    .map((item, index) => ({ ...item, index }))
    .filter((item) => !transcriptFilter || item.text.toLowerCase().includes(transcriptFilter));
  elements.transcriptList.replaceChildren(...items.map(buildTranscriptRow));
  updateCurrentTranscript(state.currentTime);
}

function buildTranscriptRow(item) {
  const row = document.createElement("div");
  row.className = "transcript-row";
  row.dataset.start = item.start;
  row.dataset.index = item.index;
  row.tabIndex = 0;
  row.setAttribute("role", "button");
  row.setAttribute("aria-label", `${formatTime(item.start)}，跳转到此处`);
  row.innerHTML = `<span class="transcript-time">${formatTime(item.start)}</span><span class="transcript-text"></span>`;
  row.querySelector(".transcript-text").textContent = item.text;
  row.addEventListener("click", () => {
    if (window.getSelection()?.toString()) return;
    chrome.tabs.sendMessage(activeTabId, { type: "SEEK_TO", seconds: item.start });
  });
  row.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    chrome.tabs.sendMessage(activeTabId, { type: "SEEK_TO", seconds: item.start });
  });
  return row;
}

function initializePreview() {
  activeTabId = 1;
  state = {
    video: {
      videoId: "preview",
      title: "How I Learn Anything Faster — 建立自己的学习系统"
    },
    currentTime: 78,
    sessionPath: "",
    transcript: [
      { start: 42, text: "Most people try to learn by collecting more information." },
      { start: 58, text: "But the real shift happens when you turn information into a question." },
      { start: 76, text: "A useful learning system should help you notice, connect, and retrieve ideas." },
      { start: 94, text: "Your notes are not an archive. They are material for your future thinking." },
      { start: 116, text: "The smallest useful habit is to capture why an idea matters to you." },
      { start: 139, text: "That personal connection is what makes knowledge easier to recall." }
    ]
  };
  records = [{
    timestamp: "01:16",
    time: 76,
    text: "A useful learning system should help you notice, connect, and retrieve ideas.",
    note: "知识库不应该只是收藏夹。保存时要补一句：它改变了我什么判断？",
    screenshots: [{ id: "0000076000-preview001.webp" }]
  }];
  renderState().then(() => {
    draft = {
      videoId: "preview",
      timestamp: "01:34",
      time: 94,
      text: state.transcript[3].text,
      screenshots: [{ id: "0000094000-preview001.webp" }, { id: "0000094000-preview002.webp" }]
    };
    elements.draftTime.textContent = draft.timestamp;
    elements.draftText.textContent = draft.text;
    elements.draftNote.disabled = false;
    elements.addScreenshotsButton.disabled = false;
    elements.saveButton.disabled = false;
    renderDraftScreenshots();
  });
}

async function requestTranscript() {
  if (!activeTabId || !state?.video?.videoId) return;
  const requestedVideoId = state.video.videoId;
  elements.loadTranscriptButton.disabled = true;
  elements.loadTranscriptCta.disabled = true;
  elements.loadTranscriptButton.classList.add("loading");
  elements.loadTranscriptButton.querySelector("span").textContent = "获取中…";
  elements.loadTranscriptCta.textContent = "正在获取…";

  try {
    // yt-dlp 下载字幕可能耗时很久，超时后避免按钮永远停在「获取中…」。
    const timeout = new Promise((_, reject) => {
      setTimeout(() => reject({ timeout: true }), 130_000);
    });
    const result = await Promise.race([
      chrome.tabs.sendMessage(activeTabId, { type: "LOAD_TRANSCRIPT" }),
      timeout,
    ]);
    if (!result?.ok) {
      showToast(result?.error || "没有获取到字幕");
      return;
    }
    if (result.videoId !== requestedVideoId || state?.video?.videoId !== requestedVideoId) {
      showToast("视频已切换，请重新获取字幕");
      return;
    }
    state.transcript = result.transcript;
    state.sessionPath = result.sessionPath || "";
    await renderState();
    showToast(`已获取 ${result.transcript.length} 条字幕`);
  } catch (error) {
    showToast(error?.timeout ? "获取字幕超时（本地服务无响应）" : "字幕获取失败，请刷新页面重试");
  } finally {
    elements.loadTranscriptButton.classList.remove("loading");
    elements.loadTranscriptButton.disabled = false;
    elements.loadTranscriptCta.disabled = false;
    elements.loadTranscriptCta.textContent = "获取当前视频字幕";
    if (!state?.transcript?.length) elements.loadTranscriptButton.querySelector("span").textContent = "获取字幕";
  }
}

async function saveToVault() {
  if (!activeTabId || !state?.transcript?.length || state.sessionPath) return;
  elements.saveToVaultButton.disabled = true;
  elements.saveToVaultButton.classList.add("loading");
  elements.saveToVaultButton.querySelector("span").textContent = "保存中…";
  try {
    const result = await chrome.tabs.sendMessage(activeTabId, {
      type: "SAVE_TO_VAULT",
      records
    });
    if (!result?.ok) throw new Error(result?.error || "保存失败");
    state.sessionPath = result.sessionPath || result.notePath || "";
    await renderState();
    showToast("已保存到知识库");
  } catch (error) {
    elements.saveToVaultButton.disabled = false;
    elements.saveToVaultButton.querySelector("span").textContent = "保存到知识库";
    showToast(error.message || "保存失败");
  } finally {
    elements.saveToVaultButton.classList.remove("loading");
  }
}

async function cleanExpiredCache() {
  elements.cleanCacheButton.disabled = true;
  try {
    const status = await chrome.runtime.sendMessage({ type: "CACHE_STATUS" });
    if (!status?.ok) throw new Error(status?.error || "无法读取缓存状态");
    if (!status.removableCount) {
      showToast("没有需要清理的过期缓存");
      return;
    }
    const size = formatBytes(status.removableBytes || 0);
    const approved = confirm(
      `将删除 ${status.removableCount} 个超过 30 天或超出最近 50 个上限的未入库缓存（约 ${size}）。已入库内容不会删除。是否继续？`
    );
    if (!approved) return;
    const result = await chrome.runtime.sendMessage({ type: "CLEANUP_CACHE" });
    if (!result?.ok) throw new Error(result?.error || "缓存清理失败");
    showToast(`已清理 ${result.removed?.length || 0} 个过期缓存，释放约 ${formatBytes(result.removableBytes || 0)}`);
  } catch (error) {
    showToast(error.message || "缓存清理失败");
  } finally {
    elements.cleanCacheButton.disabled = false;
  }
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function loadDraft() {
  if (isPreview) return;
  if (!activeTabId || editingRecordIndex >= 0 || !state?.video?.videoId) return;
  const key = `draft:${activeTabId}:${state.video.videoId}`;
  const stored = await chrome.storage.session.get(key);
  if (!stored[key]) return;
  draft = stored[key];
  draft.screenshots = Array.isArray(draft.screenshots) ? draft.screenshots : [];
  showDraftEditor();
}

async function saveDraft() {
  if (!draft) return;
  const record = { ...draft, note: elements.draftNote.value.trim() };
  if (editingRecordIndex >= 0) {
    records[editingRecordIndex] = record;
    const syncError = await persistRecords(record.videoId);
    editingRecordIndex = -1;
    draft = null;
    setComposerIdle();
    renderRecords();
    showToast(syncError ? `修改已在本地保存，但同步失败：${syncError}` : "笔记修改已保存");
    return;
  }
  const targetVideoId = record.videoId || state?.video?.videoId;
  if (targetVideoId === state?.video?.videoId) {
    records.push(record);
    const syncError = await persistRecords(targetVideoId);
    renderRecords();
    showToast(syncError ? `记录已在本地保存，但同步知识库失败：${syncError}` : "学习记录已保存");
  } else {
    // 草稿是视频 A 的，但页面已切到视频 B：写回 A 自己的列表，不污染 B。
    const syncError = await appendRecordToVideo(targetVideoId, record);
    showToast(syncError ? `已保存到原视频的本地记录，但同步失败：${syncError}` : "已保存到原视频的记录，切回该视频可查看");
  }
  await clearDraft(true);
}

async function cancelDraft() {
  if (editingRecordIndex >= 0) {
    await cleanupTransientScreenshots(draft?.videoId);
    editingRecordIndex = -1;
    draft = null;
    setComposerIdle();
    showToast("已取消修改");
    return;
  }
  await cleanupTransientScreenshots(draft?.videoId);
  await clearDraft(true);
}

function discardDraft() {
  if (editingRecordIndex >= 0) return;
  cleanupTransientScreenshots(draft?.videoId).catch(() => {});
  draft = null;
  setComposerIdle();
  showToast("已取消本次记录");
}

async function clearDraft(resume) {
  const videoId = draft?.videoId || state?.video?.videoId;
  if (videoId) await chrome.storage.session.remove(`draft:${activeTabId}:${videoId}`);
  draft = null;
  setComposerIdle();
  if (resume) chrome.tabs.sendMessage(activeTabId, { type: "RESUME_VIDEO" }).catch(() => {});
}

function setComposerIdle() {
  elements.composer.classList.remove("editing");
  elements.composerTitle.textContent = "记录此刻";
  elements.draftTime.textContent = "待记录";
  elements.draftText.textContent = "按 Alt+N 暂停视频并定位当前字幕，然后在这里写笔记。";
  elements.draftNote.value = "";
  elements.draftNote.disabled = true;
  elements.addScreenshotsButton.disabled = true;
  elements.saveButton.disabled = true;
  elements.saveButton.textContent = "保存笔记";
  elements.cancelEditButton.classList.add("hidden");
  elements.screenshotHint.textContent = "支持多选、拖入或粘贴";
  elements.screenshotPreviewList.replaceChildren();
  elements.screenshotPreviewList.classList.add("hidden");
  screenshotPreviews.clear();
}

function persistDraft() {
  if (!draft || editingRecordIndex >= 0 || isPreview) return;
  chrome.storage.session.set({ [`draft:${activeTabId}:${draft.videoId}`]: draft }).catch(() => {});
}

function showDraftEditor() {
  elements.composer.classList.toggle("editing", editingRecordIndex >= 0);
  elements.composerTitle.textContent = editingRecordIndex >= 0 ? "编辑学习笔记" : "记录此刻";
  elements.draftTime.textContent = draft.timestamp;
  elements.draftText.textContent = draft.text || "当前没有可读取的字幕，你仍可以记录想法。";
  elements.draftNote.value = draft.note || "";
  elements.draftNote.disabled = false;
  elements.addScreenshotsButton.disabled = false;
  elements.saveButton.disabled = false;
  elements.saveButton.textContent = editingRecordIndex >= 0 ? "保存修改" : "保存笔记";
  elements.cancelEditButton.classList.toggle("hidden", editingRecordIndex < 0);
  renderDraftScreenshots();
  elements.draftNote.focus();
}

function startEditingRecord(index) {
  if (draft && editingRecordIndex < 0 && !isPreview) {
    showToast("请先保存或取消当前正在记录的笔记");
    return;
  }
  const record = records[index];
  if (!record) return;
  editingRecordIndex = index;
  draft = {
    ...record,
    screenshots: (record.screenshots || []).map((screenshot) => ({ ...screenshot }))
  };
  showDraftEditor();
  showToast("已进入编辑模式");
}

async function persistRecords(videoId) {
  await chrome.storage.local.set({ [`records:${videoId}`]: records });
  if (!state?.sessionPath) return null;
  return syncRecordsToVault(videoId, records);
}

async function appendRecordToVideo(videoId, record) {
  const key = `records:${videoId}`;
  const stored = await chrome.storage.local.get(key);
  const target = Array.isArray(stored[key]) ? stored[key] : [];
  target.push(record);
  await chrome.storage.local.set({ [key]: target });
  if (!record.sessionPath) return null;
  return syncRecordsToVault(videoId, target);
}

// 返回 null 表示同步成功（或无需同步），否则返回可展示的错误信息。
async function syncRecordsToVault(videoId, list) {
  const result = await chrome.runtime.sendMessage({
    type: "SYNC_STUDY_RECORDS",
    videoId,
    records: list
  }).catch(() => null);
  return result?.ok ? null : (result?.error || "本地连接器无响应，笔记未同步");
}

async function addScreenshotFiles(fileList) {
  if (!draft || isAddingScreenshots) return;
  const targetDraft = draft;
  const files = [...fileList].filter((file) => file.type.startsWith("image/"));
  const remaining = 8 - (draft.screenshots?.length || 0);
  if (!files.length) return showToast("请选择图片文件");
  if (remaining <= 0) return showToast("一条笔记最多添加 8 张截图");
  const selected = files.slice(0, remaining);
  isAddingScreenshots = true;
  elements.addScreenshotsButton.disabled = true;
  elements.saveButton.disabled = true;
  elements.screenshotHint.textContent = `正在处理 0/${selected.length}`;

  try {
    for (let index = 0; index < selected.length; index += 1) {
      const normalized = await normalizeScreenshot(selected[index]);
      const result = await chrome.runtime.sendMessage({
        type: "STORE_SCREENSHOT",
        videoId: targetDraft.videoId,
        time: targetDraft.time,
        imageDataUrl: normalized.dataUrl
      });
      if (draft !== targetDraft) throw new Error("当前笔记已切换，请重新添加截图");
      if (!result?.ok || !result.screenshot?.id) throw new Error(result?.error || "截图保存失败");
      const screenshot = {
        ...result.screenshot,
        width: normalized.width,
        height: normalized.height
      };
      targetDraft.screenshots = [...(targetDraft.screenshots || []), screenshot];
      screenshotPreviews.set(screenshot.id, normalized.dataUrl);
      elements.screenshotHint.textContent = `正在处理 ${index + 1}/${selected.length}`;
      persistDraft();
      renderDraftScreenshots();
    }
    showToast(`已添加 ${selected.length} 张截图`);
  } catch (error) {
    showToast(error.message || "截图处理失败");
  } finally {
    isAddingScreenshots = false;
    elements.addScreenshotsButton.disabled = !draft;
    elements.saveButton.disabled = !draft;
    elements.screenshotHint.textContent = "支持多选、拖入或粘贴";
  }
}

async function normalizeScreenshot(file) {
  if (file.size > 15 * 1024 * 1024) throw new Error("单张原图不能超过 15 MB");
  const bitmap = await createImageBitmap(file);
  const maxDimension = 1600;
  const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return {
    dataUrl: canvas.toDataURL("image/webp", 0.9),
    width,
    height
  };
}

function renderDraftScreenshots() {
  const screenshots = draft?.screenshots || [];
  elements.screenshotPreviewList.classList.toggle("hidden", !screenshots.length);
  elements.screenshotPreviewList.replaceChildren(...screenshots.map((screenshot, index) => {
    const item = document.createElement("div");
    item.className = "screenshot-preview";
    const preview = screenshotPreviews.get(screenshot.id);
    if (preview) {
      const image = document.createElement("img");
      image.src = preview;
      image.alt = `截图 ${index + 1}`;
      item.append(image);
    } else {
      const placeholder = document.createElement("div");
      placeholder.className = "screenshot-placeholder";
      placeholder.textContent = `截图 ${index + 1}\n已缓存`;
      item.append(placeholder);
    }
    const remove = document.createElement("button");
    remove.className = "remove-screenshot";
    remove.type = "button";
    remove.setAttribute("aria-label", `移除截图 ${index + 1}`);
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      const wasTransient = screenshotPreviews.has(screenshot.id);
      screenshotPreviews.delete(screenshot.id);
      draft.screenshots.splice(index, 1);
      persistDraft();
      renderDraftScreenshots();
      if (wasTransient) deleteScreenshots(draft.videoId, [screenshot.id]).catch(() => {});
    });
    item.append(remove);
    return item;
  }));
}

async function cleanupTransientScreenshots(videoId) {
  const screenshotIds = [...screenshotPreviews.keys()];
  if (!videoId || !screenshotIds.length || isPreview) return;
  await deleteScreenshots(videoId, screenshotIds);
}

async function deleteScreenshots(videoId, screenshotIds) {
  const result = await chrome.runtime.sendMessage({
    type: "DELETE_SCREENSHOTS",
    videoId,
    screenshotIds
  }).catch(() => null);
  if (!result?.ok) throw new Error(result?.error || "截图缓存清理失败");
}

function renderRecords() {
  elements.recordCount.textContent = records.length;
  if (!records.length) {
    const message = document.createElement("div");
    message.className = "empty-state";
    message.innerHTML = "<p>还没有学习记录。<br>在上方输入，或播放时按 <strong>Alt + N</strong> 快速记录。</p>";
    elements.recordsList.replaceChildren(message);
    return;
  }

  elements.recordsList.replaceChildren(...records.map((record, index) => {
    const article = document.createElement("article");
    article.className = "record";
    article.innerHTML = `
      <div class="record-header">
        <button class="record-time" title="跳转到视频 ${escapeHtml(record.timestamp)}">${escapeHtml(record.timestamp)}</button>
        <div class="record-actions">
          <button class="edit-button" aria-label="编辑记录">编辑</button>
          <button class="delete-button" aria-label="删除记录">删除</button>
        </div>
      </div>
      <div class="record-quote"></div>
      ${record.note ? "<div class=\"record-note\"></div>" : ""}
      ${record.screenshots?.length ? `<div class="record-screenshots">📷 ${record.screenshots.length} 张截图</div>` : ""}
    `;
    article.querySelector(".record-quote").textContent = record.text || "（无字幕）";
    article.querySelector(".record-note")?.append(document.createTextNode(record.note));
    article.querySelector(".record-time").addEventListener("click", () => seekToRecord(record));
    article.querySelector(".edit-button").addEventListener("click", () => startEditingRecord(index));
    article.querySelector(".delete-button").addEventListener("click", () => deleteRecord(index));
    return article;
  }));
}

async function deleteRecord(index) {
  if (editingRecordIndex >= 0) {
    editingRecordIndex = -1;
    draft = null;
    setComposerIdle();
  }
  records.splice(index, 1);
  const syncError = await persistRecords(state.video.videoId);
  renderRecords();
  if (syncError) showToast(`删除已在本地生效，但同步失败：${syncError}`);
}

async function seekToRecord(record) {
  try {
    const result = await chrome.tabs.sendMessage(activeTabId, {
      type: "SEEK_TO",
      seconds: record.time
    });
    if (!result?.ok) throw new Error();
    showToast(`已跳转到 ${record.timestamp}`);
  } catch (_) {
    showToast("无法跳转，请刷新视频页面");
  }
}

function switchTab(tab) {
  if (practiceViewOpen) {
    closePracticeView();
    return;
  }
  activePanel = tab;
  document.querySelectorAll(".tab").forEach((button) => button.classList.toggle("active", button.dataset.tab === tab));
  elements.transcriptPanel.classList.toggle("hidden", tab !== "transcript");
  elements.recordsPanel.classList.toggle("hidden", tab !== "records");
}

// ---------- Listening Practice Mode (V2) ----------

// 围绕学习笔记自动切段：以每条笔记时间为中心取前后约 30 秒，并扩展到完整字幕句边界。
function buildPracticeSegments() {
  if (!state?.transcript?.length || !records.length) return [];
  const transcript = state.transcript;
  const segments = [];
  records.forEach((record, recordIndex) => {
    const anchor = record.time;
    if (typeof anchor !== "number" || anchor < 0) return;
    const before = anchor - 30;
    const after = anchor + 30;
    let from = 0;
    for (let i = 0; i < transcript.length; i += 1) {
      if (transcript[i].start <= before) from = i;
      else break;
    }
    let to = transcript.length - 1;
    for (let i = 0; i < transcript.length; i += 1) {
      const end = transcript[i].start + (transcript[i].duration || 3);
      if (end >= after) {
        to = i;
        break;
      }
    }
    segments.push({
      recordIndex,
      start: transcript[from].start,
      end: transcript[to].start + (transcript[to].duration || 3),
      items: transcript.slice(from, to + 1).map((item) => ({
        start: item.start,
        end: item.start + (item.duration || 3),
        text: item.text
      })),
      note: record.note || record.text || ""
    });
  });
  return segments;
}

function openPracticeView() {
  if (!state?.video?.videoId) return;
  practiceViewOpen = true;
  document.body.classList.add("practice-mode");
  elements.practiceView.classList.remove("hidden");
  elements.transcriptPanel.classList.add("hidden");
  elements.recordsPanel.classList.add("hidden");
  elements.empty.classList.add("hidden");
  renderPracticeList(buildPracticeSegments());
}

function closePracticeView() {
  showPracticeList();
  practiceViewOpen = false;
  document.body.classList.remove("practice-mode");
  elements.practiceView.classList.add("hidden");
  elements.transcriptPanel.classList.toggle("hidden", activePanel !== "transcript");
  elements.recordsPanel.classList.toggle("hidden", activePanel !== "records");
  if (!state?.video) elements.empty.classList.remove("hidden");
}

function renderPracticeList(segments) {
  practice = null;
  shadowing = null;
  practicePlaying = false;
  practiceActiveEnd = 0;
  elements.practicePanel.classList.add("hidden");
  const hasSegments = segments.length > 0;
  elements.practiceListHead.classList.toggle("hidden", !hasSegments);
  elements.practiceEmpty.classList.toggle("hidden", hasSegments);
  elements.practiceList.classList.toggle("hidden", !hasSegments);
  elements.practiceList.replaceChildren(...segments.map((segment, index) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "practice-segment";
    item.innerHTML = `
      <span class="practice-segment-range">${formatTime(segment.start)} — ${formatTime(segment.end)}</span>
      <span class="practice-segment-note"></span>
      <span class="practice-segment-meta">${segment.items.length} 句 · 来自第 ${segment.recordIndex + 1} 条笔记</span>
    `;
    item.querySelector(".practice-segment-note").textContent = segment.note || "（这条笔记没有文字）";
    item.addEventListener("click", () => enterPractice(segments, index));
    return item;
  }));
}

function showPracticeList() {
  chrome.tabs.sendMessage(activeTabId, { type: "PRACTICE_PAUSE" }).catch(() => {});
  practice = null;
  shadowing = null;
  practicePlaying = false;
  practiceActiveEnd = 0;
  elements.practicePanel.classList.add("hidden");
  elements.practiceList.classList.remove("hidden");
  elements.practiceListHead.classList.remove("hidden");
  elements.practiceEmpty.classList.add("hidden");
}

function enterPractice(segments, index) {
  if (!segments?.length) return;
  practice = {
    videoId: state.video.videoId,
    segments,
    index,
    rate: 1,
    showSubtitles: false
  };
  renderPractice();
}

function nextPracticeSegment() {
  if (!practice || practice.index >= practice.segments.length - 1) return;
  practice.index += 1;
  renderPractice();
}

function renderPractice() {
  if (!practice) return;
  const segment = practice.segments[practice.index];
  elements.practicePanel.classList.remove("hidden");
  elements.practiceList.classList.add("hidden");
  elements.practiceListHead.classList.add("hidden");
  elements.practiceRange.textContent = `${formatTime(segment.start)} — ${formatTime(segment.end)}`;
  elements.practiceSubtitles.replaceChildren(...segment.items.map((item, index) => {
    const row = document.createElement("div");
    row.className = "practice-subtitle-row";
    row.dataset.index = index;
    row.innerHTML =
      `<span class="practice-subtitle-time">${formatTime(item.start)}</span><span class="practice-subtitle-text"></span>`;
    row.querySelector(".practice-subtitle-text").textContent = item.text;
    return row;
  }));
  setPracticeSubtitlesVisible(practice.showSubtitles);
  elements.shadowingStart.textContent = "开始跟读";
  elements.shadowingStart.classList.remove("hidden");
  elements.shadowingListen.classList.add("hidden");
  elements.shadowingNext.classList.add("hidden");
  elements.shadowingProgress.textContent = "";
  elements.shadowingSentence.textContent = "";
  elements.shadowingStatus.textContent = "先听一遍。听不懂就「再听一次」或放慢速度；仍不懂再「显示字幕」。";
  elements.practiceNext.classList.toggle("hidden", practice.index >= practice.segments.length - 1);
  playPracticeSegment();
}

function sendPracticePlay(start, end, rate) {
  chrome.tabs.sendMessage(activeTabId, {
    type: "PRACTICE_PLAY_SEGMENT",
    start,
    end,
    rate
  }).catch(() => {});
}

function playPracticeSegment() {
  if (!practice || practicePlaying) return;
  const segment = practice.segments[practice.index];
  practicePlaying = true;
  practiceActiveEnd = segment.end;
  elements.practiceRepeat.disabled = true;
  elements.practiceRepeat.textContent = "播放中…";
  sendPracticePlay(segment.start, segment.end, practice.rate);
}

function handlePracticePlaybackEnd() {
  practicePlaying = false;
  practiceActiveEnd = 0;
  if (practice) {
    elements.practiceRepeat.disabled = false;
    elements.practiceRepeat.textContent = "再听一次";
  }
  if (shadowing) {
    elements.shadowingListen.disabled = false;
    elements.shadowingListen.classList.remove("hidden");
    elements.shadowingNext.disabled = false;
    elements.shadowingNext.classList.remove("hidden");
    elements.shadowingStatus.textContent = "请跟读：先听原声，然后自己读一遍。";
  }
}

function setPracticeRate(rate) {
  if (!practice) return;
  practice.rate = rate;
  elements.practiceRateGroup.forEach((button) => {
    button.classList.toggle("active", Number(button.dataset.rate) === rate);
  });
  chrome.tabs.sendMessage(activeTabId, { type: "PRACTICE_SET_RATE", rate }).catch(() => {});
}

function setPracticeSubtitlesVisible(visible) {
  elements.practiceSubtitles.classList.toggle("hidden", !visible);
  elements.practiceSubtitleToggle.textContent = visible ? "隐藏字幕" : "显示字幕";
}

function togglePracticeSubtitles() {
  if (!practice) return;
  practice.showSubtitles = !practice.showSubtitles;
  setPracticeSubtitlesVisible(practice.showSubtitles);
}

function startShadowing() {
  if (!practice) return;
  shadowing = { index: 0 };
  renderShadowing();
  playShadowingSentence(0);
}

function renderShadowing() {
  if (!shadowing || !practice) return;
  const segment = practice.segments[practice.index];
  elements.shadowingStart.classList.add("hidden");
  elements.shadowingListen.classList.add("hidden");
  elements.shadowingNext.classList.add("hidden");
  elements.shadowingProgress.textContent = `第 ${shadowing.index + 1} / ${segment.items.length} 句`;
  elements.shadowingSentence.textContent = segment.items[shadowing.index].text;
  elements.shadowingSentence.classList.remove("hidden");
}

function playShadowingSentence(index) {
  if (!practice || !shadowing) return;
  const segment = practice.segments[practice.index];
  if (index >= segment.items.length) return;
  shadowing.index = index;
  renderShadowing();
  practicePlaying = true;
  practiceActiveEnd = segment.items[index].end;
  elements.shadowingListen.disabled = true;
  elements.shadowingNext.disabled = true;
  elements.shadowingListen.classList.remove("hidden");
  elements.shadowingNext.classList.remove("hidden");
  elements.shadowingNext.textContent = index >= segment.items.length - 1 ? "完成跟读" : "下一句";
  elements.shadowingStatus.textContent = "播放原声…";
  elements.practiceSubtitles.querySelectorAll(".practice-subtitle-row.current").forEach((row) => {
    row.classList.remove("current");
  });
  const row = elements.practiceSubtitles.querySelector(`[data-index="${index}"]`);
  if (row) row.classList.add("current");
  sendPracticePlay(segment.items[index].start, segment.items[index].end, practice.rate);
}

function nextShadowingSentence() {
  if (!practice || !shadowing) return;
  const segment = practice.segments[practice.index];
  const next = shadowing.index + 1;
  if (next >= segment.items.length) {
    shadowing = null;
    practicePlaying = false;
    elements.shadowingStart.classList.remove("hidden");
    elements.shadowingListen.classList.add("hidden");
    elements.shadowingNext.classList.add("hidden");
    elements.shadowingProgress.textContent = "跟读完成";
    elements.shadowingSentence.textContent = "";
    elements.shadowingStatus.textContent = "这一段都跟读过了。可以再听一遍，或直接完成练习。";
    return;
  }
  playShadowingSentence(next);
}

function updateCurrentTranscript(time) {
  if (!state?.transcript?.length) return;
  let index = -1;
  for (let i = 0; i < state.transcript.length; i += 1) {
    if (state.transcript[i].start <= time + 0.2) index = i;
    else break;
  }
  if (index === currentTranscriptIndex) return;
  currentTranscriptIndex = index;
  document.querySelector(".transcript-row.current")?.classList.remove("current");
  const row = elements.transcriptList.querySelector(`[data-index="${index}"]`);
  if (row) {
    row.classList.add("current");
    // 用户正在手动滚动时不要抢滚动；跟随只在当前句变化且用户没有操作时进行。
    if (Date.now() - lastUserScrollAt > 3000) {
      suppressScrollTracking = true;
      row.scrollIntoView({ block: "center", behavior: "smooth" });
      setTimeout(() => { suppressScrollTracking = false; }, 400);
    }
  }
}

function showEmpty(text) {
  document.title = "YouTube 学习记录";
  elements.empty.classList.remove("hidden");
  elements.transcriptPanel.classList.add("hidden");
  elements.recordsPanel.classList.add("hidden");
  elements.loadTranscriptButton.disabled = true;
  elements.saveToVaultButton.disabled = true;
  elements.saveToVaultButton.querySelector("span").textContent = "保存到知识库";
  elements.transcriptCount.textContent = "0";
  elements.saveStatus.className = "status-chip idle";
  elements.saveStatus.textContent = "未读取";
  elements.empty.querySelector("p").textContent = text;
}

function showToast(text) {
  elements.toast.textContent = text;
  elements.toast.classList.remove("hidden");
  setTimeout(() => elements.toast.classList.add("hidden"), 1800);
}

function formatTime(seconds) {
  const value = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const secs = value % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
    : `${minutes}:${String(secs).padStart(2, "0")}`;
}

function escapeHtml(text) {
  return String(text || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  })[char]);
}
