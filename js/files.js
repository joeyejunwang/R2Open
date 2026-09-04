/**
 * files.js – Files panel: list, browse, select, download, delete
 */

/* ── Reusable bulk-actions button group HTML ── */
function buildBulkActionsHtml() {
  return `
    <button class="file-action-btn file-action-bulk-move" id="bulkMoveBtn" disabled title="Move selected files remotely"><span class="material-symbols-outlined btn-icon">arrow_forward</span><span class="btn-count" id="moveCount">0</span></button>
    <button class="file-action-btn file-action-bulk-delete" id="bulkDeleteBtn" disabled title="Delete selected files remotely"><span class="material-symbols-outlined btn-icon">close</span><span class="btn-count" id="deleteCount">0</span></button>
    <button class="file-action-btn file-action-bulk-download" id="bulkDownloadBtn" disabled title="Download selected files to local disk"><span class="material-symbols-outlined btn-icon">download</span><span class="btn-count" id="downloadCount">0</span></button>
    <button class="file-action-btn file-action-bulk-upload-files" id="bulkUploadFilesBtn" title="Upload files remotely"><span class="material-symbols-outlined btn-icon">upload</span></button>
    <button class="file-action-btn file-action-bulk-upload-folders" id="bulkUploadFoldersBtn" title="Upload folders remotely"><span class="material-symbols-outlined btn-icon">folder_open</span></button>
  `;
}

/* ── Pagination state ── */
let currentContinuationToken = null;
let currentIsTruncated = false;
let currentLoading = false;
let currentLoadingKey = '';
let totalLoadedCount = 0;
let loadFilesSeq = 0;

/* ── Load files ── */
async function loadFiles({ reset = true } = {}) {
  if (!currentBucket) return;
  const table = document.getElementById('filesTable');
  if (!table) return;

  const mySeq = ++loadFilesSeq;
  const requestedBucket = currentBucket;
  const requestedPrefix = currentPrefix;

  const guardKey = `${currentBucket}::${currentPrefix}`;
  if (currentLoading && currentLoadingKey === guardKey) return;

  currentLoading = true;
  currentLoadingKey = guardKey;

  try {
    if (reset) {
      filesCache = [];
      currentContinuationToken = null;
      currentIsTruncated = false;
      totalLoadedCount = 0;
      table.innerHTML = `
        <div class="files-row files-row-header">
          <span class="files-row-check"><input type="checkbox" id="selectAllFiles" title="Select all"></span>
          <span class="files-row-icon"></span>
          <span class="files-row-name">Name</span>
          <span class="files-row-meta">Size</span>
          <span class="files-row-date">Modified</span>
          <span class="files-row-actions">
            ${buildBulkActionsHtml()}
          </span>
        </div>
        <div class="files-list-body" id="filesListBody"></div>
        <div class="files-list-footer" id="filesListFooter"></div>`;
      renderBreadcrumbs();
    }

    setFooter(reset ? 'Loading…' : 'Loading more…');

    const body = document.getElementById('filesListBody');
    if (reset && body) {
      body.innerHTML = `
        <div class="files-row files-loading-row">
          <span class="files-row-icon">↻</span>
          <span class="files-row-name files-loading-text">Loading…</span>
          <span class="files-row-meta">—</span>
          <span class="files-row-date">—</span>
          <span class="files-row-actions"></span>
        </div>`;
    }

    let result;
    try {
      result = await window.r2Open.r2.listObjects({
        bucket: requestedBucket,
        prefix: requestedPrefix,
        maxKeys: 1000,
        continuationToken: currentContinuationToken,
      });
    } catch (err) {
      console.error('[renderer] listObjects IPC failed:', err);
      if (mySeq !== loadFilesSeq) return;
      table.innerHTML = `<div class="files-error">Failed to list objects: ${escapeHtml(err && err.message || 'Network error')}</div>`;
      setFooter(`<span class="files-error-text">${escapeHtml(err && err.message || 'Network error')}</span>`);
      return;
    }

    if (mySeq !== loadFilesSeq) return;
    if (requestedBucket !== currentBucket || requestedPrefix !== currentPrefix) return;

    if (!result || result.ok !== true) {
      const msg = (result && result.error) || 'Unknown error';
      const body2 = document.getElementById('filesListBody');
      if (body2) {
        const staleLoading = body2.querySelector('.files-loading-row');
        if (staleLoading) staleLoading.remove();
        if (!body2.querySelector('.files-row')) {
          body2.innerHTML = `<div class="files-empty"><div class="files-empty-title">Couldn&rsquo;t load objects</div><div class="files-empty-sub">${escapeHtml(msg)}</div></div>`;
        }
      }
      setFooter(`<span class="files-error-text">${escapeHtml(msg)}</span>`);
      if (typeof showToast === 'function') showToast(`R2 error: ${msg}`, 'error');
      return;
    }

    const newRows = [];
    for (const p of result.commonPrefixes || []) {
      newRows.push({ kind: 'folder', key: p, prefix: p });
    }
    for (const o of result.objects || []) {
      if (o.key && o.key.endsWith('/') && o.size === 0) continue;
      newRows.push({ kind: 'file', key: o.key, size: o.size, lastModified: o.lastModified, etag: o.etag });
    }
    filesCache = filesCache.concat(newRows);
    totalLoadedCount = filesCache.length;

    currentContinuationToken = result.nextContinuationToken || null;
    currentIsTruncated = !!result.isTruncated;

    appendFileRows(newRows);
    renderBreadcrumbs();
    updateFooter();
    bindSelectAll();
    bindFilesTableDropzone();
  } finally {
    currentLoading = false;
  }
}

