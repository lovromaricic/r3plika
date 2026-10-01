/*
 * Service worker.
 *  - injects the capture scripts on demand
 *  - fetches cross-origin images for the content script (host permissions bypass CORS, cookies included)
 *  - handles keyboard shortcuts and the optional "capture at width" window resize
 */
'use strict';
importScripts('content/lib.js');
const L = globalThis.__w2fLib;

const OPTS_KEY = 'w2f_opts';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------- fetch */
async function fetchResource(url) {
  const res = await fetch(url, { credentials: 'include', cache: 'force-cache' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const header = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  return { base64: L.bytesToB64(bytes), mime: L.sniffMime(bytes) || header };
}

/* ------------------------------------------------------------ injection */
async function inject(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content/lib.js', 'content/capture.js'] });
}

async function innerWidth(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: () => window.innerWidth });
  return result;
}

// Resize the browser window so the viewport is `width` px wide, run fn, then restore.
async function withViewportWidth(tabId, width, fn) {
  const tab = await chrome.tabs.get(tabId);
  const win = await chrome.windows.get(tab.windowId);
  const prev = { width: win.width, height: win.height, left: win.left, top: win.top, state: win.state };
  try {
    if (win.state !== 'normal') { await chrome.windows.update(win.id, { state: 'normal' }); await sleep(300); }
    const w2 = await chrome.windows.get(win.id);
    const inner = await innerWidth(tabId);
    const chromeW = w2.width - inner; // window frame + scrollbar
    await chrome.windows.update(win.id, { width: Math.max(300, Math.round(width + chromeW)) });
    await sleep(800);
    return await fn();
  } finally {
    try {
      if (prev.state !== 'normal') await chrome.windows.update(win.id, { state: prev.state });
      else await chrome.windows.update(win.id, { width: prev.width, height: prev.height, left: prev.left, top: prev.top });
    } catch (e) { /* window closed */ }
  }
}

// Preferred: emulate the viewport via the debugger API (needs the optional "debugger" permission).
// Works for phone widths and does not touch the browser window.
async function withEmulatedWidth(tabId, width, fn) {
  const target = { tabId };
  const h = await chrome.scripting.executeScript({ target, func: () => window.innerHeight });
  const height = Math.max(600, (h && h[0] && h[0].result) || 800);
  await chrome.debugger.attach(target, '1.3');
  try {
    await chrome.debugger.sendCommand(target, 'Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: false, screenWidth: width, screenHeight: height,
    });
    try { await chrome.debugger.sendCommand(target, 'Emulation.setScrollbarsHidden', { hidden: true }); } catch (e) { /* ignore */ }
    await sleep(900);
    return await fn();
  } finally {
    try { await chrome.debugger.sendCommand(target, 'Emulation.setScrollbarsHidden', { hidden: false }); } catch (e) { /* ignore */ }
    try { await chrome.debugger.sendCommand(target, 'Emulation.clearDeviceMetricsOverride'); } catch (e) { /* ignore */ }
    try { await chrome.debugger.detach(target); } catch (e) { /* ignore */ }
  }
}

async function run(tabId, mode, options) {
  options = options || {};
  await inject(tabId); // throws on chrome:// pages etc. -> reported to the caller
  const send = () => chrome.tabs.sendMessage(tabId, { type: 'w2f:start', mode, options });
  const width = Number(options.viewportWidth) || 0;
  const job = (async () => {
    const keep = setInterval(() => chrome.runtime.getPlatformInfo(), 20000); // keep the worker alive
    try {
      if (width > 0 && mode !== 'element') {
        if (chrome.debugger) await withEmulatedWidth(tabId, width, send);
        else if (width >= 600) await withViewportWidth(tabId, width, send);
        else await send();
      } else await send();
    } catch (e) {
      console.warn('[web-to-figma]', e);
      flagError(tabId, friendly(e));
    } finally { clearInterval(keep); }
  })();
  job.catch(() => {});
  return { ok: true };
}

/* --------------------------------------------------------------- events */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;
  if (msg.type === 'w2f:fetch') {
    fetchResource(msg.url).then(sendResponse, (e) => sendResponse({ error: String((e && e.message) || e) }));
    return true;
  }
  if (msg.type === 'w2f:run') {
    run(msg.tabId, msg.mode, msg.options).then(sendResponse, (e) => sendResponse({ ok: false, error: friendly(e) }));
    return true;
  }
  return false;
});

function flagError(tabId, text) {
  chrome.action.setBadgeBackgroundColor({ color: '#b3261e' });
  chrome.action.setBadgeText({ text: '!', tabId });
  chrome.action.setTitle({ title: 'Capture failed: ' + text, tabId });
  setTimeout(() => { chrome.action.setBadgeText({ text: '', tabId }); chrome.action.setTitle({ title: 'Capture to Figma SVG', tabId }); }, 8000);
}

function friendly(e) {
  const m = String((e && e.message) || e);
  if (/cannot access|chrome:\/\/|extensions gallery|Cannot access contents/i.test(m)) return 'Chrome does not allow extensions on this page. Open a regular website and try again.';
  return m;
}

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !tab.id) return;
  const stored = (await chrome.storage.local.get(OPTS_KEY))[OPTS_KEY] || {};
  const mode = command === 'capture-element' ? 'element' : 'page';
  try { await run(tab.id, mode, stored); } catch (e) {
    chrome.action.setBadgeBackgroundColor({ color: '#b3261e' });
    chrome.action.setBadgeText({ text: '!', tabId: tab.id });
    setTimeout(() => chrome.action.setBadgeText({ text: '', tabId: tab.id }), 3000);
  }
});
