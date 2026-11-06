const $ = id => document.getElementById(id);
const labels = { file: '完整文件', hls: 'HLS 清单', dash: 'DASH 清单', tracks: '分离音视频', files: '完整文件',
  'youtube-sabr': 'YouTube · 合并音视频' };
const jobLabels = { queued: '下载中', running: '下载中', saved: '已保存', failed: '下载失败', cancelled: '已取消' };
const titleSegmenter = new Intl.Segmenter();
let currentTab;
let currentPage;
let scheduledRefresh;
let revision = 0;
let jobs = [];
const starting = new Set();
const cancelling = new Set();
const jobRows = new Map();

async function call(type, args = {}) {
  const reply = await chrome.runtime.sendMessage({ type, ...args });
  if (!reply || reply.error) throw new Error(reply?.error || '扩展没有响应，请重新打开弹窗。');
  return reply.data;
}

const isActive = job => job.state === 'queued' || job.state === 'running';
const selectionKey = (tabId, page, selection) => JSON.stringify([tabId, page, selection]);

function displayTitle(name) {
  const characters = Array.from(titleSegmenter.segment(name), item => item.segment);
  return characters.length > 30 ? characters.slice(0, 29).join('') + '…' : name;
}

function syncJobs() {
  const pageJobs = jobs.filter(job => job.tabId === currentTab && job.page === currentPage);
  const activeSelections = new Set(pageJobs.filter(isActive).map(job => job.selection));
  for (const button of $('media').children) {
    button.disabled = activeSelections.has(button.dataset.selection)
      || starting.has(selectionKey(currentTab, currentPage, button.dataset.selection));
  }

  const list = $('download-jobs');
  list.hidden = !pageJobs.length;
  const ids = new Set(pageJobs.map(job => job.id));
  for (const [id, row] of jobRows) {
    if (ids.has(id)) continue;
    row.remove();
    jobRows.delete(id);
  }
  for (const [index, job] of pageJobs.entries()) {
    let row = jobRows.get(job.id);
    if (!row) {
      row = $('job-template').content.firstElementChild.cloneNode(true);
      row.dataset.jobId = job.id;
      row.querySelector('button').addEventListener('click', () => { void cancel(job.id); });
      jobRows.set(job.id, row);
    }
    const [title, actions, progress] = row.children;
    const [status, button] = actions.children;
    const active = isActive(job);
    const name = job.title || '网页视频';
    if (title.title !== name) {
      title.title = name;
      title.textContent = displayTitle(name);
    }
    const speed = active && job.bytesPerSecond > 0
      ? ' · ' + (job.bytesPerSecond / 1048576).toFixed(2) + ' MiB/s' : '';
    const label = cancelling.has(job.id) && active ? '取消中' : jobLabels[job.state] || '';
    if (status.textContent !== label) status.textContent = label;
    status.title = (job.message || label) + speed;
    button.hidden = !active;
    button.disabled = cancelling.has(job.id);
    button.setAttribute('aria-label', '取消下载 ' + name);
    progress.hidden = !active || !(job.total > 0) || !Number.isFinite(job.done);
    if (!progress.hidden) {
      progress.max = job.total;
      progress.value = Math.max(0, Math.min(job.done, job.total));
    }
    if (list.children[index] !== row) list.insertBefore(row, list.children[index] ?? null);
  }
}

async function start(result, entry, tabId) {
  const selection = entry.id ?? entry.url;
  const key = selectionKey(tabId, result.page, selection);
  if (starting.has(key)) return;
  starting.add(key);
  syncJobs();
  try {
    await call('start', {
      tabId, page: result.page, epoch: result.epoch, selection, title: entry.title,
    });
  } catch (error) {
    if (currentTab === tabId && currentPage === result.page) $('state').textContent = error.message;
  } finally {
    starting.delete(key);
    syncJobs();
  }
}

