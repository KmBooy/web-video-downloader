import assert from 'node:assert/strict';
import { createHash, createPublicKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('keeps the same unpacked extension identity across releases and folders', async () => {
  const manifest = JSON.parse(await readFile(new URL('../src/manifest.json', import.meta.url), 'utf8'));
  const key = createPublicKey({ key: Buffer.from(manifest.key, 'base64'), format: 'der', type: 'spki' });
  const fingerprint = createHash('sha256').update(key.export({ format: 'der', type: 'spki' })).digest();
  const id = Array.from(fingerprint.subarray(0, 16), byte =>
    String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join('');
  assert.equal(id, 'igapbjjmkfpkjdfhgoamaceahhhgkkoe');
});
