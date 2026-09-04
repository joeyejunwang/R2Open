/**
 * upload.js – Upload panel: queue, drag-drop, URL/text upload
 */

/* ── Upload state ── */
const uploadState = {
  items: [],
  running: false,
  cancelled: false,
};

function uid(prefix = 'up') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/* ── Panel binding ── */
function bindUploadPanel() {
  const browse = document.getElementById('uploadBrowseBtn');
  const folder = document.getElementById('uploadFolderBtn');
  const urlBtn = document.getElementById('uploadUrlBtn');
  const paste  = document.getElementById('uploadPasteBtn');
  const drop   = document.getElementById('uploadDropzone');
  const prefixInput = document.getElementById('uploadPrefixInput');

  if (browse) browse.addEventListener('click', (e) => { e.stopPropagation(); handleBrowseFiles(); });
  if (folder) folder.addEventListener('click', (e) => { e.stopPropagation(); handleBrowseFolders(); });
  if (urlBtn) urlBtn.addEventListener('click', (e) => { e.stopPropagation(); openUploadTextModal({ mode: 'url' }); });
  if (paste)  paste.addEventListener('click', (e) => { e.stopPropagation(); handlePasteFromClipboard(); });

  if (drop) {
    ['dragenter', 'dragover'].forEach((ev) => {
      drop.addEventListener(ev, (e) => {
        e.preventDefault();
        e.stopPropagation();
        drop.classList.add('upload-dragover');
      });
    });
    ['dragleave', 'dragend', 'drop'].forEach((ev) => {
      drop.addEventListener(ev, (e) => {
        e.preventDefault();
        e.stopPropagation();
        drop.classList.remove('upload-dragover');
      });
    });
    drop.addEventListener('drop', (e) => {
      const files = e.dataTransfer && e.dataTransfer.files;
      if (!files || files.length === 0) return;
      ingestDroppedFiles(files);
    });
    drop.addEventListener('click', (e) => {
      if (e.target.closest('button, input, select, textarea, label, a')) return;
      handleBrowseFiles();
    });
    drop.addEventListener('keydown', (e) => {
      if (e.target !== drop) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleBrowseFiles();
      }
    });
  }

  if (prefixInput) {
    prefixInput.addEventListener('click', (e) => e.stopPropagation());
    prefixInput.addEventListener('keydown', (e) => e.stopPropagation());
    prefixInput.addEventListener('focus', (e) => e.stopPropagation());
    prefixInput.addEventListener('input', () => {
      uploadState.prefix = normalizePrefix(prefixInput.value);
      renderUploadQueue();
    });
  }

  const uploadOptions = drop ? drop.querySelector('.upload-options') : null;
  if (uploadOptions) {
    uploadOptions.querySelectorAll('input, label').forEach((el) => {
      el.addEventListener('click', (e) => e.stopPropagation());
    });
  }

  const clearBtn = document.getElementById('uploadQueueClearBtn');
  if (clearBtn) clearBtn.addEventListener('click', () => clearFinishedUploads());

  // Bulk action buttons in files list (dynamically rendered)
  document.addEventListener('click', (e) => {
    if (e.target.closest('#bulkUploadFilesBtn')) {
      e.stopPropagation();
      handleBrowseFiles();
    }
    if (e.target.closest('#bulkUploadFoldersBtn')) {
      e.stopPropagation();
      handleBrowseFolders();
    }
  });

  bindUploadTextModal();
}

function syncUploadPrefix() {
  const input = document.getElementById('uploadPrefixInput');
  if (!input) return;
  input.value = currentPrefix || '';
  uploadState.prefix = currentPrefix || '';
  input.disabled = !currentBucket;
  const hint = document.getElementById('uploadPrefixHint');
  if (hint) hint.textContent = currentBucket
    ? `Files go to ${currentBucket}/${currentPrefix || ''}`
    : 'Pick a bucket to enable uploads.';
  renderUploadQueue();
}

function normalizePrefix(p) {
  return String(p || '').replace(/^\/+|\/+$/g, '');
}

function joinKey(...parts) {
  return parts
    .filter((p) => p !== null && p !== undefined && p !== '')
    .map((p, i) => i === parts.length - 1 ? String(p).replace(/^\/+/, '') : String(p).replace(/^\/+|\/+$/g, ''))
    .join('/');
}

