import assert from 'node:assert/strict';
import test from 'node:test';
import { checkedFetch, copyPart, MediaReadError } from '../src/transport.js';

const url = 'https://video.example/part.mp4';

test('retries a broken part at its original offset', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    if (++requests > 1) return new Response(Uint8Array.of(1, 2, 3));
    let started = false;
    return new Response(new ReadableStream({
      pull(stream) {
        if (started) stream.error(new TypeError('connection closed'));
        else {
          started = true;
          stream.enqueue(Uint8Array.of(9, 9));
        }
      },
    }, { highWaterMark: 0 }), { headers: { 'Content-Length': '3' } });
  });
  const writes = [];
  const result = new Uint8Array(3);
  const size = await copyPart({ url }, (bytes, offset) => {
    writes.push(offset);
    result.set(bytes, offset);
  }, new AbortController().signal, () => {});
  assert.deepEqual(writes, [0, 0]);
  assert.deepEqual([...result], [1, 2, 3]);
  assert.equal(size, 3);
});

test('does not retry a 403 response', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 403 }));
  await assert.rejects(checkedFetch(url), { status: 403, message: /403/ });
  assert.equal(fetch.mock.callCount(), 1);
});

test('aborts an idle response body while it is being read', async t => {
  const setTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => setTimeout(callback, delay === 30_000 ? 5 : delay));
  const fetch = t.mock.method(globalThis, 'fetch', async (_url, { signal }) => new Response(new ReadableStream({
    start(stream) {
      signal.addEventListener('abort', () => stream.error(signal.reason), { once: true });
    },
  })));
  const response = await checkedFetch(url);
  await assert.rejects(response.body.getReader().read(), MediaReadError);
  assert.equal(fetch.mock.callCount(), 1);
});
