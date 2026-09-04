/**
 * core.js – Shared constants, state, and utility functions
 */

const lockIconPrivate = '<svg width="10" height="10" fill="currentColor" viewBox="0 0 24 24"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/></svg>';
const lockIconPublic  = '<svg width="10" height="10" fill="currentColor" viewBox="0 0 24 24"><path d="M12 17c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm6-9h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zM8.9 6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2H8.9V6z"/></svg>';

/* ── Selected bucket state ── */
let currentBucket = null;
let currentPrefix = '';
let filesCache = [];

/* ── Selection state ── */
const selectedKeys = new Set();

/* ── Utility functions ── */
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function formatSize(bytes) {
  if (typeof bytes !== 'number' || bytes < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

async function pathJoin(...parts) {
  return await window.r2Open.fsUtil.join(parts);
}

async function getTmpDir() {
  return await window.r2Open.fsUtil.tmpdir();
}

/* ── Local mapping helpers ── */
function getBucketMappings() {
  return window.r2Open.config.load().then((cfg) => {
    if (cfg && typeof cfg.bucketMappings === 'object') return cfg.bucketMappings;
    return {};
  }).catch(() => ({}));
}

function getLocalMapping(bucket) {
  return getBucketMappings().then((m) => (typeof m[bucket] === 'string' ? m[bucket] : null));
}

async function getLocalMappingWithTimeout(bucket, timeoutMs = 5000) {
  const startTime = Date.now();
  try {
    const result = await Promise.race([
      getLocalMapping(bucket),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs))
    ]);
    return result;
  } catch (e) {
    const elapsed = Date.now() - startTime;
    console.warn(`[getLocalMappingWithTimeout] ${elapsed >= timeoutMs ? 'timeout' : 'error'}:`, e && e.message);
    return null;
  }
}

function setRowBusy(row, busy) {
  row.querySelectorAll('.file-action-btn').forEach((btn) => { btn.disabled = !!busy; });
}
