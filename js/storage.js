/**
 * storage.js – Disk-backed config persistence
 *
 * Reads and writes R2 credentials to userData/config.json via the
 * main process (see main.js → ipcMain handlers).  The preload exposes
 * the API on window.r2Open.config.
 */

const FILENAME = 'config.json';

/**
 * @typedef {Object} R2Credentials
 * @property {string} accountId
 * @property {string} accessKeyId
 * @property {string} secretAccessKey
 * @property {string} endpoint
 * @property {string} savedAt  ISO date string
 */

/** @returns {Promise<{ok:true, path:string}|{ok:false, error:string}>} */
async function saveCredentials(creds) {
  return window.r2Open.config.save(creds);
}

/** @returns {Promise<R2Credentials|null>} */
async function loadCredentials() {
  return window.r2Open.config.load();
}

/** @returns {Promise<{ok:true}|{ok:false, error:string}>} */
async function clearCredentials() {
  return window.r2Open.config.clear();
}

/** @returns {Promise<boolean>} */
async function hasCredentials() {
  const creds = await loadCredentials();
  return creds !== null;
}

/** @returns {Promise<string>} absolute path to the config file */
async function getConfigPath() {
  return window.r2Open.config.path();
}
