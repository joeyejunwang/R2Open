/**
 * components.js – Component loader
 *
 * Loads HTML partials into placeholder containers in index.html and exposes
 * a registry of "components ready" callbacks so other modules can defer
 * their event binding until the relevant DOM is in place.
 *
 * The fetch() calls go through the custom `app://` protocol registered in
 * main.js, which sidesteps file:// CORS restrictions in Electron.
 */

const COMPONENT_BASE = 'app://./components/';

/** @type {Map<string, HTMLElement>} */
const componentElements = new Map();

/** @type {Map<string, Set<Function>>} */
const readyCallbacks = new Map();

/**
 * Fetch a component HTML file and inject it into a container element.
 * @param {string} id  container element id from index.html
 * @param {string} name  component file name (without extension)
 */
async function loadComponent(id, name) {
  const container = document.getElementById(id);
  if (!container) {
    console.error(`[components] Container #${id} not found`);
    return;
  }
  try {
    const res = await fetch(COMPONENT_BASE + name + '.html');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    container.innerHTML = await res.text();
    componentElements.set(name, container);
    // Notify any listeners that were waiting for this component.
    const cbs = readyCallbacks.get(name);
    if (cbs) {
      cbs.forEach((cb) => { try { cb(container); } catch (e) { console.error(e); } });
      readyCallbacks.set(name, new Set());
    }
  } catch (err) {
    console.error(`[components] Failed to load ${name}:`, err);
  }
}

/**
 * Register a callback to run once a named component is mounted.
 * @param {string} name
 * @param {Function} cb
 */
function onComponentReady(name, cb) {
  if (componentElements.has(name)) {
    cb(componentElements.get(name));
    return;
  }
  if (!readyCallbacks.has(name)) readyCallbacks.set(name, new Set());
  readyCallbacks.get(name).add(cb);
}

/**
 * Load all components used by the app shell.
 */
async function loadAllComponents() {
  await Promise.all([
    loadComponent('sidebarContainer', 'sidebar'),
    loadComponent('mainViewContainer', 'main-view'),
  ]);
  // Settings modal is loaded lazily the first time the user opens it.
}

// Kick off component loading as soon as the body exists.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', loadAllComponents);
} else {
  loadAllComponents();
}
