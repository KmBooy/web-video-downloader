import { EncodedPacketSink } from 'mediabunny';
import { chromeFilename, safeFilename, selectQuality } from './media.js';
import { dashManifest, hlsChildren, hlsManifest } from './playlists.js';
import { checkCompleteResponse, copyPart, manifestText } from './transport.js';
import { prepareMux, remoteInput } from './mux.js';
import { getSettings } from './settings-store.js';
import { bilibiliDownload } from './platforms/bilibili.js';
import { douyinDownload } from './platforms/douyin.js';
import { stageYouTube } from './platforms/youtube-download.js';

const MIB = 1024 * 1024;
const active = new Map();
let staleCleanup;

function heightOf(track) {
  return track.width && track.height ? Math.min(track.width, track.height) : track.height;
}

async function choose(candidate, maxHeight, signal) {
  let choices;
  if (candidate.kind === 'tracks') {
    const audio = candidate.audio.slice().sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
    if (!audio) throw new Error('只识别到视频轨，未取得配套音轨。');
    choices = candidate.video.map(track => ({
      height: heightOf(track), bitrate: track.bitrate, video: { url: track.url },
      audio: { url: audio.url }, duration: candidate.duration,
    }));
  } else if (['file', 'files'].includes(candidate.kind)) {
    choices = (candidate.files ?? [candidate]).map(item => ({
      height: heightOf(item), bitrate: item.bitrate, direct: item,
    }));
  } else {
    const { text, url } = await manifestText(candidate.url, signal);
    choices = candidate.kind === 'hls' ? hlsManifest(text, url).map(item => ({
      height: item.height, bitrate: item.bitrate, duration: item.duration, hls: true,
      video: { url: item.videoUrl }, audio: item.audioUrl ? { url: item.audioUrl } : undefined,
      videoOnly: candidate.site === 'x' && item.videoOnly,
    })) : dashManifest(text, url);
  }

  const choice = selectQuality(choices, maxHeight);
  if (!choice) throw new Error(maxHeight ? '没有符合 ' + maxHeight + 'p 上限的可用画质。' : '未取得可下载的画质。');
  // A media playlist already passed the checks above and supplied a duration.
  if (choice.hls && choice.duration == null) {
    const children = [];
    for (const spec of [choice.video, choice.audio].filter(Boolean)) {
      const child = await manifestText(spec.url, signal);
      const details = hlsChildren(child.text, child.url);
      spec.url = child.url;
      choice.duration ??= details.duration;
      children.push(details);
    }
    if (children.length === 2) {
      choice.hlsTimeline = children.every(item => item.dateTime);
      if (!choice.hlsTimeline && children.some(item => item.dateTime || item.discontinuous)) {
        throw new Error('分离的 HLS 音视频轨缺少可共同对齐的时间线。');
      }
    }
  }
  return choice;
}

async function checkDirect(url, signal, maxHeight) {
  let fetchFailure;
  const input = remoteInput(url, signal, false, error => { fetchFailure ??= error; });
  try {
    const video = await input.getPrimaryVideoTrack();
    if (!video) throw new Error('这个地址缺少视频轨，无法作为完整文件保存。');
    const hasAudio = Boolean(await input.getPrimaryAudioTrack());
    if (!hasAudio) {
      const pathname = new URL(url).pathname;
      if (/\/media-(?:audio|video)-[^/]+\/?$/i.test(pathname)
          || !await new EncodedPacketSink(video).getFirstPacket()) {
        throw new Error('这个地址只包含分离的轨道或初始化片段，无法作为完整文件保存。');
      }
      await checkCompleteResponse(url, signal);
    }
    if (maxHeight && Math.min(await video.getDisplayWidth(), await video.getDisplayHeight()) > maxHeight) {
      throw new Error('原文件画质超出 ' + maxHeight + 'p 上限。');
    }
    return hasAudio;
  } catch (error) {
    throw fetchFailure ?? error;
  } finally {
    input.dispose();
  }
}

