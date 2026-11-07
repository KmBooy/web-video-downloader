import { contextHosts } from './context-target.js';

const menuId = 'download-context-video';
const patterns = contextHosts.flatMap(host => ['https://' + host + '/*', 'http://' + host + '/*']);

export function installContextMenu(startJob) {
  chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: menuId, title: '下载这个视频', contexts: ['video', 'page', 'link', 'image'], documentUrlPatterns: patterns,
      });
    });
    void chrome.tabs.query({ url: patterns }).then(tabs => Promise.all(tabs.map(tab =>
      chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['player-events.js'] }).catch(() => {}))))
      .catch(() => {});
  });

  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== menuId || tab?.id == null) return;
    const frame = { frameId: info.frameId ?? 0 };
    void (async () => {
      let feedback;
      try {
        const response = await chrome.tabs.sendMessage(tab.id, { type: 'get-video-context' }, frame);
        if (!response?.target) throw new Error(response?.error || '请刷新网页后，在视频画面或对应帖子上重新右键。');
        const job = await startJob({ tabId: tab.id, contextTarget: response.target });
        feedback = '已添加下载「' + Array.from(job.title).slice(0, 30).join('') + '」';
      } catch (error) {
        feedback = error.message;
      }
      await chrome.tabs.sendMessage(tab.id, { type: 'context-download-feedback', text: feedback }, frame).catch(() => {});
    })();
  });
}