/* ── Browse files / folders ── */
async function handleBrowseFiles() {
  if (!currentBucket) { showToast('Select a bucket before uploading.', 'error'); return; }
  const res = await window.r2Open.fs.pickFiles({ multiSelections: true });
  if (!res || !res.ok) {
    showToast(`Picker failed: ${(res && res.error) || 'unknown error'}`, 'error');
    return;
  }
  if (res.canceled) return;
  const files = Array.isArray(res.files) && res.files.length
    ? res.files
    : (Array.isArray(res.paths) ? res.paths : []);
  if (files.length === 0) return;
  await addLocalFilesToQueue(files);
}

async function handleBrowseFolders() {
  if (!currentBucket) { showToast('Select a bucket before uploading.', 'error'); return; }
  const res = await window.r2Open.fs.pickFolders({});
  if (!res || !res.ok) {
    showToast(`Picker failed: ${(res && res.error) || 'unknown error'}`, 'error');
    return;
  }
  if (res.canceled) return;
  const folderPaths = Array.isArray(res.paths) ? res.paths : [];
  if (folderPaths.length === 0) return;
  const walk = await window.r2Open.fs.walkPaths({ paths: folderPaths });
  if (!walk || !walk.ok) {
    showToast(`Could not enumerate folders: ${(walk && walk.error) || 'unknown error'}`, 'error');
    return;
  }
  await addLocalFilesToQueue(walk.files || [], { preserveFolders: true, sourceRoots: folderPaths });
}

async function handlePasteFromClipboard() {
  if (!currentBucket) { showToast('Select a bucket before uploading.', 'error'); return; }
  const cb = await window.r2Open.clipboard.readText();
  const text = (cb && cb.ok) ? (cb.text || '').trim() : '';
  if (!text) {
    showToast('Clipboard is empty or not text.', 'error');
    return;
  }
  openUploadTextModal({ mode: 'paste', prefill: text });
}

/* ── URL/Text modal ── */
function openUploadTextModal({ mode = 'url', prefill = '' } = {}) {
  const modal = document.getElementById('uploadTextModal');
  if (!modal) return;
  const titleEl = document.getElementById('uploadTextModalTitle');
  const subEl   = document.getElementById('uploadTextModalSubtitle');
  const inputEl = document.getElementById('uploadTextModalInput');
  const nameEl  = document.getElementById('uploadTextModalFilename');
  const hintEl  = document.getElementById('uploadTextModalHint');
  const footer  = document.getElementById('uploadTextModalFooter');
  const errorEl = document.getElementById('uploadTextModalError');

  if (mode === 'paste') {
    titleEl.textContent = 'Paste from clipboard';
    subEl.textContent = 'Upload clipboard text as a file, or paste Markdown to upload each link.';
    inputEl.placeholder = 'Paste Markdown, plain text, or URLs here…';
    hintEl.textContent = 'Tip: a Markdown document is saved as index.md; multiple Markdown links create one file per link.';
  } else {
    titleEl.textContent = 'Add URL';
    subEl.textContent = 'Upload the contents of a public URL to this bucket.';
    inputEl.placeholder = 'https://example.com/path/to/image.png';
    hintEl.textContent = 'Tip: paste multiple URLs (one per line) to upload in batch.';
  }
  inputEl.value = prefill;
  nameEl.value = '';
  errorEl.textContent = '';
  errorEl.classList.remove('show');
  if (footer) footer.textContent = '';
  modal.dataset.mode = mode;
  modal.classList.add('open');
  inputEl.focus();
}

function closeUploadTextModal() {
  const modal = document.getElementById('uploadTextModal');
  if (modal) modal.classList.remove('open');
}

function bindUploadTextModal() {
  const modal = document.getElementById('uploadTextModal');
  if (!modal) return;
  const submit = document.getElementById('uploadTextModalSubmit');
  const cancel = document.getElementById('uploadTextModalCancel');
  const close  = document.getElementById('uploadTextModalClose');
  if (submit) submit.addEventListener('click', () => submitUploadTextModal());
  if (cancel) cancel.addEventListener('click', () => closeUploadTextModal());
  if (close)  close.addEventListener('click', () => closeUploadTextModal());
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeUploadTextModal();
  });
  const inputEl = document.getElementById('uploadTextModalInput');
  if (inputEl) {
    inputEl.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        submitUploadTextModal();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeUploadTextModal();
      }
    });
  }
}