async function nativeDownload(job, url, filename, signal, report) {
  signal.throwIfAborted();
  const send = async (type, args = {}) => {
    const response = await chrome.runtime.sendMessage({ type, id: job.id, ...args });
    if (response?.error || !response) throw new Error(response?.error || '浏览器下载器未响应。');
    return response.data;
  };
  await send('download-native-start', { url, filename });
  try {
    while (true) {
      signal.throwIfAborted();
      const item = await send('download-native-status');
      if (item.state === 'complete') return { filename: item.filename, bytes: item.bytesReceived };
      if (item.state === 'interrupted') {
        throw new Error(item.error === 'FILE_NO_SPACE' ? '浏览器下载目录的空间不足。'
          : '浏览器下载中断' + (item.error ? '（' + item.error + '）' : '') + '。');
      }
      report('Tabbit / Chrome 下载器正在保存…', item.bytesReceived, item.totalBytes);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  } catch (error) {
    await send('download-native-cancel').catch(() => {});
    throw error;
  }
}

function makeProgress(id) {
  let last = 0;
  let phase;
  return (message, done, total, bytesPerSecond) => {
    if (message === phase && Date.now() - last < 350) return;
    last = Date.now();
    phase = message;
    void chrome.runtime.sendMessage({ type: 'download-progress', id, message, done, total, bytesPerSecond }).catch(() => {});
  };
}

async function useSiteReferer(id, urls) {
  const response = await chrome.runtime.sendMessage({ type: 'download-referer', id, urls });
  if (response?.error || !response) throw new Error(response?.error || '未能设置下载来源。');
}

async function selectDouyinSource(direct, id, signal, maxHeight) {
  const urls = [direct.url, ...(direct.mirrors ?? [])].filter(douyinDownload.accepts);
  const verify = async url => {
    // Silent files already pass this check inside checkDirect.
    if (await checkDirect(url, signal, maxHeight)) await checkCompleteResponse(url, signal);
  };
  let needsReferer = false;
  let failure;
  for (const url of urls) {
    try {
      try {
        await verify(url);
      } catch (error) {
        signal.throwIfAborted();
        if (error.status !== 403 || needsReferer) throw error;
        await useSiteReferer(id, urls);
        needsReferer = true;
        await verify(url);
      }
      return { url, needsReferer };
    } catch (error) {
      signal.throwIfAborted();
      if (![401, 403, 404, 410].includes(error.status)) throw error;
      failure = error;
    }
  }
  throw failure ?? new Error('未取得可用的抖音视频地址。');
}

async function writeVideo(job, signal) {
  const { maxHeight, maxMiB } = await getSettings();
  const report = makeProgress(job.id);
  const maximum = maxMiB ? maxMiB * MIB : Infinity;
  const checkSize = size => {
    if (size > maximum) throw new Error('超出设置的 ' + maxMiB + ' MiB 上限，未保存。');
  };
  report('正在识别画质和媒体轨…');
  const youtube = job.candidate.kind === 'youtube-sabr';
  let choice = youtube ? undefined : await choose(job.candidate, maxHeight, signal);
  const platform = job.candidate.site === 'bilibili' ? bilibiliDownload : undefined;
  let needsReferer = Boolean(platform?.referer);
  if (needsReferer) await useSiteReferer(job.id, [choice.direct?.url, choice.video?.url, choice.audio?.url].filter(Boolean));

  let mux;
  let scratchName;
  let scratchRoot;
  let writable;
  let blobUrl;
  try {
    if (youtube) {
      scratchRoot = await navigator.storage.getDirectory();
      scratchName = 'browser-download-' + job.id;
      const scratch = await scratchRoot.getDirectoryHandle(scratchName, { create: true });
      choice = await stageYouTube(job.candidate, scratch, signal, report, maxHeight, maximum);
    }
    let direct = choice.direct;
    const height = choice.height ? ' · ' + choice.height + 'p' : '';
    if (direct) {
      checkSize(direct.bytes || 0);
      if (job.candidate.site === 'douyin-video' && douyinDownload.accepts(direct.url)) {
        const source = await selectDouyinSource(direct, job.id, signal, maxHeight);
        direct = { ...direct, url: source.url };
        needsReferer = source.needsReferer;
      } else await checkDirect(direct.url, signal, maxHeight);
    } else {
      mux = await prepareMux({ ...choice, stageWithoutRanges: platform?.stageWithoutRanges }, signal, report, job.id, maxHeight);
    }
    signal.throwIfAborted();
    const filename = direct ? chromeFilename(job.title, direct.url, direct.mime)
      : safeFilename(job.title) + '.' + mux.extension;
    if (direct && !maxMiB && !needsReferer) {
      return await nativeDownload(job, direct.url, filename, signal, report);
    }
    scratchRoot ??= await navigator.storage.getDirectory();
    scratchName ??= 'browser-download-' + job.id;
    const scratch = await scratchRoot.getDirectoryHandle(scratchName, { create: true });
    const file = await scratch.getFileHandle(filename, { create: true });
    writable = await file.createWritable({ mode: 'exclusive' });
    let size = 0;
    const guarded = {
      write(chunk) {
        const position = chunk.type === 'write' ? chunk.position : size;
        const length = chunk.type === 'write' ? chunk.data.byteLength : chunk.byteLength;
        checkSize(position + length);
        size = Math.max(size, position + length);
        return writable.write(chunk);
      },
    };
    if (direct) {
      const bytes = await copyPart({ url: direct.url },
        (data, position) => guarded.write({ type: 'write', position, data }), signal, (done, total) => {
          checkSize(total);
          report('正在下载原文件' + height, done, total);
        });
      await writable.truncate(bytes);
    } else {
      report(youtube ? '正在合并音视频' : (mux.hasAudio ? '正在下载并合并音视频' : '正在下载视频') + height);
      await mux.write(guarded);
    }
    signal.throwIfAborted();
    await writable.close();
    writable = undefined;
    blobUrl = URL.createObjectURL(await file.getFile());
    return await nativeDownload(job, blobUrl, filename, signal, report);
  } catch (error) {
    await writable?.abort().catch(() => {});
    throw error;
  } finally {
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    if (scratchName) await scratchRoot.removeEntry(scratchName, { recursive: true }).catch(() => {});
    await mux?.dispose();
  }
}

async function cleanStaleDownloads() {
  const root = await navigator.storage.getDirectory();
  const jobDirectory = /^(?:browser-download|media)-([\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12})$/i;
  for await (const [name, entry] of root.entries()) {
    const match = name.match(jobDirectory);
    if (entry.kind === 'directory' && match) {
      await root.removeEntry(name, { recursive: true }).catch(() => {});
    }
  }
}

async function run(job, controller) {
  let result;
  try {
    // All jobs wait for the same cleanup before any of them creates a directory.
    await (staleCleanup ??= cleanStaleDownloads().catch(() => {}));
    controller.signal.throwIfAborted();
    const file = await writeVideo(job, controller.signal);
    result = { state: 'saved', message: '已保存 ' + file.filename, ...file };
  } catch (error) {
    result = controller.signal.aborted ? { state: 'cancelled', message: '已取消下载。' }
      : { state: 'failed', message: error.name === 'QuotaExceededError'
        ? '浏览器用于合并和暂存的空间不足。' : error.message || '下载失败。' };
  }
  await chrome.runtime.sendMessage({ type: 'download-finished', id: job.id, result }).catch(() => {});
  active.delete(job.id);
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || sender.tab) return;
  if (message.type === 'run-download' && !active.has(message.job.id)) {
    const controller = new AbortController();
    active.set(message.job.id, controller);
    reply({ accepted: true });
    void run(message.job, controller);
  } else if (message.type === 'cancel-download' && active.has(message.id)) {
    active.get(message.id).abort();
    reply({ accepted: true });
  } else if (message.type === 'probe-downloads') {
    reply({ ids: [...active.keys()] });
  }
});
