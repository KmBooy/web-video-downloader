import assert from 'node:assert/strict';
import test from 'node:test';
import { findInstagramMedia, instagramCode, instagramMediaId, instagramVideos, scanInstagram } from '../src/platforms/instagram.js';

const code = 'DfUMUQ0BZHP';
const movie = {
  code, pk: instagramMediaId(code), caption: { text: '测试视频标题' }, has_audio: true,
  video_versions: [{ url: 'https://scontent.example.cdninstagram.com/full.mp4?token=fixture', width: 720, height: 1280 }],
};

test('matches Instagram post, Reel and carousel URLs and converts the media ID without rounding', () => {
  for (const path of ['/p/', '/reel/', '/reels/', '/author/reel/']) {
    assert.equal(instagramCode('https://www.instagram.com' + path + code + '/?img_index=2'), code);
  }
  assert.equal(instagramCode('https://example.com/p/' + code), undefined);
  assert.equal(instagramCode('https://www.instagram.com/reels/audio/123'), undefined);
  assert.equal(instagramMediaId('B'), '1');
  assert.equal(instagramMediaId('BA'), '64');
  let value = BigInt(movie.pk);
  let encoded = '';
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  while (value) {
    encoded = alphabet[Number(value % 64n)] + encoded;
    value /= 64n;
  }
  assert.equal(encoded, code);
});

test('extracts only matching post metadata and keeps carousel videos separate from images', () => {
  const data = { require: [['payload', { __bbox: { result: {
    data: { feed: { edges: [{ node: { media: movie } }, { node: { media: { ...movie, code: 'other' } } }] } },
  } } }]] };
  assert.deepEqual([...findInstagramMedia(data, [code]).keys()], [code]);
  const [first, second] = instagramVideos({
    ...movie,
    carousel_media: [{ pk: '1', image_versions2: {} }, { ...movie, pk: '2' }, { ...movie, pk: '3', has_audio: false }],
  }, code, item => item);
  assert.equal(first.id, 'instagram:' + code + ':2');
  assert.equal(second.id, 'instagram:' + code + ':3');
  assert.notEqual(first.title, second.title);
  assert.equal(first.requiresAudio, true);
  assert.equal(second.requiresAudio, false);
  assert.equal(first.files[0].url, movie.video_versions[0].url);
  const onlyFragments = { ...movie, video_versions: [
    { url: 'blob:https://www.instagram.com/fixture' },
    { url: 'https://scontent.example.cdninstagram.com/part.mp4?bytestart=0&byteend=100' },
    { url: 'https://scontent.example.cdninstagram.com/part.mp4?byteend=100' },
  ] };
  assert.deepEqual(instagramVideos(onlyFragments, code, item => item), []);
});

test('refreshes the selected Instagram post using same-origin media metadata', async t => {
  const oldDocument = globalThis.document;
  t.after(() => { globalThis.document = oldDocument; });
  globalThis.document = { querySelectorAll: () => [{ textContent: JSON.stringify(movie) }] };
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push([url, init.credentials]);
    return { ok: true, json: async () => ({ items: [{
      ...movie, video_versions: [{ ...movie.video_versions[0], url: 'https://scontent.example.cdninstagram.com/refreshed.mp4' }],
    }] }) };
  });
  const result = {};
  await scanInstagram({
    url: new URL('https://www.instagram.com/p/' + code + '/'), players: [], result, clip: item => item, downloadPostId: code,
  });
  assert.deepEqual(requests, [['/api/v1/media/' + movie.pk + '/info/', 'include']]);
  assert.equal(result.instagramVideos.length, 1);
  assert.match(result.instagramVideos[0].files[0].url, /refreshed\.mp4$/);
});

test('an unrelated Instagram API response cannot supply media for the selected post', async t => {
  const oldDocument = globalThis.document;
  t.after(() => { globalThis.document = oldDocument; });
  globalThis.document = { querySelectorAll: () => [] };
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ items: [{ ...movie, code: 'other' }] }) }));
  const result = {};
  await scanInstagram({ url: new URL('https://www.instagram.com/reel/' + code + '/'), players: [], result, clip: item => item });
  assert.deepEqual(result.instagramVideos, []);
});