async function submitUploadTextModal() {
  const modal = document.getElementById('uploadTextModal');
  const mode  = modal ? modal.dataset.mode : 'url';
  const inputEl = document.getElementById('uploadTextModalInput');
  const nameEl  = document.getElementById('uploadTextModalFilename');
  const errorEl = document.getElementById('uploadTextModalError');
  const footer  = document.getElementById('uploadTextModalFooter');
  const text = (inputEl ? inputEl.value : '').trim();
  if (!text) {
    errorEl.textContent = 'Source is empty.';
    errorEl.classList.add('show');
    return;
  }
  errorEl.textContent = '';
  errorEl.classList.remove('show');
  if (!currentBucket) {
    errorEl.textContent = 'Select a bucket first.';
    errorEl.classList.add('show');
    return;
  }

  const parsed = parseUploadText(text, mode);
  if (parsed.error) {
    errorEl.textContent = parsed.error;
    errorEl.classList.add('show');
    return;
  }
  const overrides = {
    fileName: nameEl && nameEl.value.trim() ? nameEl.value.trim() : null,
  };

  if (mode === 'paste' && parsed.kind === 'single') {
    const filename = overrides.fileName || deriveTextFileName(parsed.body);
    addUploadItem({
      id: uid('text'),
      source: 'clipboard',
      key: filename,
      size: parsed.body.length,
      status: 'queued',
      payload: { kind: 'text', body: parsed.body, contentType: 'text/plain;charset=utf-8' },
      display: filename,
    });
  } else if (mode === 'paste' && parsed.kind === 'markdown') {
    for (const file of parsed.files) {
      addUploadItem({
        id: uid('md'),
        source: 'markdown',
        key: file.name,
        size: file.body.length,
        status: 'queued',
        payload: { kind: 'text', body: file.body, contentType: 'text/markdown;charset=utf-8' },
        display: file.name,
      });
    }
  } else if (mode === 'url' && parsed.kind === 'single') {
    const filename = overrides.fileName || parsed.fileName;
    addUploadItem({
      id: uid('url'),
      source: 'url',
      key: filename,
      size: null,
      status: 'queued',
      payload: { kind: 'url', url: parsed.url, fileName: filename, contentType: parsed.contentType || null },
      display: filename,
    });
  } else if (mode === 'url' && parsed.kind === 'list') {
    for (const u of parsed.urls) {
      const name = overrides.fileName || deriveUrlFileName(u);
      addUploadItem({
        id: uid('url'),
        source: 'url',
        key: name,
        size: null,
        status: 'queued',
        payload: { kind: 'url', url: u, fileName: name, contentType: null },
        display: name,
      });
    }
  } else if (mode === 'url' && parsed.kind === 'markdown') {
    for (const file of parsed.files) {
      addUploadItem({
        id: uid('mdurl'),
        source: 'markdown',
        key: file.name,
        size: file.body.length,
        status: 'queued',
        payload: { kind: 'text', body: file.body, contentType: 'text/markdown;charset=utf-8' },
        display: file.name,
      });
    }
  } else {
    errorEl.textContent = 'Unrecognised input — paste a URL, multiple URLs, or a Markdown document.';
    errorEl.classList.add('show');
    return;
  }

  if (footer) footer.textContent = `Added ${parsed.count || 1} item(s) to the queue.`;
  closeUploadTextModal();
  renderUploadQueue();
  if (!uploadState.running && uploadState.items.some((it) => it.status === 'queued')) {
    startUploadQueue();
  }
}

/* ── Parse text ── */
function parseUploadText(text, mode) {
  const trimmed = text.trim();
  const urlRegex = /^https?:\/\/\S+$/i;
  const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const isMarkdown = /(?:^|\s)\[[^\]]+\]\([^)]+\)/m.test(trimmed) || /^#{1,6}\s/m.test(trimmed);

  if (mode === 'url') {
    if (isMarkdown && /!\[[^\]]*\]\([^)]+\)/m.test(trimmed)) {
      return parseMarkdownLinks(trimmed);
    }
    if (lines.length > 1 && lines.every(urlRegex.test.bind(urlRegex))) {
      return { kind: 'list', urls: lines, count: lines.length };
    }
    if (urlRegex.test(lines[0] || '')) {
      const u = new URL(lines[0]);
      const fileName = u.pathname.split('/').pop() || deriveUrlFileName(lines[0]);
      return { kind: 'single', url: lines[0], fileName, contentType: null, count: 1 };
    }
    if (isMarkdown) {
      return parseMarkdownLinks(trimmed);
    }
    return { error: 'Enter at least one http(s) URL or a Markdown document.' };
  }

  if (isMarkdown) {
    const parsed = parseMarkdownLinks(trimmed);
    if (parsed.kind === 'markdown') return parsed;
  }
  if (lines.length > 1 && lines.every(urlRegex.test.bind(urlRegex))) {
    return { kind: 'list', urls: lines, count: lines.length };
  }
  return { kind: 'single', body: trimmed, count: 1 };
}

