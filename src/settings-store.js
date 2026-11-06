const defaults = { maxHeight: 0, maxMiB: 0 };
const storeName = 'preferences';
const settingsKey = 'settings';

function openSettings() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('web-video-downloader', 1);
    request.onupgradeneeded = () => request.result.createObjectStore(storeName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function accessSettings(patch) {
  const db = await openSettings();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, patch ? 'readwrite' : 'readonly');
      const store = transaction.objectStore(storeName);
      const request = store.get(settingsKey);
      let settings;
      request.onsuccess = () => {
        const { maxHeight = defaults.maxHeight, maxMiB = defaults.maxMiB } = request.result ?? {};
        settings = { maxHeight, maxMiB, ...patch };
        if (patch) {
          try {
            store.put(settings, settingsKey);
          } catch (error) {
            transaction.abort();
            reject(error);
          }
        }
      };
      transaction.oncomplete = () => resolve(settings);
      transaction.onabort = () => reject(transaction.error ?? new Error('无法读取或保存下载设置。'));
    });
  } finally {
    db.close();
  }
}

export function getSettings() {
  return accessSettings();
}

export function setSettings(value) {
  return accessSettings(value);
}
