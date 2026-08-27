const elements = {
  title: document.querySelector("#video-title"),
  empty: document.querySelector("#empty-state"),
  transcriptPanel: document.querySelector("#transcript-panel"),
  recordsPanel: document.querySelector("#records-panel"),
  transcriptList: document.querySelector("#transcript-list"),
  recordsList: document.querySelector("#records-list"),
  recordCount: document.querySelector("#record-count"),
  saveToVaultButton: document.querySelector("#save-to-vault-button"),
  loadTranscriptButton: document.querySelector("#load-transcript-button"),
  loadTranscriptCta: document.querySelector("#load-transcript-cta"),
  transcriptEmpty: document.querySelector("#transcript-empty"),
  composer: document.querySelector("#composer"),
  draftTime: document.querySelector("#draft-time"),
  draftText: document.querySelector("#draft-text"),
  draftNote: document.querySelector("#draft-note"),
  saveButton: document.querySelector("#save-button"),
  toast: document.querySelector("#toast")
};

let activeTabId = null;
let state = null;
let records = [];
let draft = null;
let currentTranscriptIndex = -1;
let activePanel = "transcript";

setComposerIdle();
initialize();

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

document.querySelectorAll(".tab").forEach((button) => {
  button.addEventListener("click", () => switchTab(button.dataset.tab));
});

elements.saveButton.addEventListener("click", saveDraft);
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

async function renderState() {
  if (!state?.video) return showEmpty("当前页面没有可读取的视频。");
  elements.title.textContent = state.video.title || "YouTube 学习记录";
  elements.empty.classList.add("hidden");
  elements.transcriptPanel.classList.toggle("hidden", activePanel !== "transcript");
  elements.recordsPanel.classList.toggle("hidden", activePanel !== "records");
  elements.loadTranscriptButton.disabled = false;

  const hasTranscript = state.transcript.length > 0;
  const isSaved = Boolean(state.sessionPath);
  elements.saveToVaultButton.disabled = !hasTranscript || isSaved;
  elements.saveToVaultButton.textContent = isSaved ? "已保存" : "保存到知识库";
  elements.transcriptEmpty.classList.toggle("hidden", hasTranscript);
  elements.transcriptList.classList.toggle("hidden", !hasTranscript);
  elements.loadTranscriptButton.textContent = hasTranscript ? "重新获取" : "获取字幕";
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

  const stored = await chrome.storage.local.get(`records:${state.video.videoId}`);
  records = stored[`records:${state.video.videoId}`] || [];
  renderRecords();
  updateCurrentTranscript(state.currentTime);
}

async function requestTranscript() {
  if (!activeTabId || !state?.video?.videoId) return;
  const requestedVideoId = state.video.videoId;
  elements.loadTranscriptButton.disabled = true;
  elements.loadTranscriptCta.disabled = true;
  elements.loadTranscriptButton.textContent = "获取中…";
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
    if (!state?.transcript?.length) elements.loadTranscriptButton.textContent = "获取字幕";
  }
}

async function saveToVault() {
  if (!activeTabId || !state?.transcript?.length || state.sessionPath) return;
  elements.saveToVaultButton.disabled = true;
  elements.saveToVaultButton.textContent = "保存中…";
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
    elements.saveToVaultButton.textContent = "保存到知识库";
    showToast(error.message || "保存失败");
  }
}

async function loadDraft() {
  if (!activeTabId) return;
  const key = `draft:${activeTabId}`;
  const stored = await chrome.storage.session.get(key);
  if (!stored[key]) return;
  draft = stored[key];
  elements.draftTime.textContent = draft.timestamp;
  elements.draftText.textContent = draft.text || "当前没有可读取的字幕，你仍可以记录想法。";
  elements.draftNote.value = "";
  elements.draftNote.disabled = false;
  elements.saveButton.disabled = false;
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
  elements.saveButton.disabled = true;
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
      <blockquote></blockquote>
      ${record.note ? "<div class=\"record-note\"></div>" : ""}
    `;
    article.querySelector("blockquote").textContent = record.text || "（无字幕）";
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