function parseMarkdownLinks(text) {
  const linkRegex = /!?\[([^\]]*)\]\(([^)]+)\)/g;
  const files = [];
  let match;
  while ((match = linkRegex.exec(text)) !== null) {
    const isImage = match[0].startsWith('!');
    const label = match[1].trim();
    const url = match[2].trim();
    if (isImage) {
      const name = sanitizeFileName(label || deriveUrlFileName(url));
      files.push({
        name: name.includes('.') ? name : `${name}.bin`,
        body: `# Image\n\n${url}\n`,
      });
    } else {
      const safe = sanitizeFileName(label || deriveUrlFileName(url));
      files.push({ name: safe.endsWith('.md') ? safe : `${safe}.md`, body: `# ${label || 'link'}\n\n${url}\n` });
    }
  }
  if (files.length === 0) {
    return { kind: 'markdown', files: [{ name: 'clipboard.md', body: text }], count: 1 };
  }
  return { kind: 'markdown', files, count: files.length };
}

function deriveTextFileName(body) {
  const first = String(body || '').split(/\r?\n/)[0] || '';
  const cleaned = first.replace(/[^a-z0-9-_]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  const base = cleaned || 'clipboard';
  return `${base}.txt`;
}

function deriveUrlFileName(u) {
  try {
    const parsed = new URL(u);
    const base = parsed.pathname.split('/').pop() || 'url';
    return sanitizeFileName(base);
  } catch {
    return 'url.bin';
  }
}

function sanitizeFileName(name) {
  return String(name || '').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 200) || 'file';
}

/* ── Add files to queue ── */
async function addLocalFilesToQueue(paths, { preserveFolders = false, sourceRoots = [] } = {}) {
  if (!paths || paths.length === 0) return;
  const el = document.getElementById('uploadPreserveFolders');
  const preserve = preserveFolders || !!(el && el.checked);
  
  for (const entry of paths) {
    let absPath, name, size;
    if (typeof entry === 'string') {
      absPath = entry;
      const base = window.pathAPI ? window.pathAPI.basename(entry) : entry.split(/[\\/]/).pop();
      name = base;
    } else if (entry && typeof entry === 'object') {
      absPath = entry.absPath || entry.path;
      name = entry.name || (absPath ? absPath.split(/[\\/]/).pop() : 'unnamed');
      size = entry.size;
      // Skip folder placeholder entries from walkRecursive — only upload real files
      if (entry.kind === 'folder') continue;
    } else {
      continue;
    }
    if (!absPath) continue;

    let key;
    if (preserve && sourceRoots.length) {
      // Find the longest matching root to handle nested source roots
      let bestRoot = null;
      for (const r of sourceRoots) {
        // Normalize both paths to use forward slashes for comparison
        const normAbs = absPath.replace(/\\/g, '/');
        const normR = r.replace(/\\/g, '/').replace(/\/+$/, '');
        if (normAbs.startsWith(normR + '/') && (!bestRoot || normR.length > bestRoot.length)) {
          bestRoot = normR;
        }
      }
      if (bestRoot) {
        const rel = absPath.slice(bestRoot.length).replace(/^[\\/]+/, '').replace(/[\\/]+/g, '/');
        // For single-folder upload, prepend the folder name so the
        // folder structure appears as "B/item.key" in R2, or "A/B/item.key" if prefix is set.
        if (sourceRoots.length === 1) {
          const folderName = bestRoot.replace(/\\/g, '/').split('/').filter(Boolean).pop();
          key = folderName + '/' + rel;
        } else {
          key = rel || name;
        }
      }
    }
    if (!key) key = name;

    addUploadItem({
      id: uid('file'),
      source: 'local',
      key,
      size,
      absPath,
      status: 'queued',
      payload: { kind: 'path', path: absPath, contentType: null },
      display: absPath,
    });
  }
  renderUploadQueue();
  if (!uploadState.running && uploadState.items.some((it) => it.status === 'queued')) {
    startUploadQueue();
  }
}