function setFooter(html) {
  const footer = document.getElementById('filesListFooter');
  if (footer) footer.innerHTML = html;
}

function updateFooter() {
  const footer = document.getElementById('filesListFooter');
  if (!footer) return;
  const more = currentIsTruncated && currentContinuationToken;
  footer.innerHTML = `
    <div class="files-list-count">${totalLoadedCount} item${totalLoadedCount === 1 ? '' : 's'} loaded${more ? ' (more available)' : ''}</div>
    ${more ? '<button class="file-action-btn files-load-more-btn" id="loadMoreBtn"><span class="material-symbols-outlined btn-icon">download</span> Load more</button>' : ''}
  `;
  const btn = document.getElementById('loadMoreBtn');
  if (btn) btn.addEventListener('click', () => loadFiles({ reset: false }));
}

/* ── Selection ── */
function syncBulkButtons() {
  const n = selectedKeys.size;
  const isPlural = n === 1 ? '' : 's';

  const actions = [
    { id: 'bulkMoveBtn', countId: 'moveCount', actionText: 'Move', defaultTitle: 'Move selected files remotely', titleSuffix: 'remotely' },
    { id: 'bulkDeleteBtn', countId: 'deleteCount', actionText: 'Delete', defaultTitle: 'Delete selected files remotely', titleSuffix: 'remotely' },
    { id: 'bulkDownloadBtn', countId: 'downloadCount', actionText: 'Download', defaultTitle: 'Download selected files to local disk', titleSuffix: 'to local disk' }
  ];

  actions.forEach(({ id, countId, actionText, defaultTitle, titleSuffix }) => {
    const btn = document.getElementById(id);
    const countEl = document.getElementById(countId);
    if (!btn) return;
    btn.disabled = n === 0;
    if (countEl) countEl.textContent = n;
    const dynamicLabel = `${actionText} ${n} selected file${isPlural}`;
    btn.setAttribute('aria-label', n === 0 ? `${actionText} selected files` : dynamicLabel);
    btn.setAttribute('title', n === 0 ? defaultTitle : `${dynamicLabel} ${titleSuffix}`);
  });
}

function applyCheckboxState(key, checked) {
  const cb = document.querySelector(`.files-checkbox[data-key="${CSS.escape(key)}"]`);
  if (cb) cb.classList.toggle('checked', checked);
}

function toggleSelect(key, checked, mode) {
  if (mode === 'toggle') {
    if (selectedKeys.has(key)) selectedKeys.delete(key);
    else selectedKeys.add(key);
    applyCheckboxState(key, selectedKeys.has(key));
  } else if (mode === 'all') {
    if (checked) {
      filesCache.forEach((r) => selectedKeys.add(r.key));
    } else {
      selectedKeys.clear();
    }
    document.querySelectorAll('.files-checkbox').forEach((cb) => {
      cb.classList.toggle('checked', checked);
    });
  }
  syncBulkButtons();
}

