/**
 * stats.js – Statistics panel
 */

let statsCache = null;
let statsLoading = false;

async function loadBucketStats() {
  if (!currentBucket) return;
  const container = document.getElementById('statsContainer');
  if (!container) return;
  if (statsLoading) return;

  statsLoading = true;
  container.innerHTML = `
    <div class="stats-loading">
      <div class="stats-loading-title">Scanning ${escapeHtml(currentBucket)}…</div>
      <div class="stats-loading-sub">This walks every object in the bucket. Large buckets may take a moment.</div>
    </div>`;

  let result;
  try {
    result = await window.r2Open.r2.bucketStats({ bucket: currentBucket });
  } catch (err) {
    console.error('[renderer] bucketStats IPC failed:', err);
    container.innerHTML = `<div class="stats-error">Failed to load statistics: ${escapeHtml(err && err.message || 'Network error')}<button class="btn btn-secondary stats-retry" id="statsRetry">Retry</button></div>`;
    const retry = document.getElementById('statsRetry');
    if (retry) retry.addEventListener('click', () => loadBucketStats());
    statsLoading = false;
    return;
  }

  if (!result || result.ok !== true) {
    const msg = (result && result.error) || 'Unknown error';
    container.innerHTML = `<div class="stats-error">${escapeHtml(msg)}<button class="btn btn-secondary stats-retry" id="statsRetry">Retry</button></div>`;
    const retry = document.getElementById('statsRetry');
    if (retry) retry.addEventListener('click', () => loadBucketStats());
    if (typeof showToast === 'function') showToast(`R2 error: ${msg}`, 'error');
    statsLoading = false;
    return;
  }

  statsCache = result.stats;
  renderBucketStats(statsCache);
  statsLoading = false;
}

function renderBucketStats(stats) {
  const container = document.getElementById('statsContainer');
  if (!container || !stats) return;

  const totalItems = stats.totalObjects + stats.totalFolders;
  const scanNote = stats.isTruncated
    ? `<div class="stats-warn">Scan stopped after ${stats.scannedKeys.toLocaleString()} keys (pagination cap reached). Numbers below are partial.</div>`
    : '';

  const prefRows = (stats.topLevelPrefixes || []).slice(0, 50);
  const totalPrefixBytes = prefRows.reduce((acc, p) => acc + p.bytes, 0);
  const prefixTable = prefRows.length === 0
    ? `<div class="stats-empty-sub">No sub-prefixes found in this bucket.</div>`
    : `
      <div class="stats-prefix-table">
        <div class="stats-prefix-row stats-prefix-header">
          <span>Prefix</span>
          <span class="stats-prefix-count">Objects</span>
          <span class="stats-prefix-count">Folders</span>
          <span class="stats-prefix-size">Size</span>
          <span class="stats-prefix-bar-col">Share</span>
        </div>
        ${prefRows.map((p) => {
          const share = totalPrefixBytes > 0 ? Math.max(2, Math.round((p.bytes / Math.max(totalPrefixBytes, 1)) * 100)) : 0;
          const safePrefix = escapeHtml(p.prefix);
          return `
            <div class="stats-prefix-row" data-prefix="${safePrefix}">
              <span class="stats-prefix-name" title="${safePrefix}">📁 ${safePrefix}</span>
              <span class="stats-prefix-count">${p.objectCount.toLocaleString()}</span>
              <span class="stats-prefix-count">${p.folderCount.toLocaleString()}</span>
              <span class="stats-prefix-size">${formatSize(p.bytes)}</span>
              <span class="stats-prefix-bar-col">
                <span class="stats-prefix-bar"><span class="stats-prefix-bar-fill" style="width:${share}%"></span></span>
              </span>
            </div>`;
        }).join('')}
      </div>`;

  const largestRows = (stats.largestObjects || []).slice(0, 10);
  const largestTable = largestRows.length === 0
    ? `<div class="stats-empty-sub">No objects in this bucket yet.</div>`
    : `
      <div class="stats-largest-table">
        ${largestRows.map((o) => `
          <div class="stats-largest-row">
            <span class="stats-largest-name" title="${escapeHtml(o.key)}">${escapeHtml(o.key)}</span>
            <span class="stats-largest-size">${formatSize(o.size)}</span>
            <span class="stats-largest-date">${o.lastModified ? new Date(o.lastModified).toLocaleString() : '—'}</span>
          </div>`).join('')}
      </div>`;

  container.innerHTML = `
    <div class="stats-cards">
      <div class="stats-card">
        <div class="stats-card-label">Total objects</div>
        <div class="stats-card-value">${stats.totalObjects.toLocaleString()}</div>
        <div class="stats-card-sub">${stats.totalFolders.toLocaleString()} folders</div>
      </div>
      <div class="stats-card">
        <div class="stats-card-label">Total size</div>
        <div class="stats-card-value">${formatSize(stats.totalBytes)}</div>
        <div class="stats-card-sub">${stats.totalBytes.toLocaleString()} bytes</div>
      </div>
      <div class="stats-card">
        <div class="stats-card-label">Items</div>
        <div class="stats-card-value">${totalItems.toLocaleString()}</div>
        <div class="stats-card-sub">objects + folders</div>
      </div>
      <div class="stats-card">
        <div class="stats-card-label">Scan</div>
        <div class="stats-card-value">${stats.pages.toLocaleString()} <span class="stats-card-unit">pages</span></div>
        <div class="stats-card-sub">${stats.scannedKeys.toLocaleString()} keys scanned</div>
      </div>
    </div>
    ${scanNote}
    <div class="stats-section">
      <div class="stats-section-title">Top-level prefixes</div>
      <div class="stats-section-sub">Aggregate size and object count grouped by the first folder segment.</div>
      ${prefixTable}
    </div>
    <div class="stats-section">
      <div class="stats-section-title">Largest objects</div>
      <div class="stats-section-sub">Up to 10 biggest keys in this bucket.</div>
      ${largestTable}
    </div>
    <div class="stats-info">
      <strong>Note:</strong> R2 does not expose storage-class or monthly request
      metrics over the S3-compatible API — view usage charts in the
      <a href="#" id="openCloudflareLink">Cloudflare dashboard</a>.
    </div>
  `;

  container.querySelectorAll('.stats-prefix-row[data-prefix]').forEach((row) => {
    if (row.classList.contains('stats-prefix-header')) return;
    row.addEventListener('click', () => {
      const prefix = row.getAttribute('data-prefix') || '';
      currentPrefix = prefix;
      setActiveTab('files');
      loadFiles();
      syncUploadPrefix();
    });
  });

  const cfLink = document.getElementById('openCloudflareLink');
  if (cfLink) {
    cfLink.addEventListener('click', (e) => {
      e.preventDefault();
      window.open('https://dash.cloudflare.com/?to=/:account/r2/overview', '_blank', 'noopener');
    });
  }
}