async function ingestDroppedFiles(fileList) {
  if (!currentBucket) {
    showToast('Select a bucket before uploading.', 'error');
    return;
  }
  const arr = Array.from(fileList || []);
  if (arr.length === 0) return;

  // Separate files and directories
  const filePaths = [];
  const folderPaths = [];

  for (const f of arr) {
    const path = f.path || f.name;
    // We need to check if it's a directory by its type
    // For now, we'll try to walk all paths and let walkPaths handle it
    folderPaths.push(path);
  }

  // Use walkPaths to properly enumerate all files (including in subfolders)
  const walk = await window.r2Open.fs.walkPaths({ paths: folderPaths });
  if (!walk || !walk.ok) {
    showToast(`Could not enumerate dropped items: ${(walk && walk.error) || 'unknown error'}`, 'error');
    return;
  }

  // Get the preserve folders setting
  const el = document.getElementById('uploadPreserveFolders');
  const preserve = el ? !!el.checked : true; // Default to true for drag-drop

  const files = walk.files || [];
  if (files.length === 0) {
    showToast('No files to upload.', 'warning');
    return;
  }

  showToast(`Adding ${files.length} file${files.length === 1 ? '' : 's'} to upload queue...`, 'info');

  await addLocalFilesToQueue(files, { preserveFolders: preserve, sourceRoots: folderPaths });
}

/* ── Queue management ── */
function addUploadItem(item) {
  uploadState.items.push({
    ...item,
    progress: 0,
    error: null,
  });
  renderUploadQueue();
}

function renderUploadQueue() {
  const list = document.getElementById('uploadQueueList');
  const wrap = document.getElementById('uploadQueue');
  const countEl = document.getElementById('uploadQueueCount');
  const summaryEl = document.getElementById('uploadQueueSummary');
  const clearBtn = document.getElementById('uploadQueueClearBtn');

  if (!list || !wrap) return;

  const items = uploadState.items;
  wrap.hidden = items.length === 0;
  if (items.length === 0) {
    list.innerHTML = '';
    if (countEl) countEl.textContent = '0 files';
    if (summaryEl) summaryEl.textContent = '';
    if (clearBtn) clearBtn.disabled = true;
    return;
  }

  const prefix = uploadState.prefix || currentPrefix || '';
  const queued = items.filter((it) => it.status === 'queued').length;
  const done = items.filter((it) => it.status === 'success' || it.status === 'skipped').length;
  const failed = items.filter((it) => it.status === 'error').length;
  const totalBytes = items.reduce((acc, it) => acc + (it.size || 0), 0);

  if (countEl) countEl.textContent = `${items.length} file${items.length === 1 ? '' : 's'}`;
  if (summaryEl) {
    const parts = [];
    if (totalBytes) parts.push(formatSize(totalBytes));
    parts.push(`${done} done`);
    if (queued) parts.push(`${queued} queued`);
    if (failed) parts.push(`${failed} failed`);
    summaryEl.textContent = ` · ${parts.join(' · ')} · prefix: ${prefix || '/'}`;
  }
  if (clearBtn) clearBtn.disabled = (done + failed) === 0;

  list.innerHTML = items.map((it) => {
    const statusLabel = ({ queued: '…', uploading: '↻', success: '✓', error: '!', skipped: '–' })[it.status] || '?';
    const statusTitle = ({ queued: 'Queued', uploading: 'Uploading…', success: 'Uploaded', error: it.error || 'Failed', skipped: 'Skipped' })[it.status] || '';
    const fullKey = joinKey(prefix || '', it.key);
    const sizeText = it.size != null ? formatSize(it.size) : '—';
    const ind = it.status === 'uploading';
    return `
      <div class="upload-item" data-id="${escapeHtml(it.id)}">
        <span class="upload-item-status ${it.status}" title="${escapeHtml(statusTitle)}">${statusLabel}</span>
        <span class="upload-item-key" title="${escapeHtml(fullKey)}">${escapeHtml(fullKey)}</span>
        <span class="upload-item-progress ${ind ? 'indeterminate' : ''}">
          <span class="upload-item-progress-bar" style="width:${ind ? 0 : it.progress || (it.status === 'success' ? 100 : 0)}%"></span>
        </span>
        <span class="upload-item-size">${sizeText}</span>
        <button class="upload-item-remove" type="button" data-id="${escapeHtml(it.id)}" title="Remove">×</button>
      </div>`;
  }).join('');

  list.querySelectorAll('.upload-item-remove').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      removeUploadItem(id);
    });
  });
}