function bindSelectAll() {
  const selectAll = document.getElementById('selectAllFiles');
  if (selectAll) {
    selectAll.onchange = () => toggleSelect(null, selectAll.checked, 'all');
  }
  const actionHandlers = [
    { id: 'bulkDownloadBtn', handler: handleBulkDownload },
    { id: 'bulkMoveBtn', handler: handleBulkMove },
    { id: 'bulkDeleteBtn', handler: handleBulkDelete },
    { id: 'bulkUploadFilesBtn', handler: () => typeof handleBrowseFiles === 'function' && handleBrowseFiles() },
    { id: 'bulkUploadFoldersBtn', handler: () => typeof handleBrowseFolders === 'function' && handleBrowseFolders() }
  ];
  actionHandlers.forEach(({ id, handler }) => {
    const btn = document.getElementById(id);
    if (btn) btn.onclick = handler;
  });
}

/* ── Build rows HTML ── */
function buildRowsHtml(rows) {
  const folders = rows.filter((r) => r.kind === 'folder');
  const files = rows.filter((r) => r.kind === 'file');

  const folderHtml = folders.map((r) => `
    <div class="files-row files-row-folder" data-key="${escapeHtml(r.key)}">
      <span class="files-row-check"><span class="files-checkbox${selectedKeys.has(r.key) ? ' checked' : ''}" data-key="${escapeHtml(r.key)}"></span></span>
      <span class="files-row-icon">📁</span>
      <span class="files-row-name">${escapeHtml(r.key.slice(currentPrefix.length))}</span>
      <span class="files-row-meta">—</span>
      <span class="files-row-date">—</span>
      <span class="files-row-actions">
        <span class="local-indicator" data-key="${escapeHtml(r.key)}" title="Checking local…">…</span>
        <button class="file-action-btn file-action-moving" data-key="${escapeHtml(r.key)}" data-kind="folder" title="Move remotely"><span class="material-symbols-outlined btn-icon">arrow_forward</span></button>
        <button class="file-action-btn file-action-delete" data-key="${escapeHtml(r.key)}" data-kind="folder" title="Delete remotely"><span class="material-symbols-outlined btn-icon">close</span></button>
        <button class="file-action-btn file-action-download" data-key="${escapeHtml(r.key)}" data-kind="folder" title="Download folder to local disk"><span class="material-symbols-outlined btn-icon">download</span></button>
      </span>
    </div>`).join('');

  const fileHtml = files.map((r) => `
    <div class="files-row" data-key="${escapeHtml(r.key)}" data-size="${r.size}" data-modified="${r.lastModified || ''}">
      <span class="files-row-check"><span class="files-checkbox${selectedKeys.has(r.key) ? ' checked' : ''}" data-key="${escapeHtml(r.key)}"></span></span>
      <span class="files-row-icon">📄</span>
      <span class="files-row-name" title="${escapeHtml(r.key)}">${escapeHtml(r.key.slice(currentPrefix.length))}</span>
      <span class="files-row-meta">${formatSize(r.size)}</span>
      <span class="files-row-date">${r.lastModified ? new Date(r.lastModified).toLocaleString() : '—'}</span>
      <span class="files-row-actions">
        <span class="local-indicator" data-key="${escapeHtml(r.key)}" title="Checking local…">…</span>
        <button class="file-action-btn file-action-moving" data-key="${escapeHtml(r.key)}" title="Move remotely"><span class="material-symbols-outlined btn-icon">arrow_forward</span></button>
        <button class="file-action-btn file-action-delete" data-key="${escapeHtml(r.key)}" title="Delete remotely"><span class="material-symbols-outlined btn-icon">close</span></button>
        <button class="file-action-btn file-action-download" data-key="${escapeHtml(r.key)}" title="Download to local disk"><span class="material-symbols-outlined btn-icon">download</span></button>
      </span>
    </div>`).join('');

  return folderHtml + fileHtml;
}

function appendFileRows(rows) {
  let body = document.getElementById('filesListBody');
  if (!body) return;

  const loading = body.querySelector('.files-loading-row');
  if (loading) loading.remove();

  if (rows.length === 0 && !body.querySelector('.files-row')) {
    body.innerHTML = `
      <div class="files-empty">
        <div class="files-empty-title">${currentPrefix ? 'Empty folder' : 'This bucket is empty'}</div>
        <div class="files-empty-sub">Drop files in the Upload tab to add some.</div>
      </div>`;
    return;
  }

  const empty = body.querySelector('.files-empty');
  if (empty) empty.remove();

  body.insertAdjacentHTML('beforeend', buildRowsHtml(rows));
  bindRowEventsOn(body);
  void bindFileRowActions();
}

