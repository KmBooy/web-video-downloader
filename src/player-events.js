import { contextVideo, describeContextVideo } from './context-target.js';

// Installation also injects this into existing tabs.
if (!globalThis.__webVideoEventsInstalled) {
  globalThis.__webVideoEventsInstalled = true;
  let savedContext;
  let feedback;
  window.addEventListener('contextmenu', event => {
    const video = contextVideo(event.composedPath()[0], event.clientX, event.clientY);
    const target = video && describeContextVideo(video);
    savedContext = target ? { video, target, fingerprint: JSON.stringify(target) } : null;
    // X replaces the native menu. Keep the browser menu for a known video;
    // Shift-right-click continues to use the website's own menu.
    if (target?.site === 'x' && target.mediaId && !event.shiftKey) event.stopImmediatePropagation();
  }, true);
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message.type === 'get-video-context') {
      const saved = savedContext;
      savedContext = null;
      if (saved?.video.isConnected && JSON.stringify(describeContextVideo(saved.video)) === saved.fingerprint) {
        reply({ target: saved.target });
      } else reply({ error: saved ? '右键选中的视频已变化，请在目标视频上重新右键。'
        : '请先播放，再在视频画面或对应帖子上右键。' });
    } else if (message.type === 'context-download-feedback') {
      feedback?.remove();
      const notice = document.createElement('div');
      notice.setAttribute('role', 'status');
      notice.textContent = '网页视频下载器 · ' + message.text;
      notice.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
        'max-width:80vw;padding:12px 18px;background:#202124;color:white;border-radius:10px;font:14px/1.5 system-ui;pointer-events:none';
      document.documentElement.append(notice);
      feedback = notice;
      setTimeout(() => notice.remove(), 4500);
    }
  });

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
}
