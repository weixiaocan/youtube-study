(() => {
  const SOURCE = "youtube-study-bridge";

  function publishPlayerData() {
    const player = document.getElementById("movie_player");
    const pageVideoId = new URL(location.href).searchParams.get("v");
    const playerResponse = player?.getPlayerResponse?.();
    const initialResponse = window.ytInitialPlayerResponse;
    const response = [playerResponse, initialResponse].find(
      (candidate) => candidate?.videoDetails?.videoId === pageVideoId
    );
    const details = response?.videoDetails;
    const tracks = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];

    window.postMessage({
      source: SOURCE,
      type: "PLAYER_DATA",
      payload: {
        videoId: pageVideoId || details?.videoId,
        title: details?.title || document.title.replace(/\s*-\s*YouTube$/, ""),
        author: details?.author || "",
        tracks: tracks.map((track) => ({
          baseUrl: track.baseUrl,
          languageCode: track.languageCode,
          name: track.name?.simpleText || track.name?.runs?.map((run) => run.text).join("") || track.languageCode,
          kind: track.kind || ""
        }))
      }
    }, "*");
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== SOURCE) return;

    if (event.data.type === "REQUEST_PLAYER_DATA") {
      publishPlayerData();
    }

    if (event.data.type === "FETCH_CAPTION_TRACK") {
      fetchCaptionTrack(event.data.requestId, event.data.url);
    }
  });

  async function fetchCaptionTrack(requestId, urlValue) {
    try {
      const url = new URL(urlValue, location.href);
      if (url.protocol !== "https:" || !/(^|\.)youtube\.com$/.test(url.hostname)) {
        throw new Error("不允许的字幕地址");
      }
      const response = await fetch(url.toString(), { credentials: "include" });
      window.postMessage({
        source: SOURCE,
        type: "CAPTION_TRACK_RESULT",
        requestId,
        payload: {
          ok: response.ok,
          status: response.status,
          text: await response.text()
        }
      }, "*");
    } catch (error) {
      window.postMessage({
        source: SOURCE,
        type: "CAPTION_TRACK_RESULT",
        requestId,
        payload: { ok: false, status: 0, text: "", error: String(error) }
      }, "*");
    }
  }

  document.addEventListener("yt-navigate-finish", () => {
    [300, 800, 1500].forEach((delay) => setTimeout(publishPlayerData, delay));
  });
  publishPlayerData();
})();
