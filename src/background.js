import { classify, cleanTitle, combineCandidates, dispositionTitle, headerValue, mediaUrl, pageKey, titleCandidates } from './media.js';
import { scanPage } from './scan-page.js';
import { bilibiliDownload } from './platforms/bilibili.js';
import { douyinDownload } from './platforms/douyin.js';
import { carryXEntries, xCandidates } from './platforms/x.js';
import { matchesYouTubePlayback, playbackKey, readYouTubePlayback } from './platforms/youtube-session.js';

const tabKey = id => 'tab:' + id;
const jobKey = 'download-job';
const filenameKey = 'download-filename';
const workerPage = chrome.runtime.getURL('download.html');
const refererRule = 50001;
const jobLock = -1;
const web = { urls: ['https://*/*', 'http://*/*'], types: ['media', 'xmlhttprequest', 'other'] };
const pending = new Map();

function serialize(tabId, operation) {
  const next = (pending.get(tabId) ?? Promise.resolve()).catch(() => {}).then(operation);
  pending.set(tabId, next);
  next.finally(() => {
    if (pending.get(tabId) === next) pending.delete(tabId);
  }).catch(() => {});
  return next;
}

async function tabState(id) {
  return (await chrome.storage.session.get(tabKey(id)))[tabKey(id)];
}

async function setTab(id, value) {
  await chrome.storage.session.set({ [tabKey(id)]: value });
  const count = value.entries.filter(entry => entry.kind !== 'fragment').length || Number(Boolean(value.douyin));
  await chrome.action.setBadgeText({ tabId: id, text: count ? String(count) : '' }).catch(() => {});
}

function pageState(page, documentId, since, resourceSince = 0) {
  return { page, documentId, since, resourceSince, epoch: crypto.randomUUID(), entries: [] };
}

function navigate({ tabId, frameId, url, timeStamp, documentId }, sameDocument) {
  if (frameId !== 0) return;
  void serialize(tabId, async () => {
    const previous = await tabState(tabId);
    const page = pageKey(url);
    if (page) {
      if (previous?.page === page && previous.documentId === documentId && sameDocument) return;
      const state = pageState(page, documentId, timeStamp, sameDocument ? timeStamp : 0);
      if (sameDocument && previous?.documentId === documentId) {
        const xEntries = carryXEntries(page, previous);
        if (xEntries.length) state.xEntries = xEntries;
      }
      await setTab(tabId, state);
    } else {
      await chrome.storage.session.remove(tabKey(tabId));
      await chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
    }
  }).catch(() => {});
}

chrome.webNavigation.onCommitted.addListener(details => navigate(details, false));
chrome.webNavigation.onHistoryStateUpdated.addListener(details => navigate(details, true));
chrome.webNavigation.onReferenceFragmentUpdated.addListener(details => navigate(details, true));
chrome.tabs.onRemoved.addListener(id => {
  void serialize(id, () => chrome.storage.session.remove([tabKey(id), playbackKey(id)])).catch(() => {});
});

function onMediaHeaders(details) {
  if (details.tabId < 0 || details.method !== 'GET' || ![200, 206].includes(details.statusCode)) return;
  const url = mediaUrl(details.url);
  if (!url) return;
  const mime = headerValue(details.responseHeaders, 'content-type');
  const range = headerValue(details.responseHeaders, 'content-range');
  const kind = classify({ url, mime, ranged: details.statusCode === 206 });
  if (!kind) return;
  const bytes = Number(range.split('/')[1] || headerValue(details.responseHeaders, 'content-length')) || 0;
  const fileTitle = dispositionTitle(headerValue(details.responseHeaders, 'content-disposition'));
  const began = requestStarts.get(details.requestId);
  void serialize(details.tabId, async () => {
    let state = await tabState(details.tabId);
    if (!state) {
      const frame = await chrome.webNavigation.getFrame({ tabId: details.tabId, frameId: 0 });
      const page = pageKey(frame?.url);
      if (!page || !began) return;
      state = pageState(page, frame.documentId, began);
    }
    if (details.timeStamp < state.since
        || (details.frameId === 0 && details.documentId && details.documentId !== state.documentId)) return;
    // Requests can complete after a same-document navigation. Only collect requests
    // initiated since the selected page's generation, including iframe requests.
    if (!began || began < state.since) return;
    state.entries = combineCandidates(state.entries, [{ url, kind, mime, bytes, fileTitle }]).slice(0, 100);
    await setTab(details.tabId, state);
  }).catch(() => {});
}

