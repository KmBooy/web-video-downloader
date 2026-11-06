// Ask an open popup to refresh when the actual video player becomes ready.
for (const name of ['loadedmetadata', 'emptied']) {
  document.addEventListener(name, event => {
    if (event.target instanceof HTMLVideoElement) {
      void chrome.runtime.sendMessage({ type: 'player-changed' }).catch(() => {});
    }
  }, true);
}
