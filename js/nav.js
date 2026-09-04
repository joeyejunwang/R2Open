/**
 * nav.js – Navigation: tabs, sidebar events, new bucket modal
 */

/* ── Tab switching ── */
function setActiveTab(tab) {
  const pills = document.querySelectorAll('#bucketNavPills .nav-pill');
  pills.forEach((p) => p.classList.toggle('active', p.getAttribute('data-tab') === tab));
  document.querySelectorAll('.bucket-panel').forEach((panel) => {
    panel.hidden = panel.getAttribute('data-panel') !== tab;
  });
}

function bindBucketNav() {
  const container = document.getElementById('bucketNavPills');
  if (!container) return;
  container.addEventListener('click', (e) => {
    const pill = e.target.closest('.nav-pill');
    if (!pill) return;
    const tab = pill.getAttribute('data-tab');
    if (!tab) return;
    setActiveTab(tab);
    if (tab === 'files') loadFiles();
    if (tab === 'transfer') loadTransferList();
    if (tab === 'statistics') loadBucketStats();
    if (tab === 'configuration') loadBucketConfiguration();
  });

  const refreshBtn = document.getElementById('refreshBucket');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      if (!currentBucket) return;
      loadFiles();
    });
  }

  const search = document.getElementById('filesSearch');
  if (search) {
    search.addEventListener('input', () => renderFilesTable(filesCache, search.value));
  }
}

function bindNavPills() {
  document.querySelectorAll('.nav-pill').forEach((pill) => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.nav-pill').forEach((p) => p.classList.remove('active'));
      pill.classList.add('active');
    });
  });
}

/* ── Sidebar events ── */
function bindSidebarEvents() {
  const addBtn = document.getElementById('addBucketBtn');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      ensureNewBucketReady().then(() => openNewBucket());
    });
  }

  const settingsBtn = document.querySelector('.settings-btn');
  if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
      ensureSettingsReady().then(() => openSettings());
    });
  }
}

/* ── New Bucket Modal ── */
async function ensureNewBucketReady() {
  const container = document.getElementById('newBucketModalContainer');
  if (!container) return false;
  if (!container.querySelector('#newBucketModal')) {
    await loadComponent('newBucketModalContainer', 'new-bucket-modal');
    bindNewBucketModalEvents();
  }
  return true;
}

function openNewBucket() {
  const modal = document.getElementById('newBucketModal');
  if (!modal) return;
  modal.classList.add('open');
}

function closeNewBucket() {
  const modal = document.getElementById('newBucketModal');
  if (!modal) return;
  modal.classList.remove('open');
}

function bindNewBucketModalEvents() {
  const modal = document.getElementById('newBucketModal');
  const closeBtn = document.getElementById('closeNewBucket');
  const cancelBtn = document.getElementById('cancelNewBucket');
  const openCFBtn = document.getElementById('openCloudflareBtn');
  const refreshBtn = document.getElementById('refreshBuckets');

  if (closeBtn) closeBtn.addEventListener('click', closeNewBucket);
  if (cancelBtn) cancelBtn.addEventListener('click', closeNewBucket);
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeNewBucket();
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal && modal.classList.contains('open')) {
      closeNewBucket();
    }
  });

  if (openCFBtn) {
    openCFBtn.addEventListener('click', () => {
      window.open('https://dash.cloudflare.com/?to=/:account/r2/overview', '_blank', 'noopener');
    });
  }

  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      closeNewBucket();
      loadBuckets();
    });
  }
}
