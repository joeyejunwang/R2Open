function openMoving() {
  const modal = document.getElementById("movingModal");
  if (!modal) return;
  modal.classList.add("open");

  // Reset footer info
  const footerInfo = document.getElementById('footerInfo');
  if (footerInfo) {
    footerInfo.textContent = 'Select a folder';
  }

  loadFolders({ reset: true, prefix: '' });
}

function closeMoving() {
  const modal = document.getElementById("movingModal");
  if (!modal) return;
  modal.classList.remove("open");
  document.querySelectorAll('.files-row-folder.selected').forEach(el => el.classList.remove('selected'));

  // Clear selected keys and uncheck files
  selectedKeys.clear();
  document.querySelectorAll('#filesTable .files-row .files-row-check.checked').forEach(el => {
    el.classList.remove('checked');
  });
  document.querySelectorAll('#filesTable .files-row.checked').forEach(el => {
    el.classList.remove('checked');
  });
  syncBulkButtons();

  // Refresh files table to reset checkbox states
  loadFiles();
}

async function saveMoving() {
  try {
    if (!currentBucket) {
      showToast("No bucket selected", "error");
      return;
    }
    const selectedFolder = document.querySelector('.files-row-folder.selected');
    if (!selectedFolder) {
      showToast("Please select a destination folder", "error");
      return;
    }
    const destPrefix = selectedFolder.getAttribute('data-key');
    if (selectedKeys.size === 0) {
      showToast("No files selected to move", "error");
      return;
    }

    const saveBtn = document.getElementById("saveMoving");
    if (saveBtn) saveBtn.disabled = true;

    showToast(`Moving ${selectedKeys.size} item${selectedKeys.size === 1 ? '' : 's'}...`, 'info');
    const keys = [...selectedKeys];
    let done = 0;

    for (const key of keys) {
      const destKey = key.replace(currentPrefix, destPrefix);
      const dl = await window.r2Open.r2.getObject({ bucket: currentBucket, key });
      if (dl && dl.ok) {
        await window.r2Open.r2.putObjectFromBytes({ bucket: currentBucket, key: destKey, bytes: dl.bytes });
        await window.r2Open.r2.deleteObject({ bucket: currentBucket, key });
      }
      done++;
      showToast(`Moving... ${done}/${selectedKeys.size}`, 'info');
      applyCheckboxState(key, false);
    }

    selectedKeys.clear();
    syncBulkButtons();
    showToast(`Moved ${done} item${done === 1 ? '' : 's'}`, 'success');

    loadFiles();
    setTimeout(closeMoving, 600);
  } catch (err) {
    console.error("[moving] Save failed:", err);
    showToast("Failed to move files", "error");
  } finally {
    const saveBtn = document.getElementById("saveMoving");
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = "Save";
    }
  }
}

function bindMovingModalEvents() {
  const modal = document.getElementById("movingModal");
  const closeBtn = document.getElementById("closeMoving");
  if (closeBtn) closeBtn.addEventListener("click", closeMoving);

  const cancelBtn = document.getElementById("cancelMoving");
  if (cancelBtn) cancelBtn.addEventListener("click", closeMoving);

  if (modal) {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeMoving();
    });
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal && modal.classList.contains("open")) {
      closeMoving();
    }
  });

  const saveBtn = document.getElementById("saveMoving");
  if (saveBtn) saveBtn.addEventListener("click", saveMoving);
}

/* ── Folders panel ── */
let movingContinuationToken = null;
let movingTruncated = false;
let movingLoading = false;
let movingLoadingKey = '';
let movingLoadedCount = 0;
let movingFoldersSeq = 0;

