// =============================
// reflib_js_v5.js — Reference Library
// =============================

// =============================
// Configuration & Constants
// =============================
const CACHE_KEY = 'reflib_v9_inc';
const CACHE_VERSION = 9;
const CONTACT_EMAIL = 'auldn@gmail.com';
const ID_QUEUE_FILE = 'id_queue_pmids.txt';

const MAX_CONCURRENT = 2;
const MIN_DELAY_MS = 400;

// =============================
// Normalization Helpers
// =============================
function normalizeDOI(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  s = s.replace(/^https?:\/\/doi\.org\//i, '');
  s = s.replace(/^doi:\s*/i, '');
  return s || null;
}

function normalizePMID(raw) {
  if (!raw) return null;
  const m = String(raw).match(/\d+/);
  return m ? m[0] : null;
}

function stripHtml(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// =============================
// Article‑ID Helper
// =============================
function promptForArticleId(record) {
  if (record.article_id) return;
  const id = window.prompt('Add article ID (e.g., E123):');
  if (!id) return;
  record.article_id = id.trim();
  saveCacheDebounced();
}

// =============================
// State
// =============================
const state = {
  records: [],
  index: new Map(),
  sort: 'year_desc',
  query: '',
  queueSize: 0,
  tagFilter: ''
};

// =============================
// Merge / Add Records
// =============================
function addOrMerge(rec) {
  rec = { ...rec };
  rec.doi = normalizeDOI(rec.doi);
  rec.pmid = normalizePMID(rec.pmid);

  if (!Array.isArray(rec.keywords)) rec.keywords = [];
  if (!Array.isArray(rec.tags)) rec.tags = [];
  if (typeof rec.article_id !== 'string') rec.article_id = '';

  const keys = [];
  if (rec.doi) keys.push(`doi:${rec.doi.toLowerCase()}`);
  if (rec.pmid) keys.push(`pmid:${rec.pmid}`);

  let existing = null;
  for (const k of keys) {
    if (state.index.has(k)) {
      existing = state.index.get(k);
      break;
    }
  }

  if (!existing) {
    state.records.push(rec);
    keys.forEach(k => state.index.set(k, rec));
    return true;
  }

  Object.assign(existing, rec);
  return true;
}

// =============================
// Rendering
// =============================
function renderEntry(r) {
  const e = document.createElement('div');
  e.className = 'entry';

  // ---- Title line ----
  const line = document.createElement('div');
  const title = r.title || '(title unavailable)';

  if (r.doi) {
    const doiLink = `https://doi.org/${r.doi}`;
    line.innerHTML = `<span class="ok">•</span> <a class="link entry-title" href="${doiLink}" target="_blank" rel="noopener">${title}</a>`;
  } else {
    line.innerHTML = `<span class="ok">•</span> <strong class="entry-title">${title}</strong>`;
  }

  if (r.article_id) {
    const idBadge = document.createElement('span');
    idBadge.className = 'article-id';
    idBadge.textContent = r.article_id;
    line.appendChild(idBadge);
  }

  // ---- Meta line ----
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = `${r.journal || '—'} · ${r.year || '—'}`;

  // ---- Controls ----
  const controls = document.createElement('div');
  controls.className = 'row';

  // Tag input
  const tagInput = document.createElement('input');
  tagInput.className = 'tag-input';
  tagInput.placeholder = 'Add tag…';

  tagInput.addEventListener('keydown', eKey => {
    if (eKey.key !== 'Enter') return;
    const val = tagInput.value.trim();
    if (!val) return;
    if (!r.tags.includes(val)) {
      r.tags.push(val);
      saveCacheDebounced();
      if (val.toLowerCase() === 'printed text') {
        promptForArticleId(r);
      }
      render();
    }
    tagInput.value = '';
  });

  // Tag display
  const tagWrap = document.createElement('div');
  tagWrap.className = 'tag-wrap';

  r.tags.forEach(t => {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = t;
    tagWrap.appendChild(tag);
  });

  controls.appendChild(tagInput);
  controls.appendChild(tagWrap);

  // ---- Assemble ----
  e.appendChild(line);
  e.appendChild(meta);
  e.appendChild(controls);

  return e;
}

// =============================
// Render All
// =============================
function render() {
  const container = document.getElementById('groups');
  if (!container) return;

  container.innerHTML = '';
  for (const r of state.records) {
    container.appendChild(renderEntry(r));
  }
}

// =============================
// Cache
// =============================
function packCache() {
  return { version: CACHE_VERSION, records: state.records };
}

function saveCacheDebounced(delay = 250) {
  setTimeout(() => {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(packCache()));
    } catch {}
  }, delay);
}
