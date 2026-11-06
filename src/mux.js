import {
  BlobSource, EncodedAudioPacketSource, EncodedPacketSink, EncodedVideoPacketSource,
  HLS_FORMATS, HlsInputFormat, Input, MATROSKA, MP4, MpegTsInputFormat,
  MkvOutputFormat, Mp4OutputFormat, OGG, Output, StreamTarget, UrlSource, WEBM,
} from 'mediabunny';
import { acceptsRanges, checkedFetch, copyPart, MediaReadError, networkRetries } from './transport.js';

export function remoteInput(url, signal, hls = false, observeError = () => {}, hlsTimeline = false) {
  const fetchFn = async (input, init) => {
    try { return await checkedFetch(input, init, signal); }
    catch (error) { observeError(error); throw error; }
  };
  const readRetries = new Map();
  return new Input({
    source: new UrlSource(url, {
      maxCacheSize: 8 * 1024 * 1024, parallelism: 2,
      getRetryDelay(_attempts, error, resource) {
        if (signal.aborted || !(error instanceof MediaReadError)) return null;
        const key = resource instanceof Request ? resource.url : String(resource);
        const retries = readRetries.get(key) ?? 0;
        if (retries >= networkRetries) return null;
        readRetries.set(key, retries + 1);
        return 0.25 * 2 ** retries;
      },
      fetchFn, handleUnhandledError: observeError,
    }),
    formats: hls ? [
      new HlsInputFormat({ offsetTimestampsByDateTime: hlsTimeline }),
      ...HLS_FORMATS.filter(format => !(format instanceof HlsInputFormat)),
    ] : [MP4, WEBM, MATROSKA, OGG, new MpegTsInputFormat()],
  });
}

async function stageTrack(parts, scratch, name, signal, status, sequential) {
  const handle = await scratch.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    let offset = 0;
    for (const [index, part] of parts.entries()) {
      const label = sequential ? '正在下载' + (name === 'video' ? '视频轨' : '音频轨')
        : '正在获取分段 ' + (index + 1) + ' / ' + parts.length;
      status(label);
      offset += await copyPart(part,
        (data, position) => writable.write({ type: 'write', position: offset + position, data }),
        signal, (done, total) => {
          if (sequential && done > 0) status(label, done, total);
        });
    }
    await writable.truncate(offset);
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  }
  return new Input({ source: new BlobSource(await handle.getFile()), formats: [MP4] });
}

function containerFor(videoCodec, audioCodec) {
  const mp4 = new Mp4OutputFormat({ fastStart: false });
  return mp4.getSupportedVideoCodecs().includes(videoCodec) && (!audioCodec || mp4.getSupportedAudioCodecs().includes(audioCodec))
    ? { format: mp4, extension: 'mp4' }
    : { format: new MkvOutputFormat(), extension: 'mkv' };
}

