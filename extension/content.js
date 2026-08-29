const BRIDGE_SOURCE = "youtube-study-bridge";

let videoInfo = null;
let transcript = [];
let lastUrl = location.href;
let sessionPath = "";

injectBridge();
requestPlayerData();

window.addEventListener("keydown", (event) => {
  const isNoteShortcut = event.code === "KeyN" || event.key.toLowerCase() === "n";
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !isNoteShortcut) return;
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable) return;

  event.preventDefault();
  event.stopPropagation();
  chrome.runtime.sendMessage({ type: "CAPTURE_SHORTCUT" }).catch(() => {});
}, true);

window.addEventListener("message", (event) => {
  const message = event.data;
  if (event.source !== window || message?.source !== BRIDGE_SOURCE) return;
  if (event.origin !== location.origin) return;
  if (message.type !== "PLAYER_DATA") return;
  if (!message.payload?.videoId) return;
  const pageVideoId = new URL(location.href).searchParams.get("v");
  if (pageVideoId && message.payload.videoId !== pageVideoId) return;

  const sameVideo = videoInfo?.videoId === message.payload.videoId;
  videoInfo = message.payload;
  if (!sameVideo) {
    transcript = [];
    sessionPath = "";
    restoreCachedTranscript(message.payload.videoId);
  }
  notifyState();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GET_VIDEO_STATE") {
    sendResponse(buildState());
    return;
  }

  if (message?.type === "SEEK_TO") {
    const video = document.querySelector("video");
    if (video) video.currentTime = Number(message.seconds) || 0;
    sendResponse({ ok: Boolean(video) });
    return;
  }

  if (message?.type === "GET_TIME") {
    sendResponse({ time: document.querySelector("video")?.currentTime || 0, videoId: videoInfo?.videoId || "" });
    return;
  }

  if (message?.type === "CAPTURE_MOMENT") {
    sendResponse(captureMoment());
    return;
  }

  if (message?.type === "LOAD_TRANSCRIPT") {
    const requestedVideo = videoInfo ? { ...videoInfo, url: location.href } : null;
    loadStudyTranscript(requestedVideo).then((result) => {
      if (!requestedVideo || videoInfo?.videoId !== requestedVideo.videoId) {
        sendResponse({ ok: false, error: "视频已切换，请重新获取字幕" });
        return;
      }
      transcript = result.transcript || [];
      sessionPath = result.sessionPath || "";
      notifyState();
      sendResponse({
        ok: result.ok && transcript.length > 0,
        videoId: requestedVideo.videoId,
        transcript,
        sessionPath,
        error: result.error || ""
      });
    }).catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (message?.type === "SAVE_TO_VAULT") {
    saveToVault(message.records || []).then((result) => {
      if (result?.ok) {
        sessionPath = result.sessionPath || result.notePath || "";
        notifyState();
      }
      sendResponse(result);
    }).catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (message?.type === "RESUME_VIDEO") {
    document.querySelector("video")?.play().catch(() => {});
    sendResponse({ ok: true });
  }
});

setInterval(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    videoInfo = null;
    transcript = [];
    sessionPath = "";
    notifyState();
    setTimeout(requestPlayerData, 500);
  }
}, 500);

function injectBridge() {
  if (document.documentElement.dataset.youtubeStudyBridge) return;
  document.documentElement.dataset.youtubeStudyBridge = "true";
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("bridge.js");
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);
}

async function loadStudyTranscript(video) {
  if (!video?.videoId) return { ok: false, error: "尚未读取到视频信息" };
  return chrome.runtime.sendMessage({
    type: "LOAD_TRANSCRIPT",
    video: {
      videoId: video.videoId,
      title: video.title,
      author: video.author,
      url: video.url
    }
  });
}

async function restoreCachedTranscript(videoId) {
  try {
    const result = await chrome.runtime.sendMessage({
      type: "RESTORE_TRANSCRIPT",
      videoId
    });
    if (videoInfo?.videoId !== videoId || !result?.ok || !result.transcript?.length) return;
    transcript = result.transcript;
    sessionPath = result.sessionPath || "";
    notifyState();
  } catch (_) {}
}

async function saveToVault(records) {
  if (!videoInfo?.videoId || !transcript.length) {
    return { ok: false, error: "请先获取当前视频字幕" };
  }
  return chrome.runtime.sendMessage({
    type: "SAVE_TO_VAULT",
    videoId: videoInfo.videoId,
    records
  });
}

function requestPlayerData() {
  window.postMessage({ source: BRIDGE_SOURCE, type: "REQUEST_PLAYER_DATA" }, location.origin);
}

function captureMoment() {
  const video = document.querySelector("video");
  if (!videoInfo || !video) return null;

  video.pause();
  const time = video.currentTime;
  const currentIndex = findCurrentIndex(time);
  const segment = buildSemanticSegment(currentIndex);

  return {
    videoId: videoInfo.videoId,
    title: videoInfo.title,
    author: videoInfo.author,
    url: location.href,
    time,
    timestamp: formatTime(time),
    text: segment.text,
    segmentStart: segment.start,
    createdAt: new Date().toISOString()
    ,sessionPath
  };
}

function buildSemanticSegment(index) {
  if (index < 0 || transcript.length === 0) return { text: "", start: 0 };

  let start = index;
  let end = index;
  let text = transcript[index].text;
  const sentenceEnd = /[.!?。！？][\]）)”’'\"]?$/;

  while (start > 0 && start > index - 3 && !sentenceEnd.test(transcript[start - 1].text)) {
    start -= 1;
    text = joinText(transcript[start].text, text);
  }

  while (end < transcript.length - 1 && end < index + 3 && !sentenceEnd.test(text)) {
    end += 1;
    text = joinText(text, transcript[end].text);
  }

  return { text: text.replace(/\s+/g, " ").trim(), start: transcript[start].start };
}

function joinText(left, right) {
  const CJK_EDGE = "[\\u3000-\\u303f\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef]";
  const adjacent = new RegExp(CJK_EDGE + "$").test(left.slice(-1))
    && new RegExp("^" + CJK_EDGE).test(right.slice(0, 1));
  return adjacent ? `${left}${right}` : `${left} ${right}`;
}

function findCurrentIndex(time) {
  let nearest = -1;
  for (let index = 0; index < transcript.length; index += 1) {
    if (transcript[index].start <= time + 0.3) nearest = index;
    else break;
  }
  return nearest;
}

function buildState() {
  const video = document.querySelector("video");
  return {
    video: videoInfo,
    transcript,
    currentTime: video?.currentTime || 0,
    paused: video?.paused ?? true
    ,sessionPath
  };
}

function notifyState() {
  chrome.runtime.sendMessage({ type: "VIDEO_STATE_READY", state: buildState() }).catch(() => {});
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
