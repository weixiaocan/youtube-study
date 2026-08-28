const elements = {
  title: document.querySelector("#video-title"),
  empty: document.querySelector("#empty-state"),
  transcriptPanel: document.querySelector("#transcript-panel"),
  recordsPanel: document.querySelector("#records-panel"),
  transcriptList: document.querySelector("#transcript-list"),
  recordsList: document.querySelector("#records-list"),
  transcriptCount: document.querySelector("#transcript-count"),
  recordCount: document.querySelector("#record-count"),
  saveStatus: document.querySelector("#save-status"),
  saveToVaultButton: document.querySelector("#save-to-vault-button"),
  loadTranscriptButton: document.querySelector("#load-transcript-button"),
  loadTranscriptCta: document.querySelector("#load-transcript-cta"),
  transcriptEmpty: document.querySelector("#transcript-empty"),
  composer: document.querySelector("#composer"),
  draftTime: document.querySelector("#draft-time"),
  draftText: document.querySelector("#draft-text"),
  draftNote: document.querySelector("#draft-note"),
  addScreenshotsButton: document.querySelector("#add-screenshots-button"),
  screenshotInput: document.querySelector("#screenshot-input"),
  screenshotHint: document.querySelector("#screenshot-hint"),
  screenshotPreviewList: document.querySelector("#screenshot-preview-list"),
  saveButton: document.querySelector("#save-button"),
  toast: document.querySelector("#toast")
};

let activeTabId = null;
let state = null;
let records = [];
let draft = null;
let currentTranscriptIndex = -1;
let activePanel = "transcript";
let isAddingScreenshots = false;
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
    await loadDraft();
  } catch (error) {
    showEmpty(error.message || "无法连接 YouTube 页面");
  }
}

if (!isPreview) {
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "VIDEO_STATE_READY") {
      state = message.state;
      renderState();
    }
    if (message.type === "PLAYBACK_TIME" && message.videoId === state?.video?.videoId) {
      updateCurrentTranscript(message.time);
    }
    if (message.type === "DRAFT_READY" && message.tabId === activeTabId) loadDraft();
    if (message.type === "DRAFT_CANCELLED" && message.tabId === activeTabId) discardDraft();
  });
}

document.querySelectorAll(".tab").forEach((button) => {
  button.addEventListener("click", () => switchTab(button.dataset.tab));
});

elements.saveButton.addEventListener("click", saveDraft);
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
  elements.title.textContent = state.video.title || "YouTube 学习记录";
  elements.empty.classList.add("hidden");
  elements.transcriptPanel.classList.toggle("hidden", activePanel !== "transcript");
  elements.recordsPanel.classList.toggle("hidden", activePanel !== "records");
  elements.loadTranscriptButton.disabled = false;

  const hasTranscript = state.transcript.length > 0;
  const isSaved = Boolean(state.sessionPath);
  elements.transcriptCount.textContent = state.transcript.length;
  elements.saveStatus.className = `status-chip ${isSaved ? "saved" : hasTranscript ? "ready" : "idle"}`;
  elements.saveStatus.textContent = isSaved ? "已入库" : hasTranscript ? "待入库" : "未读取";
  elements.saveToVaultButton.disabled = !hasTranscript || isSaved;
  elements.saveToVaultButton.querySelector("span").textContent = isSaved ? "已保存到知识库" : "保存到知识库";
  elements.transcriptEmpty.classList.toggle("hidden", hasTranscript);
  elements.transcriptList.classList.toggle("hidden", !hasTranscript);
  elements.loadTranscriptButton.querySelector("span").textContent = hasTranscript ? "重新获取" : "获取字幕";
  elements.transcriptList.replaceChildren(...state.transcript.map((item) => {
    const row = document.createElement("div");
    row.className = "transcript-row";
    row.dataset.start = item.start;
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
  }));

  if (!isPreview) {
    const stored = await chrome.storage.local.get(`records:${state.video.videoId}`);
    records = stored[`records:${state.video.videoId}`] || [];
  }
  renderRecords();
  updateCurrentTranscript(state.currentTime);
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
    note: "知识库不应该只是收藏夹。保存时要补一句：它改变了我什么判断？"
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
  elements.loadTranscriptButton.querySelector("span").textContent = "获取中…";
  elements.loadTranscriptCta.textContent = "正在获取…";

  try {
    const result = await chrome.tabs.sendMessage(activeTabId, { type: "LOAD_TRANSCRIPT" });
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
  } catch (_) {
    showToast("字幕获取失败，请刷新页面重试");
  } finally {
    elements.loadTranscriptButton.disabled = false;
    elements.loadTranscriptCta.disabled = false;
    elements.loadTranscriptCta.textContent = "获取当前视频字幕";
    if (!state?.transcript?.length) elements.loadTranscriptButton.querySelector("span").textContent = "获取字幕";
  }
}