function removeUploadItem(id) {
  if (uploadState.running) {
    const item = uploadState.items.find((it) => it.id === id);
    if (item && item.status === 'uploading') return;
  }
  uploadState.items = uploadState.items.filter((it) => it.id !== id);
  renderUploadQueue();
}

function clearFinishedUploads() {
  uploadState.items = uploadState.items.filter((it) => it.status !== 'success' && it.status !== 'skipped' && it.status !== 'error');
  renderUploadQueue();
}

/* ── Upload execution ── */
async function startUploadQueue() {
  if (uploadState.running) return;
  if (!currentBucket) {
    showToast('Select a bucket before uploading.', 'error');
    return;
  }
  uploadState.running = true;
  renderUploadQueue();

  let ok = 0;
  let failed = 0;
  for (const item of uploadState.items) {
    if (item.status === 'success' || item.status === 'skipped') continue;
    item.status = 'uploading';
    item.error = null;
    item.progress = 5;
    renderUploadQueue();
    const fullKey = joinKey(uploadState.prefix || currentPrefix || '', item.key);

    try {
      const result = await uploadSingleItem(item, fullKey);
      item.status = 'success';
      item.progress = 100;
      item.uploadedKey = fullKey;
      ok += 1;
      if (result && result.skippedMirror) item.status = 'success';
      window.r2Open.transfer.add({ type: 'upload', key: fullKey, bucket: currentBucket, size: item.size || 0, status: 'success' });
    } catch (err) {
      item.status = 'error';
      item.error = (err && err.message) || String(err);
      failed += 1;
      window.r2Open.transfer.add({ type: 'upload', key: fullKey || item.key, bucket: currentBucket, size: item.size || 0, status: 'failed', error: item.error });
    }
    renderUploadQueue();
  }

  uploadState.running = false;
  renderUploadQueue();

  if (typeof showToast === 'function') {
    if (failed === 0) showToast(`Uploaded ${ok} file${ok === 1 ? '' : 's'}.`, 'success');
    else showToast(`Uploaded ${ok}, failed ${failed}.`, 'error');
  }

  if (ok > 0) {
    filesCache = [];
    currentContinuationToken = null;
    currentIsTruncated = false;
    loadFiles();
  }
}

function cancelUploadQueue() {
  // Legacy no-op
}

async function uploadSingleItem(item, fullKey) {
  if (!item.payload) throw new Error('Missing upload payload');
  const el = document.getElementById('uploadMirrorLocal');
  const mirrorEnabled = !!(el && el.checked);

  let localPath = null;
  if (item.payload.kind === 'path') {
    localPath = item.payload.path;
  } else if (item.payload.kind === 'text') {
    const tmp = await window.r2Open.fs.writeTemp({
      bytes: Array.from(new TextEncoder().encode(item.payload.body)),
      name: fullKey,
    });
    if (!tmp || !tmp.ok) throw new Error(`Write temp failed: ${(tmp && tmp.error) || 'unknown'}`);
    localPath = tmp.path;
  } else if (item.payload.kind === 'url') {
    const fetched = await window.r2Open.net.fetchUrl({ url: item.payload.url });
    if (!fetched || !fetched.ok) throw new Error((fetched && fetched.error) || 'Fetch failed');
    const name = item.payload.fileName || fetched.fileName || deriveUrlFileName(item.payload.url);
    const tmp = await window.r2Open.fs.writeTemp({
      bytes: Array.from(fetched.bytes),
      name,
    });
    if (!tmp || !tmp.ok) throw new Error(`Write temp failed: ${(tmp && tmp.error) || 'unknown'}`);
    localPath = tmp.path;
  } else {
    throw new Error(`Unsupported payload kind: ${item.payload.kind}`);
  }

  const res = await window.r2Open.r2.putObjectFromPath({ bucket: currentBucket, key: fullKey, localPath });
  if (!res || !res.ok) throw new Error((res && res.error) || 'Upload failed');

  if (mirrorEnabled) {
    const localRoot = await getLocalMappingWithTimeout(currentBucket);
    if (localRoot) {
      const dest = await pathJoin(localRoot, fullKey);
      const read = await window.r2Open.fs.readFile({ path: localPath });
      if (read && read.ok) {
        const write = await window.r2Open.fs.writeFile({ path: dest, bytes: read.bytes });
        if (!write || !write.ok) console.warn('[upload] local mirror failed:', write && write.error);
      }
    }
  }

  return { ok: true };
}
