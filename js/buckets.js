/**
 * buckets.js – Bucket list rendering and selection
 */

function renderBuckets(buckets) {
  const list = document.getElementById('bucketList');
  if (!list) return;

  if (!Array.isArray(buckets) || buckets.length === 0) {
    list.innerHTML = `
      <div class="bucket-empty">
        <div class="bucket-empty-title">No buckets yet</div>
        <div class="bucket-empty-sub">Create one in the Cloudflare dashboard, then press ↻ to refresh.</div>
      </div>`;
    return;
  }

  list.innerHTML = buckets.map((b) => {
    const updated = b.creationDate
      ? new Date(b.creationDate).toLocaleString()
      : '—';
    return `
      <div class="bucket-card" data-name="${escapeHtml(b.name)}">
        <div class="card-header">
          <div class="bucket-title-group">
            <svg class="bucket-icon" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16"></path></svg>
            <div>
              <div class="bucket-name">${escapeHtml(b.name)}</div>
              <div class="bucket-privacy">${lockIconPublic} Public &middot; default</div>
            </div>
          </div>
          <button class="gear-btn" title="Bucket settings">⚙</button>
        </div>
        <div class="card-meta">
          <span>Created</span>
          <span>${escapeHtml(updated)}</span>
        </div>
      </div>`;
  }).join('');

  bindBucketCards();
}

function bindBucketCards() {
  document.querySelectorAll('.bucket-card').forEach((card) => {
    card.addEventListener('click', () => {
      const name = card.getAttribute('data-name');
      if (!name) return;
      selectBucket(name);
    });
  });
}

function selectBucket(name) {
  currentBucket = name;
  currentPrefix = '';
  filesCache = [];

  document.querySelectorAll('.bucket-card').forEach((c) => {
    c.classList.toggle('active', c.getAttribute('data-name') === name);
  });

  // Uncheck all selected files
  selectedKeys.clear();
  document.querySelectorAll('#filesTable .files-row .files-row-check.checked').forEach(el => {
    el.classList.remove('checked');
  });
  document.querySelectorAll('#filesTable .files-row.checked').forEach(el => {
    el.classList.remove('checked');
  });
  syncBulkButtons();

  const empty = document.getElementById('mainEmpty');
  const view  = document.getElementById('bucketView');
  const title = document.getElementById('bucketTitle');
  if (empty) empty.hidden = true;
  if (view)  view.hidden = false;
  if (title) title.textContent = name;

  setActiveTab('files');

  uploadState.items = [];
  uploadState.prefix = '';
  syncUploadPrefix();

  currentLoading = false;

  loadFiles();
}

function clearBucketSelection() {
  currentBucket = null;
  currentPrefix = '';
  filesCache = [];
  document.querySelectorAll('.bucket-card').forEach((c) => c.classList.remove('active'));
  const empty = document.getElementById('mainEmpty');
  const view  = document.getElementById('bucketView');
  if (empty) empty.hidden = false;
  if (view)  view.hidden = true;
}

/* ── Bucket list loading ── */
function showBucketLoading() {
  const list = document.getElementById('bucketList');
  if (!list) return;
  list.innerHTML = `
    <div class="bucket-empty">
      <div class="bucket-empty-title">Loading buckets…</div>
    </div>`;
}

function showBucketError(message) {
  const list = document.getElementById('bucketList');
  if (!list) return;
  list.innerHTML = `
    <div class="bucket-empty bucket-empty-error">
      <div class="bucket-empty-title">Couldn&rsquo;t load buckets</div>
      <div class="bucket-empty-sub">${escapeHtml(message)}</div>
      <button class="btn btn-secondary" id="retryBuckets" style="margin-top:12px;">Retry</button>
    </div>`;
  const retry = document.getElementById('retryBuckets');
  if (retry) retry.addEventListener('click', () => loadBuckets());
}

async function loadBuckets() {
  showBucketLoading();
  let result;
  try {
    result = await window.r2Open.r2.listBuckets();
  } catch (err) {
    console.error('[renderer] listBuckets IPC failed:', err);
    showBucketError(err && err.message ? err.message : 'Network error');
    return;
  }
  if (!result || result.ok !== true) {
    const msg = (result && result.error) || 'Unknown error';
    showBucketError(msg);
    if (typeof showToast === 'function') showToast(`R2 error: ${msg}`, 'error');
    return;
  }
  renderBuckets(result.buckets || []);
}
