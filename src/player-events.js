// Ask an open popup to refresh when the actual video player becomes ready.
for (const name of ['loadedmetadata', 'loadeddata', 'emptied']) {
  document.addEventListener(name, event => {
    if (name === 'loadeddata' && !(['www.youtube.com', 'm.youtube.com'].includes(location.hostname)
        && location.pathname.startsWith('/shorts/'))) return;
    if (event.target instanceof HTMLVideoElement) {
      void chrome.runtime.sendMessage({ type: 'player-changed' }).catch(() => {});
    }
  }, true);
}