const requestStarts = new Map();
function onMediaRequest(details) {
  if (details.tabId < 0 || details.method !== 'GET') return;
  if (!requestStarts.has(details.requestId)) requestStarts.set(details.requestId, details.timeStamp);
  if (requestStarts.size > 4000) requestStarts.delete(requestStarts.keys().next().value);
}
const clearRequest = details => requestStarts.delete(details.requestId);

chrome.webRequest.onBeforeRequest.addListener(onMediaRequest, web);
chrome.webRequest.onHeadersReceived.addListener(onMediaHeaders, web, ['responseHeaders']);
chrome.webRequest.onCompleted.addListener(clearRequest, web);
chrome.webRequest.onErrorOccurred.addListener(clearRequest, web);
chrome.webRequest.onBeforeRequest.addListener(details => {
  const session = readYouTubePlayback(details);
  if (!session) return;
  const key = playbackKey(details.tabId);
  void serialize(details.tabId, async () => {
    const previous = (await chrome.storage.session.get(key))[key];
    if (previous?.config === session.config && Date.now() - previous.captured < 30_000) return;
    await chrome.storage.session.set({ [key]: session });
  }).catch(() => {});
}, { urls: ['https://*.googlevideo.com/videoplayback*'] }, ['requestBody']);

function addSnapshot(snapshot, frameId) {
  const entries = [];
  const items = snapshot.site === 'youtube' ? [] : [
    ...(snapshot.videos ?? []).map(video => ({ ...video, player: true })), ...(snapshot.resources ?? []),
  ];
  for (const item of items) {
    const url = mediaUrl(item.url);
    if (!url) continue;
    const kind = classify({ url, player: item.player, mime: item.mime, ranged: item.ranged });
    if (kind) entries.push({ ...item, url, kind, title: item.title || (frameId ? snapshot.title : '') });
  }
  const track = item => ({ ...item, url: mediaUrl(item.url) });
  const files = (snapshot.files ?? []).map(track).filter(item => item.url);
  if (files.length > 1 || (files.length && snapshot.site === 'douyin-video')) {
    const id = snapshot.site + ':' + frameId + ':files' + (snapshot.douyinPost ? ':' + snapshot.douyinPost : '');
    entries.push({ id, kind: 'files', files, site: snapshot.site, title: snapshot.title, postId: snapshot.douyinPost });
  } else if (files.length) {
    const { id, ...file } = files[0];
    entries.push({ ...file, kind: 'file', site: snapshot.site, title: snapshot.title });
  }
  const video = (snapshot.variants ?? []).map(track).filter(item => item.url);
  const audio = (snapshot.audio ?? []).map(track).filter(item => item.url);
  if (video.length && (snapshot.site !== 'youtube' || audio.length)) entries.push({
    id: snapshot.site + ':' + frameId + ':tracks', kind: 'tracks', video, audio,
    site: snapshot.site, duration: snapshot.duration, title: snapshot.title,
  });
  return entries;
}

