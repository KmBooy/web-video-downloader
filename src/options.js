import { getSettings, setSettings } from './settings-store.js';

const $ = id => document.getElementById(id);
$('browser-download-settings').addEventListener('click', () => {
  void chrome.tabs.create({ url: 'chrome://settings/downloads' });
});
$('browser-proxy-settings').addEventListener('click', () => {
  void chrome.tabs.create({ url: 'chrome://settings/system' });
});
function status(message) {
  $('settings-status').textContent = message;
}

function showLastDownload(path) {
  $('last-download-location').hidden = !path;
  $('last-download-path').textContent = path || '';
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes['last-download-directory']) {
    showLastDownload(changes['last-download-directory'].newValue);
  }
});

$('settings').addEventListener('submit', async event => {
  event.preventDefault();
  const maxHeight = Number($('max-height').value);
  const maxMiB = $('max-mib').valueAsNumber;
  if (!Number.isSafeInteger(maxMiB) || maxMiB < 0 || !Number.isSafeInteger(maxMiB * 1024 * 1024)) {
    status('文件大小上限请输入大于或等于 0 的整数。');
    return;
  }
  const button = $('save-settings');
  button.disabled = true;
  try {
    await setSettings({ maxHeight, maxMiB });
    status('下载选项已保存。');
  } catch (error) {
    status(error.message || '无法保存下载选项。');
  } finally {
    button.disabled = false;
  }
});

try {
  const settings = await getSettings();
  const recent = await chrome.storage.local.get('last-download-directory');
  showLastDownload(recent['last-download-directory']);
  $('max-height').value = String(settings.maxHeight);
  $('max-mib').value = String(settings.maxMiB);
  for (const id of ['max-height', 'max-mib', 'save-settings']) $(id).disabled = false;
} catch (error) {
  status(error.message);
}