async function loadFolders({ reset = true, prefix = '' } = {}) {
  if (!currentBucket) return;
  const table = document.getElementById('foldersTable');
  if (!table) return;

  const mySeq = ++movingFoldersSeq;
  const requestedBucket = currentBucket;
  const requestedPrefix = prefix;

  const guardKey = `${currentBucket}::${prefix}`;
  if (movingLoading && movingLoadingKey === guardKey) return;

  movingLoading = true;
  movingLoadingKey = guardKey;

  try {
    if (reset) {
      filesCache = [];
      movingContinuationToken = null;
      movingTruncated = false;
      movingLoadedCount = 0;
      table.innerHTML = `
        <div class="files-list-body" id="foldersListBody"></div>`;
    }

    const body = document.getElementById('foldersListBody');
    if (reset && body) {
      body.innerHTML = `
        <div class="files-row files-loading-row">
          <span class="folder-row-icon">↻</span>
          <span class="folder-row-name files-loading-text">Loading…</span>
        </div>`;
    }

    let result;
    try {
      result = await window.r2Open.r2.listObjects({
        bucket: requestedBucket,
        prefix: requestedPrefix,
        maxKeys: 1000,
        continuationToken: movingContinuationToken,
        delimiter: '/',
      });
    } catch (err) {
      console.error('[moving] listObjects IPC failed:', err);
      if (mySeq !== movingFoldersSeq) return;
      body.innerHTML = `<div class="files-error">Failed to list objects: ${escapeHtml(err && err.message || 'Network error')}</div>`;
      return;
    }

    if (mySeq !== movingFoldersSeq) return;
    if (requestedBucket !== currentBucket) return;

    if (!result || result.ok !== true) {
      const msg = (result && result.error) || 'Unknown error';
      const body2 = document.getElementById('foldersListBody');
      if (body2) {
        const staleLoading = body2.querySelector('.files-loading-row');
        if (staleLoading) staleLoading.remove();
        if (!body2.querySelector('.files-row')) {
          body2.innerHTML = `
            <div class="files-empty">
              <div class="files-empty-title">Couldn&rsquo;t load objects</div>
              <div class="files-empty-sub">${escapeHtml(msg)}</div>
            </div>`;
        }
      }
      if (typeof showToast === 'function') showToast(`R2 error: ${msg}`, 'error');
      return;
    }

    const newRows = [];
    for (const p of result.commonPrefixes || []) {
      newRows.push({ kind: 'folder', key: p, prefix: p });
    }
    filesCache = filesCache.concat(newRows);
    movingLoadedCount = filesCache.length;

    movingContinuationToken = result.nextContinuationToken || null;
    movingTruncated = !!result.isTruncated;

    appendFolderRows(newRows, prefix);
  } finally {
    movingLoading = false;
  }
}

function buildFolderRowsHtml(rows, basePrefix = '') {
  const folders = rows.filter((r) => r.kind === 'folder');

  // Add ".." to go up one level if not at root
  const allFolders = basePrefix ? [{ id: '..', key: '..', name: '..' }, ...folders] : folders;

  if (allFolders.length === 0) {
    return `
      <div class="files-empty">
        <div class="files-empty-title">No sub-folders</div>
        <div class="files-empty-sub">You can move files here or select this location.</div>
      </div>`;
  }

  const folderHtml = allFolders.map((r) => `
    <div class="files-row files-row-folder" data-key="${escapeHtml(r.key)}" name="${escapeHtml(r.key)}">
      <span class="folder-row-icon">📁</span>
      <span class="folder-row-name">${r.key}</span>
    </div>`).join('');

  return folderHtml;
}

function appendFolderRows(rows, basePrefix = '') {
  console.log(rows)
  console.log(basePrefix)
  let body = document.getElementById('foldersListBody');
  if (!body) return;

  const loading = body.querySelector('.files-loading-row');
  if (loading) loading.remove();

  if (rows.length === 0 && !body.querySelector('.files-row')) {
    body.innerHTML = `
      <div class="files-empty">
        <div class="files-empty-title">${basePrefix ? 'Current folder' : 'This bucket is empty'}</div>
        <div class="files-empty-sub">${basePrefix ? 'You can move files to this location.' : 'Drop files in the Upload tab to add some.'}</div>
      </div>`;
    return;
  }

  const empty = body.querySelector('.files-empty');
  if (empty) empty.remove();

  body.insertAdjacentHTML('beforeend', buildFolderRowsHtml(rows, basePrefix));
  bindMovingFolderRows();
}

function bindMovingFolderRows() {
  const body = document.getElementById('foldersListBody');
  if (!body) return;

  body.querySelectorAll('.files-row-folder').forEach((row) => {
    row.addEventListener('click', () => {
      const key = row.getAttribute('data-key');
      // Skip ".." from selection
      if (key === '..') {
        // Go up one level
        const parts = currentPrefix.split('/').filter(Boolean);
        parts.pop();
        const newPrefix = parts.length > 0 ? parts.join('/') + '/' : '';
        loadFolders({ reset: true, prefix: newPrefix });
        return;
      }

      body.querySelectorAll('.files-row-folder').forEach(r => r.classList.remove('selected'));
      row.classList.add('selected');

      // Update footer info
      const footerInfo = document.getElementById('footerInfo');
      if (footerInfo) {
        footerInfo.textContent = `Destination: ${key}`;
      }
    });

    row.addEventListener('dblclick', () => {
      const key = row.getAttribute('data-key');
      if (!key || key === '..') return;
      loadFolders({ reset: true, prefix: key });
    });
  });
}

async function ensureMovingReady() {
  const container = document.getElementById("movingModalContainer");
  if (!container) return false;
  if (!container.querySelector("#movingModal")) {
    await loadComponent("movingModalContainer", "moving-modal");
    bindMovingModalEvents();
  }
  return true;
}
