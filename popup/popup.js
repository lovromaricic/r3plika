'use strict';

const DEFAULTS = {
  embedImages: true, imageScale: 2, scrollLazy: true, includeFixed: true, includeHidden: false,
  structure: 'compact', fallbackSans: 'Inter', whiteBackground: true, autoCopy: true, viewportWidth: 0,
};
const KEY = 'w2f_opts';
const $ = (id) => document.getElementById(id);
const status = $('status');
const REDUCED = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

function setStatus(text, isErr) {
  status.textContent = text || '';
  status.className = isErr ? 'err' : '';
}

function writeForm(o) {
  $('o-embedImages').value = String(o.embedImages);
  $('o-imageScale').value = String(o.imageScale);
  $('o-viewportWidth').value = String(o.viewportWidth);
  $('o-structure').value = o.structure;
  const sel = $('o-fontSelect');
  const known = Array.from(sel.options).some((op) => op.value === o.fallbackSans || op.text === o.fallbackSans);
  sel.value = known ? o.fallbackSans : '__custom';
  $('o-fallbackSans').value = known ? '' : o.fallbackSans;
  $('o-fallbackSans').hidden = known;
  ['scrollLazy', 'includeFixed', 'includeHidden', 'whiteBackground', 'autoCopy'].forEach((k) => { $('o-' + k).checked = !!o[k]; });
}

function readForm() {
  return {
    embedImages: $('o-embedImages').value === 'true',
    imageScale: Number($('o-imageScale').value),
    viewportWidth: Number($('o-viewportWidth').value),
    structure: $('o-structure').value,
    fallbackSans: ($('o-fontSelect').value === '__custom' ? $('o-fallbackSans').value.trim() : $('o-fontSelect').value) || 'Inter',
    scrollLazy: $('o-scrollLazy').checked,
    includeFixed: $('o-includeFixed').checked,
    includeHidden: $('o-includeHidden').checked,
    whiteBackground: $('o-whiteBackground').checked,
    autoCopy: $('o-autoCopy').checked,
  };
}

const save = () => chrome.storage.local.set({ [KEY]: readForm() });

async function go(mode) {
  const buttons = document.querySelectorAll('.act');
  buttons.forEach((b) => { b.disabled = true; });
  try {
    const options = readForm();
    await save();
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !/^(https?|file):/i.test(tab.url || '')) {
      setStatus('Open a regular website first.', true);
      return;
    }
    setStatus(mode === 'element' ? 'Click an element on the page\u2026' : 'Starting\u2026');
    const res = await chrome.runtime.sendMessage({ type: 'w2f:run', tabId: tab.id, mode, options });
    if (res && res.ok) { document.body.classList.add('closing'); setTimeout(() => window.close(), REDUCED ? 0 : 230); }
    else setStatus((res && res.error) || 'Could not start the capture.', true);
  } catch (e) {
    setStatus(String((e && e.message) || e), true);
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
  }
}

// the artwork is large: load it after the popup is already on screen
function loadArtwork() {
  const img = new Image();
  img.onload = () => { const bg = document.querySelector('.bg'); bg.style.backgroundImage = 'url(bg.webp)'; bg.classList.add('on'); };
  img.src = 'bg.webp';
}
requestAnimationFrame(() => setTimeout(loadArtwork, 0));

(function init() {
  // wire everything up first so the popup is usable instantly, then fill in saved options
  writeForm(DEFAULTS);
  document.querySelectorAll('select, input').forEach((el) => el.addEventListener('change', save));
  $('o-fallbackSans').addEventListener('input', save);
  $('o-fontSelect').addEventListener('change', (e) => {
    const custom = e.target.value === '__custom';
    $('o-fallbackSans').hidden = !custom;
    if (custom) $('o-fallbackSans').focus();
    save();
  });
  $('o-viewportWidth').addEventListener('change', (e) => {
    setStatus(Number(e.target.value) ? 'Chrome shows a "debugging" bar briefly while it captures at this width.' : '');
    save();
  });
  document.querySelectorAll('#opts .grid > *, #opts .checks label').forEach((el, i) => el.style.setProperty('--j', i));
  $('opt-toggle').addEventListener('click', () => {
    const open = $('opt-toggle').getAttribute('aria-expanded') !== 'true';
    $('opt-toggle').setAttribute('aria-expanded', String(open));
    document.body.classList.toggle('open', open);
  });
  $('btn-page').addEventListener('click', () => go('page'));
  $('btn-viewport').addEventListener('click', () => go('viewport'));
  $('btn-element').addEventListener('click', () => go('element'));

  chrome.storage.local.get(KEY).then((r) => { if (r && r[KEY]) writeForm(Object.assign({}, DEFAULTS, r[KEY])); });
})();