/* ── Row events ── */
function bindRowEventsOn(scope) {
  scope.querySelectorAll('.files-row-folder').forEach((row) => {
    row.addEventListener('click', (evt) => {
      if (evt.target.closest('.files-checkbox')) return;
      if (evt.target.closest('.file-action-btn')) return;
      if (evt.target.closest('.local-indicator')) return;
      const key = row.getAttribute('data-key');
      if (!key) return;
      currentPrefix = key;
      loadFiles();
      syncUploadPrefix();
    });
  });

  scope.querySelectorAll('.files-row:not(.files-row-folder) .files-row-name').forEach((el) => {
    el.style.cursor = 'pointer';
    el.addEventListener('click', (evt) => {
      evt.stopPropagation();
      const row = el.closest('.files-row');
      const key = row && row.getAttribute('data-key');
      if (key) previewFile(key, row);
    });
  });

  scope.querySelectorAll('.files-checkbox').forEach((cb) => {
    cb.addEventListener('click', (evt) => {
      evt.stopPropagation();
      const key = cb.getAttribute('data-key');
      toggleSelect(key, false, 'toggle');
    });
  });

  scope.querySelectorAll('.file-action-moving').forEach((btn) => {
    btn.addEventListener('click', (evt) => {
      evt.stopPropagation();
      const key = btn.getAttribute('data-key');
      if (!key || !currentBucket) return;
      handleSingleMoving(key, btn.closest('.files-row'));
    });
  });

  scope.querySelectorAll('.file-action-delete').forEach((btn) => {
    btn.addEventListener('click', (evt) => {
      evt.stopPropagation();
      const key = btn.getAttribute('data-key');
      if (!key || !currentBucket) return;
      handleSingleDelete(key, btn.closest('.files-row'));
    });
  });

  scope.querySelectorAll('.file-action-download').forEach((btn) => {
    btn.addEventListener('click', (evt) => {
      evt.stopPropagation();
      const key = btn.getAttribute('data-key');
      if (!key || !currentBucket) return;
      handleSingleDownload(key, btn.closest('.files-row'));
    });
  });
}

/* ── Single file actions ── */
async function handleSingleMoving(key, row) {
  if (!row) return;
  if (!document.contains(row)) return;
  setRowBusy(row, true);
  showToast('Preparing to move...', 'info');
  await ensureMovingReady();
  // Add the single key to selectedKeys for moving
  selectedKeys.clear();
  selectedKeys.add(key);
  syncBulkButtons();
  openMoving();
}

async function handleSingleDelete(key, row) {
  if (!row) return;
  if (!document.contains(row)) return;
  setRowBusy(row, true);
  showToast('Deleting...', 'info');
  const kind = row.classList.contains('files-row-folder') ? 'folder' : 'file';

  const result = await deleteFilesRecursive(key, kind);
  if (result.ok) {
    showToast(result.message, 'success');
  } else {
    showToast(result.message, 'error');
  }

  setRowBusy(row, false);
  if (!currentBucket) return;
  loadFiles();
}

