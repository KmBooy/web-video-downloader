import assert from 'node:assert/strict';
import test from 'node:test';
import { douyinDownload, refreshDouyinFiles, scanDouyin } from '../src/platforms/douyin.js';

const cdn = 'https://v26-web.douyinvod.com/sign/expires/video/tos/cn/';
const video = cdn + 'v/media-video-avc1/?mime_type=video_mp4&br=1160';
const audio = cdn + 'a/media-audio-und-mp4a/?mime_type=video_mp4&br=127';
const complete = cdn + 'complete/?mime_type=video_mp4&br=840';

function scan(path, entries, since = 0, currentSrc = 'blob:https://www.douyin.com/demo', players = [], height = 720) {
  const result = {};
  scanDouyin({
    url: new URL(path, 'https://www.douyin.com'),
    resourceSince: since,
    players,
    videos: [{ url: currentSrc, height, duration: 7336 }],
    recent: entries.filter(([, time]) => 100 + time >= since)
      .map(([name]) => ({ name, contentType: 'video/mp4' })),
    result,
  });
  return result;
}

test('pairs the two distinct Douyin replay tracks without turning a preview into the replay', async () => {
  const result = await scan('/vsdetail/123', [[video, 3], [audio, 4], [complete, 5]]);
  assert.equal(result.site, 'douyin-replay');
  assert.equal(result.variants[0].url, video);
  assert.equal(result.audio[0].url, audio);
  assert.equal(result.duration, 7336);
  assert.equal(result.files, undefined);
});

test('ignores old replay tracks after a same-document switch', async () => {
  const result = await scan('/vsdetail/456', [[video, 2], [audio, 10]], 105);
  assert.equal(result.variants, undefined);
  assert.match(result.hint, /再扫描/);
});

function replayPlayer(episodeId, withAudio = true) {
  return { parentElement: {
    '__reactFiber$test': { return: { memoizedProps: { awemeInfo: {
      episodeId,
      dashOpts: { dynamic_video: {
        dynamic_video_list: [{ main_url: video.replace('/v/', '/selected-v/'), vwidth: 720, vheight: 1280, bitrate: 2000000 }],
        dynamic_audio_list: withAudio ? [{ main_url: audio.replace('/a/', '/selected-a/'), avg_bitrate: 129000 }] : [],
      } },
    } } } },
  } };
}

test('reads tracks bound to the current replay even when resource timings were lost', () => {
  const result = scan('/vsdetail/456', [], 105, undefined, [replayPlayer('456')], 1280);
  assert.equal(result.site, 'douyin-replay');
  assert.deepEqual(result.variants, [{ url: video.replace('/v/', '/selected-v/'), height: 720, bitrate: 2000000 }]);
  assert.equal(result.audio[0].url, audio.replace('/a/', '/selected-a/'));
  assert.equal(result.duration, 7336);
});

test('the selected replay player takes precedence over another replay in resource timings', () => {
  const result = scan('/vsdetail/456', [[video, 10], [audio, 11]], 105, undefined,
    [replayPlayer('123'), replayPlayer('456')]);
  assert.equal(result.variants[0].url, video.replace('/v/', '/selected-v/'));
  assert.equal(result.audio[0].url, audio.replace('/a/', '/selected-a/'));
});

test('a previous replay player cannot supply tracks after switching the page ID', () => {
  const result = scan('/vsdetail/456', [[video, 1], [audio, 2]], 105, undefined, [replayPlayer('123')]);
  assert.equal(result.variants, undefined);
  assert.equal(result.audio, undefined);
});

test('does not fill a missing current replay audio track from another replay', () => {
  const result = scan('/vsdetail/456', [[video, 10], [audio, 11]], 105, undefined, [replayPlayer('456', false)]);
  assert.equal(result.variants, undefined);
  assert.equal(result.audio, undefined);
  assert.match(result.hint, /再扫描/);
});

