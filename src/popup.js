const $ = id => document.getElementById(id);
const labels = { file: '完整文件', hls: 'HLS 清单', dash: 'DASH 清单', tracks: '分离音视频', files: '完整文件',
  'youtube-sabr': 'YouTube · 合并音视频' };
const jobLabels = { queued: '等待下载…', running: '正在下载…', saved: '已保存。', failed: '下载失败。', cancelled: '已取消。' };
let currentTab;
let currentPage;
let scheduledRefresh;
let revision = 0;
let job;
let starting = false;
let cancelling = false;

async function call(type, args = {}) {
  const reply = await chrome.runtime.sendMessage({ type, ...args });
  if (!reply || reply.error) throw new Error(reply?.error || '扩展没有响应，请重新打开弹窗。');
  return reply.data;
}

function isActive() {
  return job?.state === 'queued' || job?.state === 'running';
}

function syncJob() {
  const active = isActive();
  for (const button of $('media').querySelectorAll('.media')) button.disabled = active || starting;
  $('download-job').hidden = !job || (!active && (job.tabId !== currentTab || job.page !== currentPage));
  if (!job) return;
  $('job-title').textContent = job.title || '网页视频';
  const message = job.message || jobLabels[job.state] || '';
  const speed = active && job.bytesPerSecond > 0
    ? ' · ' + (job.bytesPerSecond / 1048576).toFixed(2) + ' MiB/s' : '';
  $('job-message').textContent = cancelling ? '正在取消…' : message + speed;
  $('cancel-job').hidden = !active;
  $('cancel-job').disabled = cancelling;
  const progress = $('job-progress');
  progress.hidden = !active || !(job.total > 0) || !Number.isFinite(job.done);
  if (!progress.hidden) {
    progress.max = job.total;
    progress.value = Math.max(0, Math.min(job.done, job.total));
  }
}

async function start(result, entry, tabId) {
  if (starting || isActive()) return;
  starting = true;
  syncJob();
  try {
    await call('start', {
      tabId, page: result.page, epoch: result.epoch, selection: entry.id ?? entry.url, title: entry.title,
    });
  } catch (error) {
    $('state').textContent = error.message;
  } finally {
    starting = false;
    syncJob();
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
      syncJob();
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
      button.firstElementChild.textContent = entry.title;
      const size = entry.bytes > 0 ? (entry.bytes / (1024 * 1024)).toFixed(1) + ' MiB' : '';
      button.lastElementChild.textContent = [label, sizes.join(' / '), size, host].filter(Boolean).join(' · ');
      button.onclick = () => { void start(result, entry, tab.id); };
      if (media.children[index] !== button) media.insertBefore(button, media.children[index] ?? null);
    }
    for (const button of existing.values()) button.remove();
    syncJob();
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
$('cancel-job').addEventListener('click', async () => {
  if (cancelling || !isActive()) return;
  cancelling = true;
  syncJob();
  try { await call('cancel', { id: job.id }); }
  catch (error) { $('state').textContent = error.message; }
  finally {
    cancelling = false;
    syncJob();
  }
});
function scheduleRefresh(clear) {
  if (clear) {
    revision++;
    currentPage = undefined;
    $('media').replaceChildren();
    $('state').textContent = '正在读取新页面…';
    syncJob();
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
let jobChanged = false;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session') return;
  if (changes['tab:' + currentTab] || changes['youtube-playback:' + currentTab]) scheduleRefresh(false);
  if (changes['download-job']) {
    jobChanged = true;
    job = changes['download-job'].newValue;
    syncJob();
  }
});
const initial = await chrome.storage.session.get('download-job');
if (!jobChanged) job = initial['download-job'];
syncJob();
void call('reconcile').catch(() => {});
void refresh();
