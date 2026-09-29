// Encrypted vault stored in the browser's IndexedDB.
// Only ciphertext is persisted; plaintext data lives in memory while unlocked.

import { deriveKey, encryptJSON, decryptJSON, randomBytes, toB64, fromB64, PBKDF2_ITERATIONS } from './crypto.js';

const DB_NAME = 'family-budget';
const STORE = 'vault';
const RECORD_KEY = 'main';
const VAULT_FORMAT = 'family-budget-vault';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await openDB();
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req && req.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally {
    db.close();
  }
}

export const readRecord = () => tx('readonly', s => s.get(RECORD_KEY));
const writeRecord = rec => tx('readwrite', s => s.put(rec, RECORD_KEY));
export const deleteRecord = () => tx('readwrite', s => s.delete(RECORD_KEY));

export function emptyData() {
  return { version: 1, transactions: [], rules: null, imports: [], settings: { autoLockMinutes: 15 } };
}

export async function hasVault() {
  return !!(await readRecord());
}

export async function createVault(passphrase, data = emptyData()) {
  const salt = randomBytes(16);
  const key = await deriveKey(passphrase, salt);
  const session = { key, salt: toB64(salt), iterations: PBKDF2_ITERATIONS };
  await saveVault(session, data);
  return session;
}

export async function unlockVault(passphrase, record) {
  const rec = record || await readRecord();
  if (!rec) throw new Error('no-vault');
  const key = await deriveKey(passphrase, fromB64(rec.salt), rec.iterations);
  let data;
  try {
    data = await decryptJSON(key, rec);
  } catch {
    throw new Error('bad-passphrase');
  }
  return { session: { key, salt: rec.salt, iterations: rec.iterations }, data };
}

export async function saveVault(session, data) {
  const enc = await encryptJSON(session.key, data);
  await writeRecord({
    format: VAULT_FORMAT, v: 1,
    salt: session.salt, iterations: session.iterations,
    ...enc, savedAt: new Date().toISOString(),
  });
}

export function isVaultRecord(obj) {
  return !!obj && obj.format === VAULT_FORMAT && typeof obj.salt === 'string'
    && typeof obj.iv === 'string' && typeof obj.ct === 'string' && Number.isInteger(obj.iterations);
}

// Replace the stored vault with an (already encrypted) backup record.
export async function restoreRecord(rec) {
  if (!isVaultRecord(rec)) throw new Error('bad-backup');
  await writeRecord(rec);
}
