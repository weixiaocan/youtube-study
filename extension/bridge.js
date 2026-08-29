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

    window.postMessage({
      source: SOURCE,
      type: "PLAYER_DATA",
      payload: {
        videoId: pageVideoId || details?.videoId,
        title: details?.title || document.title.replace(/\s*-\s*YouTube$/, ""),
        author: details?.author || ""
      }
    }, location.origin);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    if (event.data?.source !== SOURCE) return;

    if (event.data.type === "REQUEST_PLAYER_DATA") {
      publishPlayerData();
    }
  });

  document.addEventListener("yt-navigate-finish", () => {
    [300, 800, 1500].forEach((delay) => setTimeout(publishPlayerData, delay));
  });
  publishPlayerData();
})();