async function scan(tabId, downloadPostId = null, forDownload = false) {
  const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
  const page = pageKey(frame?.url);
  if (!page) throw new Error('打开一个 HTTP 或 HTTPS 视频网页后再扫描。');
  const capture = await serialize(tabId, async () => {
    const state = await tabState(tabId);
    if (state?.page === page && state.documentId === frame.documentId) return state;
    const next = pageState(page, frame.documentId, Date.now());
    await setTab(tabId, next);
    return next;
  });
  const frames = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true }, world: 'MAIN', func: scanPage, args: [capture.resourceSince, downloadPostId],
  });
  return serialize(tabId, async () => {
    const current = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
    const state = await tabState(tabId);
    const top = frames.find(item => item.frameId === 0)?.result;
    if (pageKey(current?.url) !== page || current?.documentId !== frame.documentId ||
        state?.epoch !== capture.epoch || !top || pageKey(top.url) !== page) {
      throw new Error('页面已切换，请重新扫描。');
    }
    const snapshots = frames.flatMap(item => item.result ? addSnapshot(item.result, item.frameId) : []);
    const douyin = snapshots.find(entry => entry.site === 'douyin-video' && entry.postId === top.douyinPost);
    if (douyin && (state.douyin?.id !== douyin.id || JSON.stringify(state.douyin.files) !== JSON.stringify(douyin.files))) {
      state.douyin = douyin;
      await setTab(tabId, state);
    }
    let entries = combineCandidates(state.entries, snapshots);
    if (top.site === 'youtube') {
      entries = addSnapshot(top, 0);
      const manifests = (top.youtubeManifests ?? []).filter(item => mediaUrl(item.url));
      const source = top.youtubeSabr;
      if (source) {
        const key = playbackKey(tabId);
        const session = (await chrome.storage.session.get(key))[key];
        const { videoId, duration, video, audio } = source;
        entries = [];
        if (matchesYouTubePlayback(session, source)) {
          entries.push({ id: 'youtube:' + videoId + ':sabr', kind: 'youtube-sabr', site: 'youtube',
            videoId, duration, video, audio, title: top.title, ...(forDownload ? { session } : {}) });
        } else {
          top.hint = '请先播放 YouTube 正片几秒。扩展会在收到这条视频的音视频数据后显示下载项。';
        }
      }
      entries.push(...manifests);
    }
    else if (top.site === 'x') entries = xCandidates(entries, top, state.xEntries);
    else if (state.douyin?.postId && state.douyin.postId === top.douyinPost) entries = [state.douyin];
    const named = titleCandidates(entries, top.title);
    return { page, title: top.title, entries: [...named, ...entries.filter(entry => entry.kind === 'fragment')],
      epoch: capture.epoch, hint: top.hint };
  });
}

async function currentJob() {
  return (await chrome.storage.session.get(jobKey))[jobKey];
}

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (item.byExtensionId !== chrome.runtime.id) return;
  chrome.storage.session.get(filenameKey).then(values => {
    const pending = values[filenameKey];
    suggest(pending?.url === item.url ? { filename: pending.filename, conflictAction: 'uniquify' } : undefined);
  }, () => suggest());
  return true;
});

async function setJob(job) {
  await chrome.storage.session.set({ [jobKey]: job });
  await chrome.action.setBadgeText({ text: ['queued', 'running'].includes(job.state) ? '↓' : '' }).catch(() => {});
}

async function workerExists() {
  return (await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [workerPage],
  })).length > 0;
}

async function closeWorker() {
  await chrome.storage.session.remove(filenameKey).catch(() => {});
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [refererRule] }).catch(() => {});
  if (await workerExists()) await chrome.offscreen.closeDocument().catch(() => {});
}

async function reconcileJob() {
  const job = await currentJob();
  if (!job || !['queued', 'running'].includes(job.state)) return null;
  if (await workerExists()) {
    const response = await chrome.runtime.sendMessage({ type: 'probe-download', id: job.id }).catch(() => null);
    if (response?.active) return job;
  }
  await closeWorker();
  await setJob({ ...job, state: 'failed', message: '后台下载中断，请重新点击视频。' });
  return null;
}

async function startJob(message) {
  if (await reconcileJob()) throw new Error('已有一个下载正在进行。');
  const douyinPost = message.selection?.match(/^douyin-video:\d+:files:(\d+)$/)?.[1];
  const snapshot = await scan(message.tabId, douyinPost, true);
  if (snapshot.page !== message.page || snapshot.epoch !== message.epoch) {
    throw new Error('页面已切换，请重新扫描。');
  }
  const candidate = snapshot.entries.find(entry => (entry.id ?? entry.url) === message.selection);
  if (!candidate || candidate.kind === 'fragment') throw new Error('媒体地址已变化，请播放后重新扫描。');

  const id = crypto.randomUUID();
  const title = cleanTitle(message.title) || candidate.title;
  const status = { id, title, tabId: message.tabId, page: snapshot.page, site: candidate.site,
    state: 'queued', message: '正在启动后台下载…' };
  await setJob(status);
  try {
    if (!await workerExists()) {
      await chrome.offscreen.createDocument({
        url: 'download.html', reasons: ['BLOBS'],
        justification: 'Read and combine selected media streams before saving through the browser downloads manager.',
      });
    }
    const response = await chrome.runtime.sendMessage({ type: 'run-download', job: { id, title, candidate } });
    if (!response?.accepted) throw new Error('后台下载未能启动，请重试。');
    return { id };
  } catch (error) {
    await setJob({ ...status, state: 'failed', message: error.message });
    await closeWorker();
    throw error;
  }
}

