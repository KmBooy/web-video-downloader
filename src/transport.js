import { mediaUrl } from './media.js';

const idleMs = 30_000;
export const networkRetries = 2;

export class TemporaryMediaError extends Error {}
export class MediaReadError extends TemporaryMediaError {}

function retryPause(signal, delay) {
  return new Promise((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', cancel);
      resolve();
    }, delay);
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

async function withNetworkRetry(signal, operation) {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try { return await operation(); }
    catch (error) {
      signal?.throwIfAborted();
      if (!(error instanceof TemporaryMediaError) || attempt >= networkRetries) throw error;
      await retryPause(signal, 250 * 2 ** attempt);
    }
  }
}

async function waitForNetwork(operation, controller, signal, ErrorType) {
  const timer = setTimeout(() => controller.abort(new ErrorType('媒体请求长时间没有响应。')), idleMs);
  try { return await operation(); }
  catch (error) {
    signal.throwIfAborted();
    if (error instanceof TypeError) throw new ErrorType('媒体连接中断。', { cause: error });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function requestMedia(resource, init, signal) {
  const url = mediaUrl(resource instanceof Request ? resource.url : String(resource));
  if (!url) throw new Error('媒体地址无效。');
  const controller = new AbortController();
  const combined = AbortSignal.any([controller.signal, signal, init.signal,
    resource instanceof Request ? resource.signal : null].filter(Boolean));
  const response = await waitForNetwork(() => fetch(resource, {
    ...init, credentials: 'include', cache: 'no-store', redirect: 'manual',
    signal: combined,
  }), controller, combined, TemporaryMediaError);
  if (response.type === 'opaqueredirect') {
    throw new Error('媒体地址发生重定向。请在原网页继续播放后重新扫描。');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const code = response.status;
    const ErrorType = [500, 502, 503, 504].includes(code) ? TemporaryMediaError : Error;
    const error = new ErrorType([401, 403, 410].includes(code)
      ? '媒体地址已过期或站点拒绝访问（' + code + '）。回到网页播放后重新扫描。'
      : '下载媒体失败（HTTP ' + code + '）。');
    error.status = code;
    throw error;
  }
  if (response.headers.get('content-type')?.toLowerCase().includes('text/html')) {
    await response.body?.cancel().catch(() => {});
    throw new Error('站点返回了网页，请检查登录状态并重新扫描。');
  }
  if (!response.body) return response;
  const reader = response.body.getReader();
  const body = new ReadableStream({
    async pull(stream) {
      try {
        const { value, done } = await waitForNetwork(() => reader.read(), controller, combined, MediaReadError);
        if (done) {
          reader.releaseLock();
          stream.close();
        } else stream.enqueue(value);
      } catch (error) {
        reader.releaseLock();
        throw error;
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); }
      finally { reader.releaseLock(); }
    },
  }, { highWaterMark: 0 });
  const wrapped = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  return Object.defineProperties(wrapped, {
    url: { value: response.url }, type: { value: response.type }, redirected: { value: response.redirected },
  });
}

export function checkedFetch(resource, init = {}, signal) {
  const requestSignal = resource instanceof Request ? resource.signal : null;
  const combined = AbortSignal.any([signal, init.signal, requestSignal].filter(Boolean));
  return withNetworkRetry(combined, () => requestMedia(resource, init, combined));
}

async function readManifest(url, signal) {
  const response = await requestMedia(url, {}, signal);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return { text: text + decoder.decode(), url: response.url || url };
      size += value.byteLength;
      if (size > 2 * 1024 * 1024) throw new Error('媒体清单超过 2 MiB，无法安全解析。');
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function manifestText(url, signal) {
  return withNetworkRetry(signal, () => readManifest(url, signal));
}

export async function acceptsRanges(url, signal) {
  // Match the open-ended range that the media reader will actually request.
  const response = await checkedFetch(url, { headers: { Range: 'bytes=0-' } }, signal);
  try {
    return response.status === 206 && /^bytes 0-\d+\/\d+$/i.test(response.headers.get('content-range') ?? '');
  } finally {
    await response.body?.cancel().catch(() => {});
  }
}

function expectedLength(response, range) {
  const size = Number(response.headers.get('content-length')) || 0;
  if (range) {
    const expected = 'bytes ' + range.offset + '-' + (range.offset + range.length - 1) + '/';
    if (response.status !== 206 || !response.headers.get('content-range')?.startsWith(expected)) {
      throw new Error('媒体服务器未返回请求的完整区间。');
    }
    return range.length;
  }
  if (response.status === 206) {
    const match = response.headers.get('content-range')?.match(/^bytes 0-(\d+)\/(\d+)$/i);
    if (!match || Number(match[1]) + 1 !== Number(match[2])) {
      throw new Error('媒体服务器只返回了播放片段，无法保存成完整视频。');
    }
    return Number(match[2]);
  }
  return size;
}

export async function checkCompleteResponse(url, signal) {
  const response = await checkedFetch(url, {}, signal);
  try { expectedLength(response); }
  finally { await response.body?.cancel().catch(() => {}); }
}

async function writePart(part, writeAt, signal, progress) {
  const { range, url } = part;
  const headers = range ? { Range: 'bytes=' + range.offset + '-' + (range.offset + range.length - 1) } : undefined;
  const response = await requestMedia(url, { headers }, signal);
  let size = 0;
  const reader = response.body.getReader();
  try {
    const expected = expectedLength(response, range);
    progress(0, expected);
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      await writeAt(value, size);
      size += value.byteLength;
      progress(size, expected);
    }
    if (!size || (expected && size !== expected)) throw new MediaReadError('媒体数据不完整，未保存。');
    return size;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function copyPart(part, writeAt, signal, progress) {
  return withNetworkRetry(signal, () => writePart(part, writeAt, signal, progress));
}
