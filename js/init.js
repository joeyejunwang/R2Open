/**
 * init.js – Initialize the app after all components and scripts are loaded
 */

async function initApp() {
  // Wait for both shell components to be in the DOM.
  await new Promise((resolve) => {
    let pending = 2;
    const done = () => { if (--pending === 0) resolve(); };
    onComponentReady('sidebar', () => {
      if (typeof bindSidebarEvents === 'function') bindSidebarEvents();
      done();
    });
    onComponentReady('main-view', () => {
      if (typeof bindBucketNav === 'function') bindBucketNav();
      if (typeof bindNavPills === 'function') bindNavPills();
      if (typeof bindSettingsPanel === 'function') bindSettingsPanel();
      done();
    });
  });

  const footerInfo = document.getElementById('footerInfo');
  const creds = await loadCredentials().catch((err) => {
    console.error('[init] Failed to load credentials:', err);
    return null;
  });

  if (creds && creds.savedAt) {
    if (footerInfo) {
      footerInfo.textContent = `Last saved: ${new Date(creds.savedAt).toLocaleString()}`;
    }
    if (typeof loadBuckets === 'function') loadBuckets();
  } else {
    const list = document.getElementById('bucketList');
    if (list) list.innerHTML = '';
    if (footerInfo) footerInfo.textContent = 'No saved credentials';
    if (typeof ensureSettingsReady === 'function') await ensureSettingsReady();
    if (typeof openSettings === 'function') openSettings();
  }

  window.addEventListener('r2:credentials-updated', () => {
    if (typeof clearBucketSelection === 'function') clearBucketSelection();
    if (typeof loadBuckets === 'function') loadBuckets();
  });
}

// Expose for cross-module use
window.__r2App = {
  loadBuckets: () => typeof loadBuckets === 'function' && loadBuckets(),
  selectBucket: (name) => typeof selectBucket === 'function' && selectBucket(name),
  clearBucketSelection: () => typeof clearBucketSelection === 'function' && clearBucketSelection(),
  loadBucketStats: () => typeof loadBucketStats === 'function' && loadBucketStats()
};

// Start when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
