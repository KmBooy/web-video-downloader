export function scanXiaohongshu({ url, result, clip }) {
  const id = url.pathname.match(/\/(?:explore|discovery\/item)\/([a-f\d]+)/i)?.[1];
  const note = window.__INITIAL_STATE__?.note?.noteDetailMap?.[id]?.note;
  if (document.title === '安全限制') result.hint = '小红书当前未开放这条笔记，请在网页能播放后重新扫描。';
  if (note?.video?.media?.stream) {
    result.files = Object.values(note.video.media.stream).flat().map(entry => clip({
      ...entry, url: entry.masterUrl ?? entry.backupUrls?.[0],
    }));
    result.title = note.title || result.title;
    result.site = 'xiaohongshu';
  }
}
