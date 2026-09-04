/**
 * transfer.js – Transfer history via SQLite (backed by main process)
 */

/* ── Load / Render ── */
async function loadTransferList() {
  const res = await window.r2Open.transfer.list({ limit: 200 });
  const all = res && res.ok ? res.items : [];
  // Filter to current bucket if one is selected
  const filtered = currentBucket ? all.filter((i) => i.bucket === currentBucket) : all;
  renderTransferList(filtered);
}

function renderTransferList(items) {
  const list = document.getElementById('transferList');
  const empty = document.getElementById('transferEmpty');
  if (!list) return;

  if (items.length === 0) {
    list.innerHTML = '';
    if (empty) empty.hidden = false;
    return;
  }
  if (empty) empty.hidden = true;

  list.innerHTML = items.map((item) => {
    const icon = item.type === 'upload' ? 'upload' : 'download';
    const typeClass = item.type === 'upload' ? 'transfer-upload' : 'transfer-download';
    const statusClass = item.status === 'success' ? 'transfer-success' : (item.status === 'failed' ? 'transfer-failed' : 'transfer-cancelled');
    const time = new Date(item.timestamp).toLocaleString();
    const size = item.size ? formatSize(item.size) : '—';
    const errorHtml = item.error ? `<div class="transfer-error">${escapeHtml(item.error)}</div>` : '';
    return `
      <div class="transfer-item ${typeClass} ${statusClass}">
        <span class="material-symbols-outlined transfer-icon">${icon}</span>
        <div class="transfer-info">
          <div class="transfer-key" title="${escapeHtml(item.key)}">${escapeHtml(item.key)}</div>
          <div class="transfer-meta">${time} · ${escapeHtml(item.bucket)} · ${size}</div>
          ${errorHtml}
        </div>
        <span class="transfer-status">${item.status === 'success' ? 'check' : (item.status === 'failed' ? 'close' : 'remove')}</span>
      </div>`;
  }).join('');
}

/* ── Clear ── */
async function clearTransfers() {
  await window.r2Open.transfer.clear();
  renderTransferList([]);
}

/* ── Open local folder for a transfer key ── */
async function openTransferLocalFolder(key, bucket) {
  if (!bucket) return;
  try {
    const bucketName = bucket.trim();
    const config = await window.r2Open.storage.loadBucketConfig(bucketName);
    const localRoot = config && config.ok !== false && config.config ? config.config.localPath : null;
    if (!localRoot) {
      showToast('No local folder configured for bucket: ' + bucketName, 'error');
      return;
    }
    const localPath = await window.r2Open.fsUtil.join([localRoot, key]);
    const folderPath = localPath.substring(0, Math.max(localPath.lastIndexOf('/'), localPath.lastIndexOf('\\')));
    await window.r2Open.fs.openExternal({ path: folderPath });
  } catch (err) {
    console.error('[openTransferLocalFolder]', err);
    showToast('Failed to open local folder: ' + (err && err.message || err), 'error');
  }
}

/* ── Init ── */
document.addEventListener('click', (e) => {
  if (e.target.closest('#transferClearAllBtn')) {
    clearTransfers();
  }
  const keyEl = e.target.closest('.transfer-key');
  if (keyEl) {
    const item = keyEl.closest('.transfer-item');
    if (item) {
      const key = keyEl.getAttribute('title') || keyEl.textContent;
      const bucketEl = item.querySelector('.transfer-meta');
      if (bucketEl) {
        const parts = bucketEl.textContent.split(' · ');
        const bucket = parts.length > 1 ? parts[1] : null;
        if (bucket) openTransferLocalFolder(key, bucket);
      }
    }
  }
});
