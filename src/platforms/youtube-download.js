import { SabrStream } from 'googlevideo/sabr-stream';
import { buildSabrFormat } from 'googlevideo/utils';
import { selectQuality } from '../media.js';
import { googleVideoUrl } from './youtube-session.js';

export async function stageYouTube(candidate, scratch, signal, report, maxHeight, maximum) {
  const formats = [...candidate.video, ...candidate.audio].flatMap(format => {
    try { return [buildSabrFormat(format)]; } catch { return []; }
  });
  const videos = formats.filter(format => format.hasVideo).map(format => ({
    format, height: Math.min(format.width || format.height, format.height) || undefined, bitrate: format.bitrate,
  }));
  const audio = formats.filter(format => format.hasAudio)
    .sort((a, b) => Number(b.isOriginal) - Number(a.isOriginal) || b.bitrate - a.bitrate)[0];
  const aac = formats.find(format => format.itag === 140 && !format.xtags)
    ?? formats.find(format => format.hasAudio && /^audio\/mp4\b/.test(format.mimeType));
  const best = selectQuality(videos, maxHeight);
  const compatible = selectQuality(videos.filter(item => /codecs="avc1/.test(item.format.mimeType)), maxHeight);
  const baseline = selectQuality(videos.filter(item => item.format.itag === 134), maxHeight);
  if (!best || !audio) throw new Error('YouTube 未提供符合设置的完整音视频轨。');

  let failure;
  const tried = new Set();
  for (const [item, track] of [[best, audio], [compatible, aac], [baseline, aac]]) {
    if (!item || !track) continue;
    const key = JSON.stringify([item.format.itag, item.format.xtags, track.itag, track.xtags]);
    if (tried.has(key)) continue;
    tried.add(key);
    try {
      const result = await readTracks(candidate, formats, item.format, track, scratch, signal, report, maximum);
      return { ...result, height: item.height, duration: candidate.duration };
    } catch (error) {
      signal.throwIfAborted();
      if (!error.retryFormat) throw error;
      failure = error;
    }
  }
  throw new Error(failure?.reloadRequested
    ? 'YouTube 要求更新播放会话。请确认当前视频能正常播放，刷新后再试。'
    : 'YouTube 拒绝了这条视频的可用音视频轨。', { cause: failure });
}

async function readTracks(candidate, formats, video, audio, scratch, signal, report, maximum) {
  const session = candidate.session;
  const reader = new SabrStream({
    videoId: candidate.videoId, formats, serverAbrStreamingUrl: session.url,
    videoPlaybackUstreamerConfig: session.config, clientInfo: session.clientInfo, poToken: session.poToken,
    fetchFunction(url, init) {
      if (!googleVideoUrl(String(url))) throw new Error('YouTube 媒体地址无效。');
      return fetch(url, {
        ...init, headers: { 'Content-Type': 'text/plain' }, credentials: 'omit', redirect: 'error',
        signal: AbortSignal.any([signal, init.signal].filter(Boolean)),
      });
    },
  });
  const abort = () => { void reader.abort().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  let failure;
  reader.on('error', error => { failure ??= error; });
  let bytes = 0;
  const knownSize = (video.contentLength || 0) + (audio.contentLength || 0);
  const total = video.contentLength && audio.contentLength ? knownSize : undefined;
  const startedAt = performance.now();
  const checkSize = size => {
    if (size > maximum) throw new Error('超出设置的单个文件大小上限，未保存。');
  };
  async function stage(name, stream) {
    const handle = await scratch.getFileHandle(name, { create: true });
    const file = await handle.createWritable();
    const buffer = new Uint8Array(512 * 1024);
    let pending = 0;
    try {
      for await (const chunk of stream) {
        signal.throwIfAborted();
        bytes += chunk.byteLength;
        checkSize(bytes);
        const seconds = (performance.now() - startedAt) / 1000;
        report('正在读取 YouTube 音视频', bytes, total, seconds >= 1 ? bytes / seconds : undefined);
        if (pending && pending + chunk.byteLength > buffer.length) {
          await file.write(buffer.subarray(0, pending));
          pending = 0;
        }
        if (chunk.byteLength >= buffer.length) await file.write(chunk);
        else {
          buffer.set(chunk, pending);
          pending += chunk.byteLength;
        }
      }
      signal.throwIfAborted();
      if (pending) await file.write(buffer.subarray(0, pending));
      await file.close();
      return await handle.getFile();
    } catch (error) {
      await file.abort().catch(() => {});
      throw error;
    }
  }

  let tasks = [];
  try {
    checkSize(knownSize);
    signal.throwIfAborted();
    report('正在读取 YouTube 音视频', 0, total);
    const streams = reader.start({ videoFormat: video, audioFormat: audio, isPostLiveDvr: false, maxRetries: 2 });
    tasks = [stage('youtube-video', streams.videoStream), stage('youtube-audio', streams.audioStream)];
    const [videoFile, audioFile] = await Promise.all(tasks);
    if (failure) throw failure;
    return { video: { blob: videoFile }, audio: { blob: audioFile } };
  } catch (error) {
    await reader.abort().catch(() => {});
    await Promise.allSettled(tasks);
    if (failure && /403|proof.of.origin|expired/i.test(failure.message)) {
      throw new Error('YouTube 拒绝了当前播放地址。请刷新页面并播放正片后重试。');
    }
    const cause = failure ?? error;
    const reloadRequested = /streaming data reload requested/i.test(cause.message);
    if (!bytes && (reloadRequested || /sabr\.no_(?:video|audio)_selected/i.test(cause.message))) {
      throw Object.assign(new Error('YouTube 拒绝了当前画质的音视频组合。', { cause }), { retryFormat: true, reloadRequested });
    }
    throw failure ?? error;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
