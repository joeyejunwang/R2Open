const { app, BrowserWindow, Menu, protocol, net, ipcMain, dialog, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');
const { listBuckets, listObjects, getBucketStats, getObjectBytes, deleteObject, putObjectFromPath, putObjectFromBytes, existsSync } = require('./r2-client.js');
const Database = require('better-sqlite3');

try {
  require('electron-reloader')(module);
} catch {}
// Menu.setApplicationMenu(null);

// Register a custom protocol so fetch() can load local HTML components
// without hitting file:// CORS restrictions.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
]);

/**
 * Absolute path to the JSON config file.  Lives in the OS-specific
 * userData folder managed by Electron so it survives app updates.
 */
function getConfigPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

/* ── IPC: persist config to userData/config.json ── */
ipcMain.handle('config:load', async () => {
  try {
    const raw = await fs.promises.readFile(getConfigPath(), 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    console.error('[config] load failed:', err);
    return null;
  }
});

ipcMain.handle('config:save', async (_evt, payload) => {
  try {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, error: 'Invalid payload' };
    }
    const filePath = getConfigPath();
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
    return { ok: true, path: filePath };
  } catch (err) {
    console.error('[config] save failed:', err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('config:clear', async () => {
  try {
    await fs.promises.unlink(getConfigPath());
    return { ok: true };
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: true };
    console.error('[config] clear failed:', err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('config:path', async () => getConfigPath());

/* ── IPC: Bucket Local Folder Config ── */
ipcMain.handle('storage:loadBucketConfig', async (_evt, { bucket }) => {
  try {
    const raw = await fs.promises.readFile(getConfigPath(), 'utf8').catch(() => '{}');
    const config = JSON.parse(raw);
    console.log('[storage:loadBucketConfig] bucket:', bucket, 'bucketMappings:', config.bucketMappings);
    const localPath = config && config.bucketMappings ? config.bucketMappings[bucket] : null;
    return { ok: true, config: localPath ? { localPath } : null };
  } catch (err) {
    console.error('[storage] loadBucketConfig failed:', err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('storage:saveBucketConfig', async (_evt, { bucket, localPath }) => {
  try {
    const raw = await fs.promises.readFile(getConfigPath(), 'utf8').catch(() => '{}');
    const config = JSON.parse(raw);
    if (!config.bucketMappings) config.bucketMappings = {};
    if (localPath) {
      config.bucketMappings[bucket] = localPath;
    } else {
      delete config.bucketMappings[bucket];
    }
    await fs.promises.writeFile(getConfigPath(), JSON.stringify(config, null, 2), 'utf8');
    return { ok: true };
  } catch (err) {
    console.error('[storage] saveBucketConfig failed:', err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('dialog:showOpen', async (_evt, options) => {
  const result = await dialog.showOpenDialog({ ...options });
  return { ok: true, ...result };
});

/* ── SQLite: Transfer History Database ── */
let db;

function getDbPath() {
  return path.join(app.getPath('userData'), 'transfers.db');
}

function initDb() {
  const dbPath = getDbPath();
  console.log('[db] opening:', dbPath);
  db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS transfers (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      type        TEXT NOT NULL,
      key         TEXT NOT NULL,
      bucket      TEXT NOT NULL,
      size        INTEGER DEFAULT 0,
      status      TEXT NOT NULL,
      error       TEXT,
      timestamp   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_transfers_timestamp ON transfers(timestamp DESC);
  `);
  console.log('[db] ready');
}

// Called from app.on('ready', ...) or on first use
function ensureDb() {
  if (!db) initDb();
}

/* ── IPC: Transfer records ── */
ipcMain.handle('transfer:add', async (_evt, { type, key, bucket, size, status, error }) => {
  ensureDb();
  try {
    const stmt = db.prepare(`
      INSERT INTO transfers (type, key, bucket, size, status, error, timestamp)
      VALUES (@type, @key, @bucket, @size, @status, @error, @timestamp)
    `);
    const result = stmt.run({
      type, key, bucket, size: size || 0, status, error: error || null, timestamp: new Date().toISOString()
    });
    return { ok: true, id: result.lastInsertRowid };
  } catch (err) {
    console.error('[db] transfer:add failed:', err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('transfer:list', async (_evt, { limit = 200, offset = 0 } = {}) => {
  ensureDb();
  try {
    const stmt = db.prepare('SELECT * FROM transfers ORDER BY timestamp DESC LIMIT ? OFFSET ?');
    const rows = stmt.all(limit, offset);
    return { ok: true, items: rows };
  } catch (err) {
    console.error('[db] transfer:list failed:', err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('transfer:clear', async () => {
  ensureDb();
  try {
    db.exec('DELETE FROM transfers');
    return { ok: true };
  } catch (err) {
    console.error('[db] transfer:clear failed:', err);
    return { ok: false, error: err.message };
  }
});

/* ── IPC: native folder picker (for bucket → local path mapping) ── */
ipcMain.handle('fs:pickFolder', async (evt, { defaultPath } = {}) => {
  try {
    const win = BrowserWindow.fromWebContents(evt.sender);
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose local folder',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: defaultPath || undefined,
    });
    if (res.canceled || !res.filePaths || res.filePaths.length === 0) {
      return { ok: true, canceled: true, path: null };
    }
    return { ok: true, canceled: false, path: res.filePaths[0] };
  } catch (err) {
    console.error('[fs] pickFolder failed:', err);
    return { ok: false, error: err.message || String(err) };
  }
});

/* ── IPC: pick one or more local files (Upload → Browse files) ── */
ipcMain.handle('fs:pickFiles', async (evt, { defaultPath, multiSelections } = {}) => {
  try {
    const win = BrowserWindow.fromWebContents(evt.sender);
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose files',
      properties: multiSelections ? ['openFile', 'multiSelections'] : ['openFile'],
      defaultPath: defaultPath || undefined,
    });
    if (res.canceled || !res.filePaths || res.filePaths.length === 0) {
      return { ok: true, canceled: true, paths: [], files: [] };
    }
    const files = res.filePaths.map((p) => describePath(p)).filter(Boolean);
    return { ok: true, canceled: false, paths: res.filePaths, files };
  } catch (err) {
    console.error('[fs] pickFiles failed:', err);
    return { ok: false, error: err.message || String(err) };
  }
});

/* ── IPC: pick one or more folders (Upload → Choose folder) ── */
ipcMain.handle('fs:pickFolders', async (evt, { defaultPath } = {}) => {
  try {
    const win = BrowserWindow.fromWebContents(evt.sender);
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose folders',
      properties: ['openDirectory', 'createDirectory', 'multiSelections'],
      defaultPath: defaultPath || undefined,
    });
    if (res.canceled || !res.filePaths || res.filePaths.length === 0) {
      return { ok: true, canceled: true, paths: [], files: [] };
    }
    const files = res.filePaths
      .filter((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } })
      .map((p) => ({ absPath: p, name: path.basename(p), isDirectory: true }));
    return { ok: true, canceled: false, paths: res.filePaths, files };
  } catch (err) {
    console.error('[fs] pickFolders failed:', err);
    return { ok: false, error: err.message || String(err) };
  }
});

/* ── IPC: list every file under one or more root paths (recursive) ── */
ipcMain.handle('fs:walkPaths', async (_evt, { paths } = {}) => {
  const results = [];
  const errors = [];
  if (!Array.isArray(paths)) return { ok: false, error: 'paths must be an array', files: [] };
  for (const root of paths) {
    try {
      const stat = fs.statSync(root);
      if (stat.isDirectory()) {
        walkRecursive(root, root, results);
      } else if (stat.isFile()) {
        results.push({
          absPath: root,
          relPath: path.basename(root),
          rootPath: path.dirname(root),
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        });
      } else {
        errors.push({ path: root, error: 'Not a file or directory' });
      }
    } catch (err) {
      errors.push({ path: root, error: err.message || String(err) });
    }
  }
  return { ok: true, files: results, errors };
});

function describePath(p) {
  // Helper used by fs:pickFiles to give the renderer the same shape it
  // already gets back from fs:walkPaths (absPath + name + size + mtimeMs).
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return null;
    return {
      absPath: p,
      name: path.basename(p),
      size: st.size,
      mtimeMs: st.mtimeMs,
    };
  } catch (err) {
    console.warn('[fs] describePath failed for', p, err.message);
    return null;
  }
}

function walkRecursive(absPath, rootPath, out) {
  // Add the current directory itself so the UI can render the folder node
  out.push({
    absPath,
    relPath: path.relative(rootPath, absPath) || path.basename(absPath),
    rootPath,
    size: 0,
    mtimeMs: 0,
    kind: 'folder',
  });
  let entries;
  try {
    entries = fs.readdirSync(absPath, { withFileTypes: true });
  } catch (err) {
    out.push({
      absPath,
      relPath: path.relative(rootPath, absPath) || path.basename(absPath),
      rootPath,
      size: 0,
      mtimeMs: 0,
      error: err.message || String(err),
    });
    return;
  }
  for (const entry of entries) {
    const child = path.join(absPath, entry.name);
    try {
      if (entry.isDirectory()) {
        walkRecursive(child, rootPath, out);
      } else if (entry.isFile()) {
        const st = fs.statSync(child);
        out.push({
          absPath: child,
          relPath: path.relative(rootPath, child).split(path.sep).join('/'),
          rootPath,
          size: st.size,
          mtimeMs: st.mtimeMs,
        });
      }
    } catch (err) {
      out.push({
        absPath: child,
        relPath: path.relative(rootPath, child).split(path.sep).join('/'),
        rootPath,
        size: 0,
        mtimeMs: 0,
        error: err.message || String(err),
      });
    }
  }
}

/* ── IPC: read a local file's bytes (used to upload dropped files) ── */
ipcMain.handle('fs:readFile', async (_evt, { path: p } = {}) => {
  if (!p) return { ok: false, error: 'path is required', code: 'BAD_REQUEST' };
  try {
    const buf = await fs.promises.readFile(p);
    return { ok: true, bytes: buf, size: buf.length };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

/* ── IPC: write a Buffer to a temp path and return it (used for URL/clipboard bytes) ── */
ipcMain.handle('fs:writeTemp', async (_evt, { bytes, name } = {}) => {
  if (!bytes) return { ok: false, error: 'bytes is required', code: 'BAD_REQUEST' };
  try {
    const tmpDir = os.tmpdir();
    const safeName = (name || `r2open-${Date.now()}`).replace(/[\\/:*?"<>|]/g, '_');
    const fullPath = path.join(tmpDir, `r2open-${Date.now()}-${safeName}`);
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    await fs.promises.writeFile(fullPath, buf);
    return { ok: true, path: fullPath, size: buf.length };
  } catch (err) {
    console.error('[fs] writeTemp failed:', err);
    return { ok: false, error: err.message || String(err) };
  }
});

/* ── IPC: native clipboard read/write ── */
ipcMain.handle('clipboard:readText', async () => {
  try {
    return { ok: true, text: clipboard.readText() || '' };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});
ipcMain.handle('clipboard:writeText', async (_evt, { text } = {}) => {
  try {
    clipboard.writeText(typeof text === 'string' ? text : '');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

/* ── IPC: fetch a remote URL to memory (Upload → Add URL) ── */
ipcMain.handle('url:fetch', async (_evt, { url } = {}) => {
  if (!url) return { ok: false, error: 'url is required', code: 'BAD_REQUEST' };
  try {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, error: 'Invalid URL', code: 'BAD_URL' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, error: 'Only http(s) URLs are supported', code: 'BAD_URL' };
    }
    const res = await net.fetch(parsed.toString());
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status} ${res.statusText || ''}`.trim(), code: 'HTTP_ERROR' };
    }
    const ab = await res.arrayBuffer();
    const buf = Buffer.from(ab);
    const fileName = path.basename(parsed.pathname) || `url-${Date.now()}`;
    const contentType = res.headers.get('content-type') || '';
    return { ok: true, bytes: buf, size: buf.length, fileName, contentType };
  } catch (err) {
    console.error('[url] fetch failed:', err);
    return { ok: false, error: err.message || String(err) };
  }
});

/* ── Helpers ── */
async function loadCreds() {
  try {
    return await fs.promises.readFile(getConfigPath(), 'utf8')
      .then((raw) => JSON.parse(raw));
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

/* ── IPC: talk to Cloudflare R2 ── */
ipcMain.handle('r2:listBuckets', async () => {
  try {
    const creds = await loadCreds();
    if (!creds) {
      return { ok: false, error: 'No saved credentials', code: 'NO_CREDS' };
    }
    const { buckets, owner } = await listBuckets(creds);
    return { ok: true, buckets, owner };
  } catch (err) {
    console.error('[r2] listBuckets failed:', err);
    return {
      ok: false,
      status: err.status || null,
      code: err.code || 'UNKNOWN',
      error: err.message || String(err),
    };
  }
});

/* ── IPC: list objects within a specific bucket ── */
ipcMain.handle('r2:listObjects', async (_evt, { bucket, prefix, maxKeys, continuationToken } = {}) => {
  if (!bucket) {
    return { ok: false, error: 'Bucket name is required', code: 'BAD_REQUEST' };
  }
  try {
    const creds = await loadCreds();
    if (!creds) {
      return { ok: false, error: 'No saved credentials', code: 'NO_CREDS' };
    }
    const result = await listObjects(creds, bucket, prefix || '', maxKeys || 1000, continuationToken || null);
    return { ok: true, ...result };
  } catch (err) {
    console.error('[r2] listObjects failed:', err);
    return {
      ok: false,
      status: err.status || null,
      code: err.code || 'UNKNOWN',
      error: err.message || String(err),
    };
  }
});

/* ── IPC: bucket statistics (object count, size, top prefixes) ── */
ipcMain.handle('r2:bucketStats', async (_evt, { bucket, options } = {}) => {
  if (!bucket) {
    return { ok: false, error: 'Bucket name is required', code: 'BAD_REQUEST' };
  }
  try {
    const creds = await loadCreds();
    if (!creds) {
      return { ok: false, error: 'No saved credentials', code: 'NO_CREDS' };
    }
    const result = await getBucketStats(creds, bucket, options || {});
    return { ok: true, stats: result };
  } catch (err) {
    console.error('[r2] bucketStats failed:', err);
    return {
      ok: false,
      status: err.status || null,
      code: err.code || 'UNKNOWN',
      error: err.message || String(err),
    };
  }
});

/* ── IPC: download a single object as raw bytes (for the Files tab) ── */
ipcMain.handle('r2:getObject', async (_evt, { bucket, key } = {}) => {
  if (!bucket || !key) {
    return { ok: false, error: 'bucket and key are required', code: 'BAD_REQUEST' };
  }
  try {
    const creds = await loadCreds();
    if (!creds) return { ok: false, error: 'No saved credentials', code: 'NO_CREDS' };
    const bytes = await getObjectBytes(creds, bucket, key);
    // Return as Uint8Array-friendly object so the renderer can wrap in Blob.
    return { ok: true, bytes, size: bytes.length };
  } catch (err) {
    console.error('[r2] getObject failed:', err);
    return {
      ok: false,
      status: err.status || null,
      code: err.code || 'UNKNOWN',
      error: err.message || String(err),
    };
  }
});

/* ── IPC: delete a single object (for the Files tab) ── */
ipcMain.handle('r2:deleteObject', async (_evt, { bucket, key } = {}) => {
  if (!bucket || !key) {
    return { ok: false, error: 'bucket and key are required', code: 'BAD_REQUEST' };
  }
  try {
    const creds = await loadCreds();
    if (!creds) return { ok: false, error: 'No saved credentials', code: 'NO_CREDS' };
    await deleteObject(creds, bucket, key);
    return { ok: true };
  } catch (err) {
    console.error('[r2] deleteObject failed:', err);
    return {
      ok: false,
      status: err.status || null,
      code: err.code || 'UNKNOWN',
      error: err.message || String(err),
    };
  }
});

/* ── IPC: upload a local file to a specific key (for Sync) ── */
ipcMain.handle('r2:putObjectFromPath', async (_evt, { bucket, key, localPath } = {}) => {
  if (!bucket || !key || !localPath) {
    return { ok: false, error: 'bucket, key and localPath are required', code: 'BAD_REQUEST' };
  }
  try {
    if (!fs.existsSync(localPath)) {
      return { ok: false, error: `Local file not found: ${localPath}`, code: 'NOT_FOUND' };
    }
    const creds = await loadCreds();
    if (!creds) return { ok: false, error: 'No saved credentials', code: 'NO_CREDS' };
    const res = await putObjectFromPath(creds, bucket, key, localPath);
    return { ok: true, ...res };
  } catch (err) {
    console.error('[r2] putObjectFromPath failed:', err);
    return {
      ok: false,
      status: err.status || null,
      code: err.code || 'UNKNOWN',
      error: err.message || String(err),
    };
  }
});

/* ── IPC: upload raw bytes (Buffer / Uint8Array) to a specific key (for URL/clipboard) ── */
ipcMain.handle('r2:putObjectFromBytes', async (_evt, { bucket, key, bytes, contentType } = {}) => {
  if (!bucket || !key) {
    return { ok: false, error: 'bucket and key are required', code: 'BAD_REQUEST' };
  }
  if (!bytes) {
    return { ok: false, error: 'bytes is required', code: 'BAD_REQUEST' };
  }
  try {
    const creds = await loadCreds();
    if (!creds) return { ok: false, error: 'No saved credentials', code: 'NO_CREDS' };
    const res = await putObjectFromBytes(creds, bucket, key, bytes, contentType);
    return { ok: true, ...res };
  } catch (err) {
    console.error('[r2] putObjectFromBytes failed:', err);
    return {
      ok: false,
      status: err.status || null,
      code: err.code || 'UNKNOWN',
      error: err.message || String(err),
    };
  }
});

/* ── IPC: dialog.showSaveDialog → user picks where to save an object ── */
ipcMain.handle('fs:savePath', async (evt, { defaultPath } = {}) => {
  try {
    const win = BrowserWindow.fromWebContents(evt.sender);
    const res = await dialog.showSaveDialog(win, {
      title: 'Save file as',
      defaultPath: defaultPath || undefined,
    });
    if (res.canceled || !res.filePath) {
      return { ok: true, canceled: true, path: null };
    }
    return { ok: true, canceled: false, path: res.filePath };
  } catch (err) {
    console.error('[fs] savePath failed:', err);
    return { ok: false, error: err.message || String(err) };
  }
});

/* ── IPC: write bytes to a path on disk (used after Save dialog) ── */
ipcMain.handle('fs:writeFile', async (_evt, { path: dest, bytes } = {}) => {
  if (!dest) return { ok: false, error: 'path is required', code: 'BAD_REQUEST' };
  try {
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.writeFile(dest, Buffer.from(bytes || []));
    return { ok: true, path: dest };
  } catch (err) {
    console.error('[fs] writeFile failed:', err);
    return { ok: false, error: err.message || String(err) };
  }
});

/* ── IPC: open a local file with the OS default application (Preview) ── */
ipcMain.handle('fs:openExternal', async (_evt, { path: filePath } = {}) => {
  if (!filePath) return { ok: false, error: 'path is required', code: 'BAD_REQUEST' };
  try {
    const errMsg = await shell.openPath(filePath);
    if (errMsg) return { ok: false, error: errMsg };
    return { ok: true, path: filePath };
  } catch (err) {
    console.error('[fs] openExternal failed:', err);
    return { ok: false, error: err.message || String(err) };
  }
});

/* ── IPC: path.join and os.tmpdir for the renderer ── */
ipcMain.handle('fsUtil:join', (_evt, { segments }) => {
  return path.join(...(segments || []));
});
ipcMain.handle('fsUtil:tmpdir', () => os.tmpdir());
ipcMain.handle('fsUtil:exists', (_evt, { path: p }) => {
  try {
    const direct = path.resolve(p || '');
    // Try direct existence check first
    try {
      fs.accessSync(direct, fs.constants.R_OK);
      return true;
    } catch {}
    // Fall back to stat (catches symlinks, junctions, permission-edge cases)
    try {
      const stat = fs.statSync(direct);
      return stat.isFile() || stat.isCharacterDevice();
    } catch {
      return false;
    }
  } catch (err) {
    console.error('[fsUtil:exists]', err);
    return false;
  }
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    }
  });

  win.loadFile('index.html');
}

app.whenReady().then(() => {
  // Handle requests to app://./<path> by reading the file from disk and
  // streaming it back with the correct MIME type.  This is what lets the
  // renderer fetch component partials like settings-modal.html.
  protocol.handle('app', async (request) => {
    try {
      const url = new URL(request.url);
      // url.pathname starts with '/./' (see the form used by components.js)
      let relativePath = decodeURIComponent(url.pathname);
      if (relativePath.startsWith('/./')) {
        relativePath = relativePath.slice(2);
      } else if (relativePath.startsWith('/')) {
        relativePath = relativePath.slice(1);
      }
      const filePath = path.join(__dirname, relativePath);
      return await net.fetch(pathToFileURL(filePath).toString());
    } catch (err) {
      console.error('[protocol] Failed to serve', request.url, err);
      return new Response('Not found', { status: 404 });
    }
  });

  initDb();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