export async function prepareMux(choice, signal, status, scratchId, maxHeight) {
  const inputs = [];
  const failures = [];
  let root;
  let dir;
  const rememberError = error => {
    if (!signal.aborted && error?.name !== 'AbortError' && !failures.length) failures.push(error);
  };
  async function dispose() {
    inputs.forEach(input => input.dispose());
    if (dir) await root.removeEntry(dir, { recursive: true }).catch(() => {});
  }
  async function inputFor(spec, name) {
    if (!spec) return null;
    signal.throwIfAborted();
    let input;
    const sequential = choice.stageWithoutRanges && !spec.segments && !await acceptsRanges(spec.url, signal);
    if (spec.blob) {
      input = new Input({ source: new BlobSource(spec.blob), formats: [MP4, WEBM, MATROSKA] });
    } else if (spec.segments || sequential) {
      root ??= await navigator.storage.getDirectory();
      if (!dir) {
        dir = 'media-' + scratchId;
        await root.removeEntry(dir, { recursive: true }).catch(() => {});
      }
      const scratch = await root.getDirectoryHandle(dir, { create: true });
      input = await stageTrack(spec.segments ?? [{ url: spec.url }], scratch, name, signal, status, sequential);
    } else {
      input = remoteInput(spec.url, signal, choice.hls, rememberError, choice.hlsTimeline);
    }
    inputs.push(input);
    return input;
  }

  try {
    const videoInput = await inputFor(choice.video, 'video');
    const audioInput = await inputFor(choice.audio, 'audio');
    const video = await videoInput.getPrimaryVideoTrack();
    const audio = await (audioInput ?? videoInput).getPrimaryAudioTrack();
    if (!video || (!audio && (!choice.videoOnly || audioInput))) throw new Error('媒体缺少完整的视频轨或音轨。');
    if (maxHeight && Math.min(await video.getDisplayWidth(), await video.getDisplayHeight()) > maxHeight) {
      throw new Error('视频画质超出 ' + maxHeight + 'p 上限。');
    }
    const [videoCodec, audioCodec, videoConfig, audioConfig, videoStart, audioStart] = await Promise.all([
      video.getCodec(), audio?.getCodec(), video.getDecoderConfig(), audio?.getDecoderConfig(),
      video.getFirstTimestamp(), audio?.getFirstTimestamp(),
    ]);
    if (!videoCodec || !videoConfig || (audio && (!audioCodec || !audioConfig))) {
      throw new Error('无法读取当前媒体的编码信息。');
    }
    if (failures.length) throw failures[0];
    if (choice.duration && !choice.hls && !choice.video.segments && choice.audio?.url) {
      const lengths = await Promise.all([video.getDurationFromMetadata(), audio.getDurationFromMetadata()]);
      if (lengths.some(length => length != null && Math.abs(length - choice.duration) > Math.max(3, choice.duration * 0.01))) {
        throw new Error('候选音视频时长与当前回放不匹配，请播放后重新扫描。');
      }
    }
    const { format, extension } = containerFor(videoCodec, audioCodec);
    if (!format.getSupportedVideoCodecs().includes(videoCodec)
        || (audio && !format.getSupportedAudioCodecs().includes(audioCodec))) {
      throw new Error('当前版本无法封装这组音视频编码。');
    }
    const offset = audio ? Math.min(videoStart, audioStart) : videoStart;
    return {
      extension, dispose, hasAudio: Boolean(audio),
      async write(writable) {
        // Mediabunny can finalize its stream independently. The actual file is
        // committed only after all expected tracks and the advertised duration pass.
        const stream = new WritableStream({ write: chunk => writable.write(chunk) });
        const output = new Output({ format, target: new StreamTarget(stream, { chunked: true, chunkSize: 1024 * 1024 }) });
        const videoSource = new EncodedVideoPacketSource(videoCodec);
        output.addVideoTrack(videoSource);
        const audioSource = audio && new EncodedAudioPacketSource(audioCodec);
        if (audioSource) output.addAudioTrack(audioSource);
        await output.start();
        const message = choice.video.blob ? '正在合并音视频' : audio ? '正在保存音视频' : '正在保存视频';
        const transfer = async (track, target, decoderConfig, isVideo) => {
          let count = 0;
          let end = 0;
          for await (const packet of new EncodedPacketSink(track).packets()) {
            signal.throwIfAborted();
            const timestamp = packet.timestamp - offset;
            const chunk = offset ? packet.clone({ timestamp }) : packet;
            await target.add(chunk, count === 0 ? { decoderConfig } : undefined);
            end = Math.max(end, timestamp + packet.duration);
            count++;
            if (isVideo && count % 60 === 0) status(message, end, choice.duration);
          }
          target.close();
          if (!count) throw new Error('媒体轨没有可用数据。');
          return end;
        };
        const tasks = [transfer(video, videoSource, videoConfig, true)];
        if (audioSource) tasks.push(transfer(audio, audioSource, audioConfig, false));
        try {
          const ends = await Promise.all(tasks);
          signal.throwIfAborted();
          if (failures.length) throw failures[0];
          if (choice.duration && Math.min(...ends) + Math.max(2, choice.duration * 0.02) < choice.duration) {
            throw new Error((audioSource ? '音频或视频' : '视频') + '短于清单标注时长，未保存不完整文件。');
          }
          if (audioSource && Math.abs(ends[0] - ends[1]) > Math.max(3, Math.max(...ends) * 0.02)) {
            throw new Error('音视频时长不匹配，未保存不完整文件。');
          }
          await output.finalize();
          signal.throwIfAborted();
        } catch (error) {
          inputs.forEach(input => input.dispose());
          await output.cancel().catch(() => {});
          await Promise.allSettled(tasks);
          throw failures[0] ?? error;
        }
      },
    };
  } catch (error) {
    await dispose();
    throw failures[0] ?? error;
  }
}