async function cancelJob(id) {
  const job = await reconcileJob();
  if (job?.id !== id) return;
  await chrome.runtime.sendMessage({ type: 'cancel-download', id }).catch(() => {});
}

async function handleWorkerMessage(message) {
  const job = await currentJob();
  if (job?.id !== message.id || !['queued', 'running'].includes(job.state)) return;
  if (message.type === 'download-progress') {
    await setJob({ ...job, state: 'running', message: message.message, done: message.done, total: message.total,
      bytesPerSecond: message.bytesPerSecond });
  } else if (message.type === 'download-finished') {
    const { result } = message;
    if (result.state === 'saved' && result.filename) {
      const path = result.filename.replace(/[/\\][^/\\]*$/, '');
      await chrome.storage.local.set({ 'last-download-directory': path }).catch(() => {});
    }
    await setJob({ ...job, ...result });
    await closeWorker();
  } else if (message.type === 'download-native-start') {
    const allowedBlob = message.url.startsWith('blob:' + chrome.runtime.getURL('').slice(0, -1) + '/');
    if (!allowedBlob && !mediaUrl(message.url)) throw new Error('下载地址无效。');
    await chrome.storage.session.set({ [filenameKey]: { url: message.url, filename: message.filename } });
    const downloadId = await chrome.downloads.download({
      url: message.url, filename: message.filename, saveAs: false, conflictAction: 'uniquify',
    });
    await setJob({ ...job, nativeDownloadId: downloadId });
  } else if (message.type === 'download-native-status') {
    const [item] = await chrome.downloads.search({ id: job.nativeDownloadId });
    if (!item) throw new Error('浏览器下载记录已移除。');
    if (item.state === 'complete' && (!item.bytesReceived || /text\/html/i.test(item.mime))) {
      await chrome.downloads.removeFile(item.id).catch(() => {});
      throw new Error('站点没有返回有效的视频文件。');
    }
    return { state: item.state, filename: item.filename, bytesReceived: item.bytesReceived,
      totalBytes: item.totalBytes, error: item.error };
  } else if (message.type === 'download-native-cancel') {
    if (job.nativeDownloadId != null) await chrome.downloads.cancel(job.nativeDownloadId).catch(() => {});
  } else if (message.type === 'download-referer') {
    const platform = job.site === 'bilibili' ? bilibiliDownload : job.site === 'douyin-video' ? douyinDownload : undefined;
    if (!platform || !message.urls.length || message.urls.some(url => !mediaUrl(url) || platform.accepts?.(url) === false)) {
      throw new Error('此媒体地址无法使用站点来源设置。');
    }
    const requestDomains = [...new Set(message.urls.map(url => new URL(url).hostname))];
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [refererRule],
      addRules: [{
        id: refererRule, priority: 1,
        action: { type: 'modifyHeaders', requestHeaders: [
          { header: 'Referer', operation: 'set', value: platform.referer },
        ] },
        condition: { initiatorDomains: [chrome.runtime.id], requestDomains, resourceTypes: ['xmlhttprequest'] },
      }],
    });
  }
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;
  let result;
  if (sender.url === chrome.runtime.getURL('popup.html')) {
    if (message.type === 'scan') result = scan(message.tabId);
    if (message.type === 'start') result = serialize(jobLock, () => startJob(message));
    if (message.type === 'cancel') result = serialize(jobLock, () => cancelJob(message.id));
    if (message.type === 'reconcile') result = serialize(jobLock, reconcileJob);
  } else if (sender.url === workerPage && message.type.startsWith('download-')) {
    result = serialize(jobLock, () => handleWorkerMessage(message));
  }
  if (!result) return;
  result.then(data => reply({ data }), error => reply({ error: error.message }));
  return true;
});
