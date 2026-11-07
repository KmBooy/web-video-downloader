import assert from 'node:assert/strict';
import test from 'node:test';
import { contextCandidate } from '../src/context-target.js';
import { installContextMenu } from '../src/context-menu.js';

test('right-click selects the exact X media ID among several visible or preloaded videos', () => {
  const first = { id: 'x:111', site: 'x' };
  const second = { id: 'x:222', site: 'x' };
  assert.equal(contextCandidate([first, second], { site: 'x', mediaId: '222' }), second);
  assert.throws(() => contextCandidate([first, second], { site: 'x', mediaId: '333' }), /未能确定/);
});

test('Instagram carousel selection requires an exact source or poster when several videos share the post', () => {
  const first = { id: 'instagram:code:1', files: [{ url: 'https://cdn.example/one.mp4' }], posterPaths: ['/one.jpg'] };
  const second = { id: 'instagram:code:2', files: [{ url: 'https://cdn.example/two.mp4' }], posterPaths: ['/two.jpg'] };
  const target = { site: 'instagram', code: 'code', src: 'blob:fixture', poster: 'https://cdn.example/two.jpg?signature=fixture' };
  assert.equal(contextCandidate([first, second], target), second);
  assert.equal(contextCandidate([first, second], { ...target, src: first.files[0].url }), first);
  assert.throws(() => contextCandidate([first, second], { ...target, poster: '' }), /未能确定/);
  assert.throws(() => contextCandidate([first], { ...target, code: 'other' }), /未能确定/);
});

test('the native menu sends the captured frame target into the existing download entry point', async t => {
  let click;
  let installed;
  let menu;
  let context = { page: 'https://x.com/home', site: 'x', mediaId: '222' };
  const feedback = [];
  const injected = [];
  const oldChrome = globalThis.chrome;
  t.after(() => { globalThis.chrome = oldChrome; });
  globalThis.chrome = {
    runtime: { onInstalled: { addListener: fn => { installed = fn; } } },
    contextMenus: {
      removeAll: done => done(),
      create: value => { menu = value; },
      onClicked: { addListener: fn => { click = fn; } },
    },
    tabs: {
      query: async () => [{ id: 7 }],
      async sendMessage(tabId, message, frame) {
        assert.equal(tabId, 7);
        assert.equal(frame.frameId, 2);
        if (message.type === 'get-video-context') return context ? { target: context } : { error: '视频已切换' };
        feedback.push(message.text);
      },
    },
    scripting: { executeScript: async options => { injected.push(options); } },
  };
  const starts = [];
  installContextMenu(async message => {
    starts.push(message);
    return { id: 'job', title: '选中的视频' };
  });
  installed();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(menu.title, '下载这个视频');
  assert.ok(menu.documentUrlPatterns.includes('https://www.instagram.com/*'));
  assert.equal(injected.length, 1);
  click({ menuItemId: menu.id, frameId: 2 }, { id: 7 });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(starts, [{ tabId: 7, contextTarget: context }]);
  assert.match(feedback[0], /已添加下载/);
  context = null;
  click({ menuItemId: menu.id, frameId: 2 }, { id: 7 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(starts.length, 1);
  assert.equal(feedback[1], '视频已切换');
});