test('normal Douyin detail keeps only the complete file as a direct candidate', async () => {
  const result = await scan('/video/123', [[video, 2], [audio, 3], [complete, 4]]);
  assert.equal(result.site, 'douyin-video');
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].url, complete);
  assert.equal(result.variants, undefined);
});

test('reads the native player direct URL before a network timing entry exists', async () => {
  const result = await scan('/video/123', [], 0, complete);
  assert.equal(result.files[0].url, complete);
});

test('accepts a native player URL after an in-page switch only when its video ID matches', async () => {
  const next = complete + '&__vid=456';
  const current = await scan('/video/456', [], 105, next);
  const stale = await scan('/video/123', [], 105, next);
  assert.equal(current.files[0].url, next);
  assert.equal(stale.files, undefined);
});

function feedPlayer(activeId) {
  const selected = {
    awemeId: '456', itemTitle: '当前精选视频',
    video: {
      width: 1080, height: 1920, playAddrSize: 100,
      playAddr: [{ src: complete }],
      bitRateList: [{ width: 1080, height: 1920, bitRate: 840000, dataSize: 100,
        playAddr: [{ src: video }, { src: complete }] }],
    },
  };
  const container = {
    className: 'sliderVideo video_' + activeId,
    '__reactFiber$test': {
      memoizedProps: { item: { awemeId: '123', video: { playAddr: [{ src: audio }] } } },
      return: { memoizedProps: { slideData: selected } },
    },
  };
  return { closest: () => container };
}

test('finds the selected feed video through its playback data when the player uses a blob', () => {
  for (const path of ['/jingxuan?modal_id=456', '/jingxuan']) {
    const result = scan(path, [], 105, undefined, [feedPlayer('456')]);
    assert.equal(result.douyinPost, '456');
    assert.equal(result.title, '当前精选视频');
    assert.deepEqual(result.files, [{ url: complete, height: 1080, bitrate: 840000, bytes: 100 }]);
  }
});

test('does not show the previous feed video while the URL and active slide disagree', () => {
  const result = scan('/jingxuan?modal_id=123', [[complete, 10]], 105, undefined, [feedPlayer('456')]);
  assert.equal(result.douyinPost, undefined);
  assert.equal(result.files, undefined);
});

test('limits the Douyin referrer fallback to HTTPS media on recognized CDNs', () => {
  assert.equal(douyinDownload.accepts(complete), true);
  assert.equal(douyinDownload.accepts(complete.replace('https:', 'http:')), false);
  assert.equal(douyinDownload.accepts(complete.replace('douyinvod.com', 'douyinvod.com.example')), false);
  assert.equal(douyinDownload.accepts('https://v26-web.douyinvod.com/other.mp4'), false);
});

test('refreshes the clicked post from the page API and keeps same-rendition CDN mirrors', async t => {
  const expired = complete + '&expire=1';
  const primary = complete.replace('complete/', 'fresh/');
  const mirror = primary.replace('v26-web', 'v11-weba');
  const address = { width: 1920, height: 1080, data_size: 100, url_list: [expired, video, primary, mirror] };
  const fetch = t.mock.method(globalThis, 'fetch', async path => {
    assert.equal(new URL(path, 'https://www.douyin.com').searchParams.get('aweme_id'), '456');
    assert.equal(path.split('?')[0], '/aweme/v1/web/aweme/detail');
    return Response.json({ aweme_detail: { aweme_id: '456', item_title: '当前作品',
      video: { bit_rate: [{ format: 'mp4', bit_rate: 900000, play_addr: address }] } } });
  });
  const result = { douyinPost: '456', files: [{ url: expired }] };
  const page = new URL('https://www.douyin.com/jingxuan?modal_id=456');
  await refreshDouyinFiles(result, '123', page);
  assert.equal(fetch.mock.callCount(), 0);
  await refreshDouyinFiles(result, '456', page);
  assert.equal(result.title, '当前作品');
  assert.deepEqual(result.files, [{ url: primary, mirrors: [mirror], height: 1080, bitrate: 900000, bytes: 100 }]);
});
