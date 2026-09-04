/**
 * settings.js – Settings modal controller
 *
 * The modal HTML lives in components/settings-modal.html.  We mount it
 * into #settingsModalContainer the first time the user opens Settings
 * and bind its events right after.
 */

let toastTimer = null;

/* ── Toast ── */

/**
 * Show a toast notification in the bottom-right corner.
 * @param {string} message
 * @param {'success'|'error'} type
 */
function showToast(message, type = 'success') {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.className = 'toast show ' + type;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.className = 'toast'; }, 2400);
}

/* ── Modal open / close ── */

function openSettings() {
  const modal = document.getElementById('settingsModal');
  if (!modal) return;
  loadSettingsIntoDOM();
  clearErrors();
  modal.classList.add('open');
  const firstInput = document.getElementById('accountId');
  if (firstInput) setTimeout(() => firstInput.focus(), 50);
}

function closeSettings() {
  const modal = document.getElementById('settingsModal');
  if (!modal) return;
  modal.classList.remove('open');
  clearErrors();
  const testStatus = document.getElementById('testStatus');
  if (testStatus) {
    testStatus.className = 'test-status';
    testStatus.textContent = '';
  }
}

/* ── Field helpers ── */

function clearErrors() {
  ['accountId', 'accessKeyId', 'secretAccessKey'].forEach((id) => {
    const input = document.getElementById(id);
    if (input) input.classList.remove('error');
    const err = document.getElementById(id + 'Error');
    if (err) err.classList.remove('show');
  });
}

function getField(id) {
  return document.getElementById(id);
}

function setError(id, show) {
  const input = document.getElementById(id);
  if (input) input.classList.toggle('error', show);
  const err = document.getElementById(id + 'Error');
  if (err) err.classList.toggle('show', show);
}

/* ── Populate DOM from stored credentials ── */

async function loadSettingsIntoDOM() {
  const footerInfo = document.getElementById('footerInfo');
  const creds = await loadCredentials();

  getField('accountId').value = creds ? (creds.accountId || '') : '';
  getField('accessKeyId').value = creds ? (creds.accessKeyId || '') : '';
  getField('secretAccessKey').value = creds ? (creds.secretAccessKey || '') : '';

  const accId = getField('accountId').value.trim();
  getField('endpoint').value = accId
    ? `https://${accId}.r2.cloudflarestorage.com`
    : '';

  if (footerInfo) {
    footerInfo.textContent = creds && creds.savedAt
      ? `Last saved: ${new Date(creds.savedAt).toLocaleString()}`
      : 'No saved credentials';
  }
}

/* ── Save ── */

async function saveSettings() {
  clearErrors();

  const accountId = getField('accountId').value.trim();
  const accessKeyId = getField('accessKeyId').value.trim();
  const secretAccessKey = getField('secretAccessKey').value.trim();

  let valid = true;
  if (!accountId)         { setError('accountId', true);         valid = false; }
  if (!accessKeyId)       { setError('accessKeyId', true);       valid = false; }
  if (!secretAccessKey)   { setError('secretAccessKey', true);   valid = false; }

  if (!valid) {
    showToast('Please fix the highlighted fields', 'error');
    return;
  }

  const creds = {
    accountId,
    accessKeyId,
    secretAccessKey,
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    savedAt: new Date().toISOString(),
  };

  const saveBtn = getField('saveSettings');
  const originalText = saveBtn ? saveBtn.textContent : '';
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
  }

  try {
    const result = await saveCredentials(creds);
    if (!result || result.ok !== true) {
      throw new Error((result && result.error) || 'Unknown error');
    }
    showToast('Settings saved successfully', 'success');

    // Tell the rest of the app the credentials changed and trigger a
    // refresh of any data views (e.g. the bucket list).
    window.dispatchEvent(new CustomEvent('r2:credentials-updated', { detail: creds }));
    if (window.__r2App && typeof window.__r2App.loadBuckets === 'function') {
      window.__r2App.loadBuckets();
    }
    const footerInfo = document.getElementById('footerInfo');
    if (footerInfo) {
      footerInfo.textContent = `Last saved: ${new Date(creds.savedAt).toLocaleString()}`;
    }
    setTimeout(closeSettings, 600);
  } catch (err) {
    console.error('[settings] Save failed:', err);
    showToast('Failed to save settings', 'error');
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = originalText || 'Save';
    }
  }
}

/* ── Clear ── */

async function clearSettings() {
  if (!confirm('Clear all saved Cloudflare credentials?')) return;
  try {
    await clearCredentials();
    getField('accountId').value = '';
    getField('accessKeyId').value = '';
    getField('secretAccessKey').value = '';
    getField('endpoint').value = '';
    const footerInfo = document.getElementById('footerInfo');
    if (footerInfo) footerInfo.textContent = 'No saved credentials';
    showToast('Settings cleared', 'success');
  } catch (err) {
    console.error('[settings] Clear failed:', err);
    showToast('Failed to clear settings', 'error');
  }
}