async function refresh(quiet = false) {
  const run = ++revision;
  if (!quiet) {
    $('state').textContent = '正在扫描…';
    $('refresh').disabled = true;
    $('media').replaceChildren();
  }
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (run !== revision) return;
    if (currentTab !== tab?.id) {
      currentTab = tab?.id;
      currentPage = undefined;
      $('media').replaceChildren();
      syncJobs();
    }
    if (currentTab == null) throw new Error('没有可扫描的当前页面。');
    const result = await call('scan', { tabId: currentTab });
    if (run !== revision) return;
    currentPage = result.page;
    const media = $('media');
    const existing = new Map(Array.from(media.children, button => [button.dataset.selection, button]));
    const fragments = result.entries.filter(entry => entry.kind === 'fragment');
    const choices = result.entries.filter(entry => entry.kind !== 'fragment');
    $('state').textContent = choices.length ? '识别到 ' + choices.length + ' 个可保存项目'
      : fragments.length ? '只找到播放片段。播放后重新扫描，等待完整文件或清单。'
      : result.hint || '暂未发现视频。先播放，再重新扫描。';
    for (const [index, entry] of choices.entries()) {
      const selection = entry.id ?? entry.url;
      let button = existing.get(selection);
      if (button) existing.delete(selection);
      else {
        button = document.createElement('button');
        button.className = 'media';
        button.dataset.selection = selection;
        const title = document.createElement('span');
        title.className = 'media-title';
        const details = document.createElement('span');
        details.className = 'media-details';
        button.append(title, details);
      }
      const variants = entry.video ?? entry.files ?? [entry];
      const name = variants.map(item => item.height ? item.height + 'p' : '').filter(Boolean);
      const sizes = [...new Set(name)];
      const host = entry.url ? new URL(entry.url).hostname : '';
      const label = entry.site === 'douyin-replay' ? '直播回放 · 合并音视频'
        : entry.site === 'douyin-video' ? '普通抖音视频 · 直接下载' : labels[entry.kind];
      button.firstElementChild.textContent = displayTitle(entry.title);
      button.firstElementChild.title = entry.title;
      const size = entry.bytes > 0 ? (entry.bytes / (1024 * 1024)).toFixed(1) + ' MiB' : '';
      button.lastElementChild.textContent = [label, sizes.join(' / '), size, host].filter(Boolean).join(' · ');
      button.onclick = () => { void start(result, entry, tab.id); };
      if (media.children[index] !== button) media.insertBefore(button, media.children[index] ?? null);
    }
    for (const button of existing.values()) button.remove();
    syncJobs();
  } catch (error) {
    if (run === revision) $('state').textContent = error.message;
  } finally {
    if (run === revision) $('refresh').disabled = false;
  }
}

$('settings').addEventListener('click', async () => {
  try { await chrome.runtime.openOptionsPage(); }
  catch (error) { $('state').textContent = error.message; }
});
async function cancel(id) {
  if (cancelling.has(id)) return;
  cancelling.add(id);
  syncJobs();
  try { await call('cancel', { id }); }
  catch (error) {
    cancelling.delete(id);
    if (jobRows.has(id)) $('state').textContent = error.message;
    syncJobs();
  }
}
function scheduleRefresh(clear) {
  if (clear) {
    revision++;
    currentPage = undefined;
    $('media').replaceChildren();
    $('state').textContent = '正在读取新页面…';
    syncJobs();
  }
  if (scheduledRefresh != null) return;
  scheduledRefresh = setTimeout(() => {
    scheduledRefresh = undefined;
    void refresh(true);
  }, 180);
}

$('refresh').addEventListener('click', () => { void refresh(); });
chrome.tabs.onActivated.addListener(() => scheduleRefresh(true));
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type === 'player-changed' && sender.tab?.id === currentTab) scheduleRefresh(false);
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (tabId !== currentTab) return;
  if (change.url || change.status === 'loading') scheduleRefresh(true);
  else if (change.status === 'complete') scheduleRefresh(false);
});
let jobsChanged = false;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session') return;
  if (changes['tab:' + currentTab] || changes['youtube-playback:' + currentTab]) scheduleRefresh(false);
  if (changes['download-jobs']) {
    jobsChanged = true;
    jobs = changes['download-jobs'].newValue ?? [];
    for (const id of cancelling) {
      if (!jobs.some(job => job.id === id && isActive(job))) cancelling.delete(id);
    }
    syncJobs();
  }
});
const initial = await chrome.storage.session.get('download-jobs');
if (!jobsChanged) jobs = initial['download-jobs'] ?? [];
syncJobs();
void call('reconcile').catch(() => {});
void refresh();
