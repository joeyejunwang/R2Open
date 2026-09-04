/**
 * configuration.js – Bucket local folder configuration
 */

let configurationCache = null;

async function loadBucketConfiguration() {
  if (!currentBucket) return;
  const container = document.getElementById('configurationContainer');
  if (!container) return;

  const bucketNameEl = document.getElementById('configurationBucketName');
  if (bucketNameEl) bucketNameEl.textContent = currentBucket;

  const statusEl = document.getElementById('configurationStatus');
  if (statusEl) statusEl.textContent = 'Loading…';

  try {
    const result = await window.r2Open.storage.loadBucketConfig(currentBucket);
    configurationCache = (result && result.config) || {};
    const path = configurationCache.localPath || '';

    const pathInput = document.getElementById('configurationPathInput');
    if (pathInput) pathInput.value = path;

    const clearBtn = document.getElementById('configurationClearBtn');
    if (clearBtn) clearBtn.disabled = !path;

    const saveBtn = document.getElementById('configurationSaveMappings');
    if (saveBtn) saveBtn.disabled = !path;

    if (statusEl) statusEl.textContent = path ? `Current: ${path}` : 'No local folder configured';
  } catch (err) {
    console.error('[configuration] Load failed:', err);
    if (statusEl) statusEl.textContent = 'Failed to load configuration';
  }
}

async function browseForFolder() {
  try {
    const result = await window.r2Open.dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Select local folder for this bucket',
    });
    if (result && result.ok && result.filePaths && result.filePaths.length > 0) {
      const path = result.filePaths[0];
      const pathInput = document.getElementById('configurationPathInput');
      if (pathInput) pathInput.value = path;

      const clearBtn = document.getElementById('configurationClearBtn');
      if (clearBtn) clearBtn.disabled = false;

      const saveBtn = document.getElementById('configurationSaveMappings');
      if (saveBtn) saveBtn.disabled = false;

      const statusEl = document.getElementById('configurationStatus');
      if (statusEl) statusEl.textContent = `Selected: ${path}`;
    }
  } catch (err) {
    console.error('[configuration] Browse failed:', err);
  }
}

function clearConfiguration() {
  const pathInput = document.getElementById('configurationPathInput');
  if (pathInput) pathInput.value = '';

  const clearBtn = document.getElementById('configurationClearBtn');
  if (clearBtn) clearBtn.disabled = true;

  const saveBtn = document.getElementById('configurationSaveMappings');
  if (saveBtn) saveBtn.disabled = false;

  const statusEl = document.getElementById('configurationStatus');
  if (statusEl) statusEl.textContent = 'Cleared — save to remove mapping';
}

async function saveConfiguration() {
  if (!currentBucket) return;

  const pathInput = document.getElementById('configurationPathInput');
  const path = pathInput ? pathInput.value.trim() : '';

  const statusEl = document.getElementById('configurationStatus');
  const saveBtn = document.getElementById('configurationSaveMappings');
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
  }

  try {
    const result = await window.r2Open.storage.saveBucketConfig(currentBucket, { localPath: path });
    if (result && result.ok) {
      configurationCache = { localPath: path };
      if (statusEl) statusEl.textContent = path ? `Saved: ${path}` : 'Mapping cleared';

      const clearBtn = document.getElementById('configurationClearBtn');
      if (clearBtn) clearBtn.disabled = !path;

      if (typeof showToast === 'function') showToast('Configuration saved', 'success');
    } else {
      throw new Error((result && result.error) || 'Unknown error');
    }
  } catch (err) {
    console.error('[configuration] Save failed:', err);
    if (statusEl) statusEl.textContent = `Error: ${err.message}`;
    if (typeof showToast === 'function') showToast('Failed to save configuration', 'error');
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
    }
  }
}

function bindConfigurationEvents() {
  const browseBtn = document.getElementById('configurationBrowseBtn');
  if (browseBtn) {
    browseBtn.addEventListener('click', browseForFolder);
  }

  const clearBtn = document.getElementById('configurationClearBtn');
  if (clearBtn) {
    clearBtn.addEventListener('click', clearConfiguration);
  }

  const saveBtn = document.getElementById('configurationSaveMappings');
  if (saveBtn) {
    saveBtn.addEventListener('click', saveConfiguration);
  }

  const pathInput = document.getElementById('configurationPathInput');
  if (pathInput) {
    pathInput.addEventListener('input', () => {
      const hasValue = pathInput.value.trim().length > 0;
      const clearBtn = document.getElementById('configurationClearBtn');
      if (clearBtn) clearBtn.disabled = !hasValue;
      const saveBtn = document.getElementById('configurationSaveMappings');
      if (saveBtn) saveBtn.disabled = false;
    });
  }
}

/* ── Init ── */
function initConfiguration() {
  onComponentReady('main-view', () => {
    bindConfigurationEvents();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initConfiguration);
} else {
  initConfiguration();
}