/* ── Test connection ── */

function testConnection() {
  const testStatus = document.getElementById('testStatus');
  if (!testStatus) return;

  const accountId = getField('accountId').value.trim();
  const accessKeyId = getField('accessKeyId').value.trim();
  const secretAccessKey = getField('secretAccessKey').value.trim();

  testStatus.className = 'test-status';
  testStatus.textContent = '';

  if (!accountId || !accessKeyId || !secretAccessKey) {
    testStatus.className = 'test-status show error';
    testStatus.textContent = '✗ Fill in all fields before testing';
    return;
  }

  const looksValid =
    accountId.length >= 16 &&
    accessKeyId.length >= 10 &&
    secretAccessKey.length >= 20;

  testStatus.className = 'test-status show ' + (looksValid ? 'success' : 'error');
  testStatus.textContent = looksValid
    ? '✓ Credentials format looks valid. Real network verification will run during uploads.'
    : '✗ One or more fields do not match expected length/format';
}

/* ── Modal event binding (called once after the modal is mounted) ── */

function bindSettingsModalEvents() {
  const modal = document.getElementById('settingsModal');

  // Close via ×, Cancel, backdrop
  const closeBtn = document.getElementById('closeSettings');
  if (closeBtn) closeBtn.addEventListener('click', closeSettings);

  const cancelBtn = document.getElementById('cancelSettings');
  if (cancelBtn) cancelBtn.addEventListener('click', closeSettings);

  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeSettings();
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal && modal.classList.contains('open')) {
      closeSettings();
    }
  });

  // Auto-fill endpoint from Account ID
  const accountIdInput = document.getElementById('accountId');
  if (accountIdInput) {
    accountIdInput.addEventListener('input', () => {
      const endpointInput = document.getElementById('endpoint');
      if (endpointInput) {
        endpointInput.value = accountIdInput.value.trim()
          ? `https://${accountIdInput.value.trim()}.r2.cloudflarestorage.com`
          : '';
      }
    });
  }

  // Toggle secret visibility
  const toggleSecretBtn = document.getElementById('toggleSecret');
  const secretKeyInput = document.getElementById('secretAccessKey');
  if (toggleSecretBtn && secretKeyInput) {
    toggleSecretBtn.addEventListener('click', () => {
      secretKeyInput.type = secretKeyInput.type === 'password' ? 'text' : 'password';
      toggleSecretBtn.textContent = secretKeyInput.type === 'password' ? '👁' : '🙈';
    });
  }

  // Clear field errors on input
  ['accountId', 'accessKeyId', 'secretAccessKey'].forEach((id) => {
    const input = document.getElementById(id);
    if (input) {
      input.addEventListener('input', () => setError(id, false));
    }
  });

  // Save / Clear / Test
  const saveBtn = document.getElementById('saveSettings');
  if (saveBtn) saveBtn.addEventListener('click', saveSettings);

  const clearBtn = document.getElementById('clearSettings');
  if (clearBtn) clearBtn.addEventListener('click', clearSettings);

  const testBtn = document.getElementById('testConnection');
  if (testBtn) testBtn.addEventListener('click', testConnection);

  // Initialize footer text from stored credentials
  const footerInfo = document.getElementById('footerInfo');
  if (footerInfo) footerInfo.textContent = 'No saved credentials';
  loadCredentials().then((creds) => {
    if (!footerInfo) return;
    footerInfo.textContent = creds && creds.savedAt
      ? `Last saved: ${new Date(creds.savedAt).toLocaleString()}`
      : 'No saved credentials';
  }).catch((err) => {
    console.error('[settings] Failed to load credentials on init:', err);
  });
}

/* ── Public helper: make sure the settings modal is mounted & wired ──
 *
 * Used by both the sidebar gear button and the cold-start flow in
 * renderer.js when no credentials exist yet.
 */
async function ensureSettingsReady() {
  const container = document.getElementById('settingsModalContainer');
  if (!container) return false;
  if (!container.querySelector('#settingsModal')) {
    await loadComponent('settingsModalContainer', 'settings-modal');
    bindSettingsModalEvents();
  }
  return true;
}

/* ── Alias for nav.js ── */
async function loadSettingsPanel() {
  await ensureSettingsReady();
  openSettings();
}

/* ── Init ──
 *
 * The settings button lives inside the sidebar component, which is mounted
 * asynchronously by js/components.js.  We wait for that component before
 * wiring the open-button click.
 */

function initSettings() {
  onComponentReady('sidebar', () => {
    const settingsBtn = document.querySelector('.settings-btn');
    if (!settingsBtn) return;
    settingsBtn.addEventListener('click', async () => {
      await ensureSettingsReady();
      openSettings();
    });
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSettings);
} else {
  initSettings();
}
