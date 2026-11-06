import { build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';

// executeScript serializes the scanner function. Bundle its platform modules
// inside that function so it needs no extension globals in the page.
const scanner = await build({
  entryPoints: ['src/scan-page.js'],
  bundle: true,
  format: 'iife',
  globalName: 'pageScanner',
  target: 'chrome120',
  write: false,
});

await mkdir('dist', { recursive: true });
await build({
  entryPoints: ['src/background.js', 'src/popup.js', 'src/download.js', 'src/options.js'],
  outdir: 'dist',
  bundle: true,
  format: 'esm',
  target: 'chrome120',
  legalComments: 'linked',
  plugins: [{
    name: 'standalone-scanner',
    setup(build) {
      build.onLoad({ filter: /\/scan-page\.js$/ }, () => ({
        contents: 'export function scanPage(resourceSince, downloadPostId) {\n' +
          scanner.outputFiles[0].text + '\nreturn pageScanner.scanPage(resourceSince, downloadPostId);\n}',
        loader: 'js',
      }));
    },
  }],
});
for (const file of ['manifest.json', 'popup.html', 'download.html', 'options.html', 'style.css', 'player-events.js']) {
  await cp('src/' + file, 'dist/' + file);
}

await mkdir('dist/licenses', { recursive: true });
const dependencyLicenses = {
  'mediabunny': 'mediabunny/LICENSE',
  'googlevideo': 'googlevideo/LICENSE',
  'm3u8-parser': 'm3u8-parser/LICENSE',
  'mpd-parser': 'mpd-parser/LICENSE',
  'babel-runtime': '@babel/runtime/LICENSE',
  'videojs-vhs-utils': '@videojs/vhs-utils/LICENSE',
  'global': 'global/LICENSE',
  'min-document': 'min-document/LICENCE',
  'dom-walk': 'dom-walk/LICENCE',
  'process': 'process/LICENSE',
  'xmldom': '@xmldom/xmldom/LICENSE',
};
for (const [name, file] of Object.entries(dependencyLicenses)) {
  await cp('node_modules/' + file, 'dist/licenses/' + name + '.txt');
}
for (const file of ['bufbuild-protobuf-2.17.0.LICENSE.txt', 'bufbuild-protobuf-2.17.0.BSD.txt']) {
  await cp('third-party/' + file, 'dist/licenses/' + file);
}
await cp('THIRD_PARTY_NOTICES.md', 'dist/THIRD_PARTY_NOTICES.md');
