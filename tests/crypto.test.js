import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveKey, encryptJSON, decryptJSON, randomBytes } from '../js/crypto.js';

test('encrypt/decrypt round trip; wrong passphrase fails', async () => {
  const salt = randomBytes(16);
  const key = await deriveKey('correct horse battery', salt, 1000);
  const enc = await encryptJSON(key, { a: 'שלום', n: [1, 2] });
  assert.ok(!enc.ct.includes('שלום'));
  assert.deepEqual(await decryptJSON(key, enc), { a: 'שלום', n: [1, 2] });
  const wrong = await deriveKey('wrong passphrase!!', salt, 1000);
  await assert.rejects(decryptJSON(wrong, enc));
});