async function saveToVault() {
  if (!activeTabId || !state?.transcript?.length || state.sessionPath) return;
  elements.saveToVaultButton.disabled = true;
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
  }
}

async function loadDraft() {
  if (!activeTabId) return;
  const key = `draft:${activeTabId}`;
  const stored = await chrome.storage.session.get(key);
  if (!stored[key]) return;
  draft = stored[key];
  draft.screenshots = Array.isArray(draft.screenshots) ? draft.screenshots : [];
  elements.draftTime.textContent = draft.timestamp;
  elements.draftText.textContent = draft.text || "当前没有可读取的字幕，你仍可以记录想法。";
  elements.draftNote.value = draft.note || "";
  elements.draftNote.disabled = false;
  elements.addScreenshotsButton.disabled = false;
  elements.saveButton.disabled = false;
  renderDraftScreenshots();
  elements.draftNote.focus();
}

async function saveDraft() {
  if (!draft) return;
  const record = { ...draft, note: elements.draftNote.value.trim() };
  records.push(record);
  await chrome.storage.local.set({ [`records:${draft.videoId}`]: records });
  if (state?.sessionPath) {
    chrome.runtime.sendMessage({
      type: "SYNC_STUDY_RECORDS",
      videoId: draft.videoId,
      records
    }).catch(() => {});
  }
  await clearDraft(true);
  renderRecords();
  showToast("学习记录已保存");
}

async function cancelDraft() {
  await clearDraft(true);
}

function discardDraft() {
  draft = null;
  setComposerIdle();
  showToast("已取消本次记录");
}

async function clearDraft(resume) {
  await chrome.storage.session.remove(`draft:${activeTabId}`);
  draft = null;
  setComposerIdle();
  if (resume) chrome.tabs.sendMessage(activeTabId, { type: "RESUME_VIDEO" }).catch(() => {});
}

function setComposerIdle() {
  elements.draftTime.textContent = "待记录";
  elements.draftText.textContent = "按 Alt+N 暂停视频并定位当前字幕，然后在这里写笔记。";
  elements.draftNote.value = "";
  elements.draftNote.disabled = true;
  elements.addScreenshotsButton.disabled = true;
  elements.saveButton.disabled = true;
  elements.screenshotHint.textContent = "支持多选、拖入或粘贴";
  elements.screenshotPreviewList.replaceChildren();
  elements.screenshotPreviewList.classList.add("hidden");
  screenshotPreviews.clear();
}

function persistDraft() {
  if (!draft || isPreview) return;
  chrome.storage.session.set({ [`draft:${activeTabId}`]: draft }).catch(() => {});
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
      screenshotPreviews.delete(screenshot.id);
      draft.screenshots.splice(index, 1);
      persistDraft();
      renderDraftScreenshots();
    });
    item.append(remove);
    return item;
  }));
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
        <button class="record-time">${escapeHtml(record.timestamp)}</button>
        <button class="delete-button" aria-label="删除记录">删除</button>
      </div>
      <div class="record-quote"></div>
      ${record.note ? "<div class=\"record-note\"></div>" : ""}
      ${record.screenshots?.length ? `<div class="record-screenshots">📷 ${record.screenshots.length} 张截图</div>` : ""}
    `;
    article.querySelector(".record-quote").textContent = record.text || "（无字幕）";
    article.querySelector(".record-note")?.append(document.createTextNode(record.note));
    article.querySelector(".record-time").addEventListener("click", () => chrome.tabs.sendMessage(activeTabId, { type: "SEEK_TO", seconds: record.time }));
    article.querySelector(".delete-button").addEventListener("click", () => deleteRecord(index));
    return article;
  }));
}

async function deleteRecord(index) {
  records.splice(index, 1);
  await chrome.storage.local.set({ [`records:${state.video.videoId}`]: records });
  if (state?.sessionPath) {
    chrome.runtime.sendMessage({
      type: "SYNC_STUDY_RECORDS",
      videoId: state.video.videoId,
      records
    }).catch(() => {});
  }
  renderRecords();
}

function switchTab(tab) {
  activePanel = tab;
  document.querySelectorAll(".tab").forEach((button) => button.classList.toggle("active", button.dataset.tab === tab));
  elements.transcriptPanel.classList.toggle("hidden", tab !== "transcript");
  elements.recordsPanel.classList.toggle("hidden", tab !== "records");
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
  const row = elements.transcriptList.children[index];
  if (row) {
    row.classList.add("current");
    row.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}

function showEmpty(text) {
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