async function deleteFilesRecursive(key, kind = null) {
  if (!currentBucket) {
    return { ok: false, message: 'No bucket selected' };
  }

  if (kind === null) {
    kind = key.endsWith('/') ? 'folder' : 'file';
  }

  if (kind === 'folder') {
    let contToken = null;
    let totalDeleted = 0;
    try {
      do {
        const result = await window.r2Open.r2.listObjects({
          bucket: currentBucket,
          prefix: key,
          maxKeys: 1000,
          continuationToken: contToken,
        });
        if (!result || result.ok !== true) {
          return { ok: false, message: result && result.error || 'list failed' };
        }
        const objects = result.objects || [];
        for (const obj of objects) {
          if (obj.key) {
            const delRes = await window.r2Open.r2.deleteObject({ bucket: currentBucket, key: obj.key });
            if (delRes && delRes.ok) totalDeleted++;
          }
        }
        // Recursively delete subfolders from commonPrefixes
        const commonPrefixes = result.commonPrefixes || [];
        for (const subPrefix of commonPrefixes) {
          const subResult = await deleteFilesRecursive(subPrefix, 'folder');
          if (subResult.ok) {
            totalDeleted += subResult.totalDeleted || 0;
          }
        }
        contToken = result.nextContinuationToken || null;
      } while (contToken);
      return { ok: true, message: `Deleted ${totalDeleted} file${totalDeleted === 1 ? '' : 's'}`, totalDeleted };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  } else {
    const writeRes = await window.r2Open.r2.deleteObject({ bucket: currentBucket, key });
    if (writeRes && writeRes.ok) {
      return { ok: true, message: 'Deleted' };
    } else {
      return { ok: false, message: writeRes && writeRes.error || 'unknown error' };
    }
  }
}

async function handleSingleDownload(key, row) {
  if (!row) return;
  if (!document.contains(row)) return;
  setRowBusy(row, true);
  showToast('Checking local folder...', 'info');
  let localRoot;
  try {
    localRoot = await getLocalMappingWithTimeout(currentBucket);
  } catch (e) {
    console.error('[handleSingleDownload] getLocalMapping failed:', e);
    localRoot = null;
  }
  if (!localRoot) {
    showToast('No local folder set. Please configure it in Settings.', 'error');
    setRowBusy(row, false);
    return;
  }
  const kind = row.classList.contains('files-row-folder') ? 'folder' : 'file';

  if (kind === 'folder') {
    let contToken = null;
    let totalDownloaded = 0;
    let totalFailed = 0;
    try {
      do {
        const result = await window.r2Open.r2.listObjects({
          bucket: currentBucket,
          prefix: key,
          maxKeys: 1000,
          continuationToken: contToken,
        });
        if (!result || result.ok !== true) {
          showToast(`Failed to list folder: ${result && result.error || 'list failed'}`, 'error');
          setRowBusy(row, false);
          return;
        }
        const objects = result.objects || [];
        for (const obj of objects) {
          if (obj.key && !obj.key.endsWith('/')) {
            const destPath = await pathJoin(localRoot, obj.key);
            const dl = await window.r2Open.r2.getObject({ bucket: currentBucket, key: obj.key });
            if (dl && dl.ok) {
              await window.r2Open.fs.writeFile({ path: destPath, bytes: dl.bytes });
              totalDownloaded++;
            } else {
              totalFailed++;
            }
          }
        }
        contToken = result.nextContinuationToken || null;
        showToast(`Downloading folder... ${totalDownloaded} done`, 'info');
      } while (contToken);
      if (totalFailed === 0) {
        showToast(`Downloaded ${totalDownloaded} file${totalDownloaded === 1 ? '' : 's'}`, 'success');
        await window.r2Open.transfer.add({ type: 'download', key, bucket: currentBucket, size: totalDownloaded, status: 'success' });
      } else {
        showToast(`Downloaded ${totalDownloaded}, failed ${totalFailed}`, 'error');
        await window.r2Open.transfer.add({ type: 'download', key, bucket: currentBucket, size: totalDownloaded, status: 'failed', error: `${totalFailed} files failed` });
      }
    } catch (err) {
      showToast(`Download failed: ${err.message}`, 'error');
      await window.r2Open.transfer.add({ type: 'download', key, bucket: currentBucket, size: 0, status: 'failed', error: err.message });
    }
  } else {
    const destPath = await pathJoin(localRoot, key);
    showToast(`Downloading ${key}...`, 'info');
    const dl = await window.r2Open.r2.getObject({ bucket: currentBucket, key });
    if (!dl || dl.ok !== true) {
      showToast(`Download failed: ${dl && dl.error || 'download failed'}`, 'error');
      await window.r2Open.transfer.add({ type: 'download', key, bucket: currentBucket, size: 0, status: 'failed', error: dl && dl.error || 'download failed' });
      setRowBusy(row, false);
      return;
    }
    showToast('Writing to disk...', 'info');
    const writeRes = await window.r2Open.fs.writeFile({ path: destPath, bytes: dl.bytes });
    if (writeRes && writeRes.ok) {
      showToast(`Downloaded ${key}`, 'success');
      await window.r2Open.transfer.add({ type: 'download', key, bucket: currentBucket, size: dl.bytes ? dl.bytes.length : 0, status: 'success' });
    } else {
      showToast(`Save failed: ${writeRes && writeRes.error || 'unknown'}`, 'error');
      await window.r2Open.transfer.add({ type: 'download', key, bucket: currentBucket, size: 0, status: 'failed', error: writeRes && writeRes.error || 'unknown' });
    }
  }
  loadFiles();
  setRowBusy(row, false);
}

/* ── Bulk actions ── */
async function handleBulkDownload() {
  const btn = document.getElementById('bulkDownloadBtn');
  if (!btn || selectedKeys.size === 0) return;
  const keys = [...selectedKeys];
  btn.disabled = true;
  showToast(`Downloading ${keys.length} file${keys.length === 1 ? '' : 's'}...`, 'info');
  const localRoot = await getLocalMapping(currentBucket);
  if (!localRoot) {
    showToast('No local folder configured — set it in Settings first.', 'error');
    syncBulkButtons();
    return;
  }
  let done = 0;
  let failed = 0;
  for (const key of keys) {
    const destPath = await pathJoin(localRoot, key);
    const dl = await window.r2Open.r2.getObject({ bucket: currentBucket, key });
    if (dl && dl.ok) {
      const writeRes = await window.r2Open.fs.writeFile({ path: destPath, bytes: dl.bytes });
      if (writeRes && writeRes.ok) {
        done++;
        await window.r2Open.transfer.add({ type: 'download', key, bucket: currentBucket, size: dl.bytes ? dl.bytes.length : 0, status: 'success' });
      } else {
        failed++;
        showToast(`Failed to save ${key}: ${writeRes && writeRes.error || 'unknown'}`, 'error');
        await window.r2Open.transfer.add({ type: 'download', key, bucket: currentBucket, size: 0, status: 'failed', error: writeRes && writeRes.error || 'unknown' });
      }
    } else {
      failed++;
      showToast(`Failed to download ${key}`, 'error');
      await window.r2Open.transfer.add({ type: 'download', key, bucket: currentBucket, size: 0, status: 'failed', error: dl && dl.error || 'download failed' });
    }
    showToast(`Downloading... ${done + failed}/${keys.length}`, 'info');
    applyCheckboxState(key, false);
  }
  selectedKeys.clear();
  syncBulkButtons();
  showToast(`Downloaded ${done} file${done === 1 ? '' : 's'}${failed > 0 ? `, ${failed} failed` : ''}`, failed > 0 ? 'warning' : 'success');
  bindFileRowActions();
}

async function handleBulkMove() {
  await ensureMovingReady();
  openMoving();
}

async function handleBulkDelete() {
  const btn = document.getElementById('bulkDeleteBtn');
  if (!btn || selectedKeys.size === 0) return;
  const keys = [...selectedKeys];
  btn.disabled = true;
  showToast(`Deleting ${keys.length} item${keys.length === 1 ? '' : 's'}...`, 'info');
  let done = 0;
  let failed = 0;

  for (const key of keys) {
    const kind = key.endsWith('/') ? 'folder' : 'file';
    const result = await deleteFilesRecursive(key, kind);
    if (result.ok) {
      done++;
    } else {
      failed++;
      showToast(`Failed to delete ${key}: ${result.message}`, 'error');
    }
    showToast(`Deleting... ${done + failed}/${keys.length}`, 'info');
    applyCheckboxState(key, false);
  }
  selectedKeys.clear();
  syncBulkButtons();
  showToast(`Deleted ${done} item${done === 1 ? '' : 's'}${failed > 0 ? `, ${failed} failed` : ''}`, failed > 0 ? 'warning' : 'success');
  if (!currentBucket) return;
  loadFiles();
}

/* ── Preview ── */
async function previewFile(key, row) {
  if (!key || !currentBucket) return;
  if (row) { setRowBusy(row, true); showToast('Loading preview...', 'info'); }
  const dl = await window.r2Open.r2.getObject({ bucket: currentBucket, key });
  if (!dl || dl.ok !== true) {
    if (row) { showToast(`Preview failed: ${dl && dl.error || 'download failed'}`, 'error'); setRowBusy(row, false); }
    return;
  }
  const tmpDir = await getTmpDir();
  const filename = key.split('/').pop() || `r2-preview-${Date.now()}`;
  const tmpPath = await pathJoin(tmpDir, `r2open-${Date.now()}-${filename}`);
  showToast('Writing to temp...', 'info');
  const writeRes = await window.r2Open.fs.writeFile({ path: tmpPath, bytes: dl.bytes });
  if (!writeRes || writeRes.ok !== true) {
    if (row) { showToast(`Write error: ${writeRes && writeRes.error || 'unknown'}`, 'error'); setRowBusy(row, false); }
    return;
  }
  showToast('Opening preview...', 'info');
  const openRes = await window.r2Open.fs.openExternal({ path: tmpPath });
  if (row) {
    if (openRes && openRes.ok) showToast('Opened preview', 'success');
    else showToast(`Open error: ${openRes && openRes.error || 'unknown'}`, 'error');
    setRowBusy(row, false);
  }
}

/* ── Local indicator ── */
async function bindFileRowActions() {
  const table = document.getElementById('filesTable');
  if (!table) return;
  let localRoot = null;
  try {
    localRoot = await getLocalMappingWithTimeout(currentBucket);
  } catch (err) {
    console.error('[bindFileRowActions] getLocalMapping failed:', err);
  }
  table.querySelectorAll('.local-indicator[data-key]').forEach((ind) => {
    const key = ind.getAttribute('data-key');
    if (!key) return;
    if (!localRoot) {
      ind.textContent = '—';
      ind.className = 'local-indicator local-none';
      ind.title = 'No local folder configured';
      return;
    }
    (async () => {
      try {
        const localPath = await pathJoin(localRoot, key);
        const exists = await window.r2Open.fsUtil.exists(localPath);
        ind.textContent = '●';
        if (exists) {
          ind.className = 'local-indicator local-yes';
          ind.title = `Local copy exists: ${localPath}`;
        } else {
          ind.className = 'local-indicator local-no';
          ind.title = `Not found locally — checked: ${localPath}`;
        }
      } catch (err) {
        console.error('[local-indicator] check failed for', key, err);
        ind.textContent = '?';
        ind.className = 'local-indicator local-err';
        ind.title = 'Check failed: ' + (err && err.message || err);
      }
    })();
  });
}

/* ── Breadcrumbs ── */
function renderBreadcrumbs() {
  const bc = document.getElementById('filesBreadcrumbs');
  if (!bc) return;
  const parts = (currentPrefix || '').split('/').filter(Boolean);
  let html = `<a class="crumb crumb-root" data-prefix="">${escapeHtml(currentBucket || '')}</a>`;
  let acc = '';
  for (const p of parts) {
    acc += p + '/';
    html += `<span class="crumb-sep">/</span><a class="crumb" data-prefix="${escapeHtml(acc)}">${escapeHtml(p)}</a>`;
  }
  bc.innerHTML = html;
  bc.querySelectorAll('.crumb').forEach((el) => {
    el.addEventListener('click', () => {
      currentPrefix = el.getAttribute('data-prefix') || '';
      loadFiles();
      syncUploadPrefix();
    });
  });
}

/* ── Drag & Drop Upload ── */
function bindFilesTableDropzone() {
  const table = document.getElementById('filesTable');
  if (!table) return;

  ['dragenter', 'dragover'].forEach((ev) => {
    table.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      table.classList.add('files-dragover');
    });
  });

  ['dragleave', 'dragend'].forEach((ev) => {
    table.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      table.classList.remove('files-dragover');
    });
  });

  table.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    table.classList.remove('files-dragover');

    if (!currentBucket) {
      showToast('Select a bucket before uploading.', 'error');
      return;
    }

    const files = e.dataTransfer && e.dataTransfer.files;
    if (!files || files.length === 0) return;

    // Use upload.js ingestDroppedFiles for consistent handling
    if (typeof ingestDroppedFiles === 'function') {
      ingestDroppedFiles(files);
    }
  });
}

/* ── Full render (search) ── */
function renderFilesTable(rows, filterText = '') {
  const table = document.getElementById('filesTable');
  if (!table) return;
  const needle = (filterText || '').trim().toLowerCase();
  const filtered = needle ? rows.filter((r) => r.key.toLowerCase().includes(needle)) : rows;

  table.innerHTML = `
    <div class="files-row files-row-header">
      <span class="files-row-check"><input type="checkbox" id="selectAllFiles" title="Select all"></span>
      <span class="files-row-icon"></span>
      <span class="files-row-name">Name</span>
      <span class="files-row-meta">Size</span>
      <span class="files-row-date">Modified</span>
      <span class="files-row-actions">
        ${buildBulkActionsHtml()}
      </span>
    </div>
    <div class="files-list-body" id="filesListBody"></div>
    <div class="files-list-footer" id="filesListFooter"></div>`;

  appendFileRows(filtered);
  updateFooter();
  bindSelectAll();
  syncBulkButtons();
}
