// =============================
// Configuration & Constants
// =============================
const CACHE_KEY = 'reflib_v9_inc';
const CACHE_VERSION = 9; // bump to invalidate all cached data
const CONTACT_EMAIL = 'example@users.noreply';
const ID_QUEUE_FILE = 'id_queue_pmids.txt';

// Concurrency and rate limiting (be kind to public APIs)
const MAX_CONCURRENT = 2; // parallel lookups
const MIN_DELAY_MS = 400; // ~2.5 req/s aggregate

// =============================
// Normalization Helpers
// =============================
function normalizeDOI(raw){
  if (!raw) return null;
  let s = String(raw).trim();
  s = s.replace(/^https?:\/\/doi\.org\//i,''); // strip domain prefix
  s = s.replace(/^doi:\s*/i,''); // strip leading 'doi:'
  s = s.replace(/[\s<>\[\]()\u200B]+$/g,''); // trailing whitespace/brackets/ZWS
  return s || null;
}
function normalizePMID(raw){
  if (!raw) return null;
  const m = String(raw).trim().match(/\d+/);
  return m ? m[0] : null;
}
function stripHtml(s){
  return String(s || '')
    .replace(/<[^>]+>/g,' ')
    .replace(/\s+/g,' ')
    .trim();
}

// Title similarity helpers
function normalizeTitle(t){
  return String(t || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g,' ')
    .replace(/\s+/g,' ')
    .trim();
}
function titleWordSet(t){
  return new Set(normalizeTitle(t).split(' ').filter(w => w.length > 2));
}
function jaccard(a,b){
  const ia = new Set();
  for(const x of a){ if(b.has(x)) ia.add(x); }
  return ia.size / Math.max(1, (new Set([...a, ...b])).size);
}
function scoreTitleMatch(t1,t2){
  return jaccard(titleWordSet(t1), titleWordSet(t2));
}

// =============================
// Open Access (OA) Helpers
// =============================
// Determine whether a CrossRef record has an open license
function hasOpenLicense_CrossRef(it) {
  const lic = it?.license;
  if (!Array.isArray(lic)) return false;
  return lic.some(l => {
    const url = String(l?.URL || '').toLowerCase();
    return url.includes('creativecommons.org');
  });
}
// Determine whether a PubMed esummary result indicates a PMCID
function extractPMCID(articleids) {
  if (!Array.isArray(articleids)) return null;
  const pmc = articleids.find(x => x?.idtype === 'pmcid');
  return pmc?.value || null;
}

// =============================
// API Clients
// =============================
async function crossrefByDOI(doi){
  const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}?mailto=${encodeURIComponent(CONTACT_EMAIL)}`;
  try{
    const res = await fetch(url);
    if(!res.ok) throw new Error(`CrossRef ${res.status}`);
    const json = await res.json();
    const it = json?.message;
    const title = Array.isArray(it?.title) ? it.title[0] : (it?.title || null);
    const journal = Array.isArray(it?.['container-title']) ? it['container-title'][0]
      : (it?.['container-title'] || it?.shortContainerTitle || null);
    const dateParts = it?.issued?.['date-parts']?.[0]
      || it?.created?.['date-parts']?.[0]
      || [];
    const year = dateParts[0]
      || (it?.created?.['date-time'] ? new Date(it.created['date-time']).getFullYear() : null);
    const authors = Array.isArray(it?.author) ? it.author.map(a => ({family:a.family, given:a.given})) : [];
    const abstract = it?.abstract ? stripHtml(it.abstract) : null;
    const hasOA = hasOpenLicense_CrossRef(it);
    return {
      title, journal, year, authors, doi, pmid:null, keywords:[],
      sources:['CrossRef'],
      raw:{crossref:it},
      _abstract: abstract,   // transient; never cached
      _oa: hasOA             // OA flag from CrossRef license
    };
  }catch(err){
    return { title:null, journal:null, year:null, authors:[], doi, pmid:null, keywords:[], sources:['CrossRef(error)'], _abstract:null, _error:String(err) };
  }
}
async function pubmedSummaryByPMID(pmid){
  const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${encodeURIComponent(pmid)}&retmode=json`;
  const res = await fetch(url);
  if(!res.ok) throw new Error(`PubMed esummary ${res.status}`);
  const json = await res.json();
  const s = json?.result?.[pmid];
  if(!s) throw new Error('No esummary result');
  const title = s?.title || null;
  const journal = s?.fulljournalname || s?.source || null;
  const yMatch = String(s?.epubdate || s?.pubdate || s?.sortpubdate || '').match(/(19|20)\d{2}/);
  const year = yMatch ? parseInt(yMatch[0], 10) : null;
  const authors = Array.isArray(s?.authors)
    ? s.authors.map(a => ({
        family: (a?.name || '').split(' ')[0] || '',
        given : (a?.name || '').split(' ').slice(1).join(' ') || ''
      }))
    : [];
  let doi = null;
  if(Array.isArray(s?.articleids)){
    const doiId = s.articleids.find(x => x?.idtype === 'doi');
    if(doiId?.value) doi = doiId.value;
  }
  // OA detection via PMCID (PubMed Central ID)
  const pmcid = extractPMCID(s?.articleids);
  // Keywords or MeSH
  let keywords = [];
  if(Array.isArray(s?.keywords))
    keywords = s.keywords.map(k => String(k || '').trim()).filter(Boolean);
  if(keywords.length === 0 && Array.isArray(s?.meshheadinglist)){
    keywords = s.meshheadinglist
      .map(m => typeof m === 'string' ? m : (m?.meshheading || ''))
      .map(x => String(x || '').trim())
      .filter(Boolean);
  }
  return {
    title, journal, year, authors, doi, pmid, keywords,
    sources:['PubMed'],
    raw:{pubmed:s},
    _pmcid: pmcid || null,
    _oa: Boolean(pmcid) // any PMCID ⇒ treat abstract as OA for display purposes
  };
}
// Single-fetch esearch, then esummary
async function pubmedSearchByDOI(doi, recTitle) {
  const term = encodeURIComponent(doi);
  const sUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&term=${term}`;
  const sres = await fetch(sUrl);
  if (!sres.ok) throw new Error(`PubMed esearch ${sres.status}`);
  const sjson = await sres.json();
  const pmids = (sjson?.esearchresult?.idlist) || [];
  if (pmids.length === 0) throw new Error('No PMID found for DOI');
  const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${encodeURIComponent(pmids.join(','))}&retmode=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`PubMed esummary ${res.status}`);
  const json = await res.json();
  // Choose best match: exact DOI if present; otherwise title similarity
  let best = null, bestScore = -1;
  for (const id of pmids) {
    const s = json?.result?.[id];
    if (!s) continue;
    const ids = Array.isArray(s?.articleids) ? s.articleids : [];
    const doiId = ids.find(x => x?.idtype === 'doi');
    if (doiId && normalizeDOI(doiId.value) === normalizeDOI(doi)) { best = s; break; }
    if (recTitle) {
      const sc = scoreTitleMatch(recTitle, s?.title || '');
      if (sc > bestScore) { bestScore = sc; best = s; }
    }
  }
  best = best || json?.result?.[pmids[0]];
  const pmid = String(best?.uid || pmids[0]);
  return pubmedSummaryByPMID(pmid);
}
async function pubmedAbstractByPMID(pmid){
  const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${encodeURIComponent(pmid)}&retmode=xml`;
  try{
    const res = await fetch(url);
    if(!res.ok) throw new Error(`PubMed efetch ${res.status}`);
    const text = await res.text();
    const xml = new DOMParser().parseFromString(text, 'application/xml');
    const nodes = Array.from(xml.getElementsByTagName('AbstractText'));
    const content = nodes.map(n => n.textContent.trim()).filter(Boolean).join('\n\n');
    return content || null;
  }catch(err){
    return null;
  }
}

// =============================
// Merge / Dedup Utilities
// =============================
function mergeRecords(a,b){
  const out = {...a};
  ['title','journal','year'].forEach(f => { if((!out[f] || out[f] === '—') && b && b[f]) out[f] = b[f]; });
  if((!out.authors || out.authors.length === 0) && b?.authors?.length) out.authors = b.authors;
  out.doi = normalizeDOI(out.doi) || normalizeDOI(b?.doi) || null;
  out.pmid = normalizePMID(out.pmid) || normalizePMID(b?.pmid) || null;
  const ak = Array.isArray(out.keywords) ? out.keywords : [];
  const bk = Array.isArray(b?.keywords) ? b.keywords : [];
  out.keywords = Array.from(new Set([...ak, ...bk].map(x => String(x || '').trim()).filter(Boolean)));
  out.sources = Array.from(new Set([...(a.sources || []), ...((b && b.sources) || [])]));
  out._abstract = out._abstract || b?._abstract || null;
  // Preserve OA flags / identifiers
  out._oa = Boolean(out._oa || b?._oa);
  out._pmcid = out._pmcid || b?._pmcid || null;
  out.raw = { ...(a.raw || {}), ...(b?.raw || {}) };
  return out;
}
function titleNearDuplicate(a,b){
  if(!a.title || !b.title) return false;
  return scoreTitleMatch(a.title, b.title) >= 0.85;
}

// =============================
// State
// =============================
const state = { records:[], index:new Map(), sort:'year_desc', query:'', queueSize:0 };
function addOrMerge(rec){
  rec = {...rec};
  rec.doi = normalizeDOI(rec.doi);
  rec.pmid = normalizePMID(rec.pmid);
  if(!Array.isArray(rec.keywords)) rec.keywords = [];
  const keys = [];
  if(rec.doi) keys.push(`doi:${rec.doi.toLowerCase()}`);
  if(rec.pmid) keys.push(`pmid:${rec.pmid}`);
  let existing = null;
  for(const k of keys){ if(state.index.has(k)){ existing = state.index.get(k); break; } }
  if(!existing){
    for(const r of state.records){ if(titleNearDuplicate(r, rec)){ existing = r; break; } }
  }
  if(existing){
    const merged = mergeRecords(existing, rec);
    if(merged.doi) state.index.set(`doi:${merged.doi.toLowerCase()}`, merged);
    if(merged.pmid) state.index.set(`pmid:${merged.pmid}`, merged);
    const idx = state.records.indexOf(existing);
    if(idx >= 0) state.records[idx] = merged;
    return existing !== merged; // indicate updated
  } else {
    rec.sources = Array.from(new Set(rec.sources || []));
    state.records.push(rec);
    if(rec.doi) state.index.set(`doi:${rec.doi.toLowerCase()}`, rec);
    if(rec.pmid) state.index.set(`pmid:${rec.pmid}`, rec);
    return true;
  }
}

// =============================
// Rendering
// =============================
function formatAuthors(authors){
  if(!Array.isArray(authors) || authors.length === 0) return '—';
  return authors.map(a => {
    if(typeof a === 'string') return a;
    const family = a.family || a.last || a.lastname || a.surname || '';
    const given = a.given || a.first || a.forename || '';
    const initials = given ? given.split(/\s+/).map(w => w[0]).join('').replace(/[^A-Za-z]/g,'') : '';
    return (family && initials) ? `${family}, ${initials}` : (family || given || '—');
  }).join('; ');
}
// NEW: helper to get author name array using same formatting as formatAuthors
function authorNameArray(authors){
  if(!Array.isArray(authors) || authors.length === 0) return [];
  return authors.map(a => {
    if(typeof a === 'string') return a;
    const family = a.family || a.last || a.lastname || a.surname || '';
    const given = a.given || a.first || a.forename || '';
    const initials = given ? given.split(/\s+/).map(w => w[0]).join('').replace(/[^A-Za-z]/g,'') : '';
    return (family && initials) ? `${family}, ${initials}` : (family || given || '—');
  });
}
function journalLabelOf(r){
  const j = (r.journal || '').trim();
  return j.length ? j : 'Unknown Journal';
}
function firstAuthorLabelOf(r){
  if(!Array.isArray(r.authors) || r.authors.length === 0) return 'Unknown Author';
  const a = r.authors[0];
  if(typeof a === 'string') return a.trim() || 'Unknown Author';
  const family = a.family || a.last || a.lastname || a.surname || '';
  const given = a.given || a.first || a.forename || '';
  const initials = given ? given.split(/\s+/).map(w => w[0]).join('').replace(/[^A-Za-z]/g,'') : '';
  const label = (family && initials) ? `${family}, ${initials}` : (family || given || 'Unknown Author');
  return label.trim() || 'Unknown Author';
}
function seniorAuthorLabelOf(r){
  if(!Array.isArray(r.authors) || r.authors.length === 0) return 'Unknown Senior Author';
  const a = r.authors[r.authors.length - 1];
  if(typeof a === 'string') return a.trim() || 'Unknown Senior Author';
  const family = a.family || a.last || a.lastname || a.surname || '';
  const given = a.given || a.first || a.forename || '';
  const initials = given ? given.split(/\s+/).map(w => w[0]).join('').replace(/[^A-Za-z]/g,'') : '';
  const label = (family && initials) ? `${family}, ${initials}` : (family || given || 'Unknown Senior Author');
  return label.trim() || 'Unknown Senior Author';
}
function bucketForYear(y){
  const n = parseInt(y, 10);
  if(!n) return 'Unknown Year';
  const end = n + (5 - (n % 5 || 5));
  const start = end - 4;
  return `${start}-${end}`;
}
function compareBy(sortKey){
  const coll = new Intl.Collator('en', {sensitivity:'base', numeric:true});
  function val(r){
    switch(sortKey){
      case 'title_az':
      case 'title_za': return r.title || '';
      case 'journal_az': return r.journal || '';
      case 'author_az': return (firstAuthorLabelOf(r) || '');
      case 'senior_az': return (seniorAuthorLabelOf(r) || '');
      case 'year_asc':
      case 'year_desc':
      default: return parseInt(r.year,10) || 0;
    }
  }
  return (a,b) => {
    const va = val(a), vb = val(b);
    if(sortKey === 'year_desc') return vb - va;
    if(sortKey === 'year_asc') return va - vb;
    if(sortKey === 'title_za') return coll.compare(vb, va);
    return coll.compare(va, vb);
  };
}
function filteredAndSorted(){
  const q = (state.query || '').toLowerCase();
  const list = state.records.filter(r => {
    if(!q) return true;
    const kws = (Array.isArray(r.keywords) ? r.keywords.join(' ') : '');
    return [r.title, r.journal, formatAuthors(r.authors), r.year?.toString(), r.doi, r.pmid, kws]
      .some(f => f && String(f).toLowerCase().includes(q));
  }).slice();
  list.sort(compareBy(state.sort));
  return list;
}
function render(){
  const qEl = document.getElementById('queueIndicator');
  if(qEl) qEl.textContent = `Queue: ${state.queueSize}`;
  const container = document.getElementById('groups');
  if(!container) return;
  container.innerHTML = '';
  const list = filteredAndSorted();
  // Decide grouping strategy
  const groupByYear = (state.sort === 'year_desc' || state.sort === 'year_asc');
  const groupByJournal = (state.sort === 'journal_az'); // group when Journal A–Z is active
  const groupByAuthor = (state.sort === 'author_az');   // group when First author A–Z is active
  const groupBySenior = (state.sort === 'senior_az');   // group when Senior author A–Z is active
  if (groupByYear) {
    const buckets = new Map();
    for (const r of list){
      const b = bucketForYear(r.year);
      if (!buckets.has(b)) buckets.set(b, []);
      buckets.get(b).push(r);
    }
    const order = Array.from(buckets.keys()).sort((a,b)=>{
      const ea = a==='Unknown Year'? -Infinity : parseInt(a.split('-')[1],10);
      const eb = b==='Unknown Year'? -Infinity : parseInt(b.split('-')[1],10);
      return (state.sort==='year_desc') ? (eb-ea) : (ea-eb);
    });
    for (const label of order){
      const grp = document.createElement('div'); grp.className='group';
      const header = document.createElement('div'); header.className='group-header';
      const h3 = document.createElement('h3'); h3.textContent = label;
      const count = document.createElement('div'); count.className='group-count';
      const arr = buckets.get(label);
      count.textContent = `${arr.length} entr${arr.length===1?'y':'ies'}`;
      header.appendChild(h3); header.appendChild(count);
      const entries = document.createElement('div'); entries.className='entries';
      header.addEventListener('click', ()=>{ entries.classList.toggle('hidden'); });
      for (const r of arr) entries.appendChild(renderEntry(r));
      grp.appendChild(header); grp.appendChild(entries); container.appendChild(grp);
    }
  } else if (groupByJournal) {
    const buckets = new Map();
    for (const r of list){
      const label = journalLabelOf(r);
      if (!buckets.has(label)) buckets.set(label, []);
      buckets.get(label).push(r);
    }
    const coll = new Intl.Collator('en', { sensitivity: 'base' });
    const labels = Array.from(buckets.keys());
    labels.sort((a, b) => {
      const ua = (a === 'Unknown Journal'), ub = (b === 'Unknown Journal');
      if (ua && ub) return 0;
      if (ua) return 1; // push Unknown to bottom
      if (ub) return -1;
      return coll.compare(a, b);
    });
    for (const label of labels){
      const grp = document.createElement('div'); grp.className='group';
      const header = document.createElement('div'); header.className='group-header';
      const h3 = document.createElement('h3'); h3.textContent = label;
      const count = document.createElement('div'); count.className='group-count';
      const arr = buckets.get(label);
      // Secondary sort: Year descending (newest first)
      arr.sort((a,b)=> (parseInt(b.year,10) || 0) - (parseInt(a.year,10) || 0));
      count.textContent = `${arr.length} entr${arr.length===1?'y':'ies'}`;
      header.appendChild(h3); header.appendChild(count);
      const entries = document.createElement('div'); entries.className='entries';
      header.addEventListener('click', ()=>{ entries.classList.toggle('hidden'); });
      for (const r of arr) entries.appendChild(renderEntry(r));
      grp.appendChild(header); grp.appendChild(entries); container.appendChild(grp);
    }
  } else if (groupByAuthor) {
    const buckets = new Map();
    for (const r of list){
      const label = firstAuthorLabelOf(r);
      if (!buckets.has(label)) buckets.set(label, []);
      buckets.get(label).push(r);
    }
    const coll = new Intl.Collator('en', { sensitivity: 'base' });
    const labels = Array.from(buckets.keys());
    labels.sort((a, b) => {
      const ua = (a === 'Unknown Author'), ub = (b === 'Unknown Author');
      if (ua && ub) return 0;
      if (ua) return 1;
      if (ub) return -1;
      return coll.compare(a, b);
    });
    for (const label of labels){
      const grp = document.createElement('div'); grp.className='group';
      const header = document.createElement('div'); header.className='group-header';
      const h3 = document.createElement('h3'); h3.textContent = label;
      const count = document.createElement('div'); count.className='group-count';
      const arr = buckets.get(label);
      arr.sort((a,b)=>{
        const dy=(parseInt(b.year,10)||0)-(parseInt(a.year,10)||0);
        if (dy!==0) return dy;
        return coll.compare(a.title||'', b.title||'');
      });
      count.textContent = `${arr.length} entr${arr.length===1?'y':'ies'}`;
      header.appendChild(h3); header.appendChild(count);
      const entries = document.createElement('div'); entries.className='entries';
      header.addEventListener('click', ()=>{ entries.classList.toggle('hidden'); });
      for (const r of arr) entries.appendChild(renderEntry(r));
      grp.appendChild(header); grp.appendChild(entries); container.appendChild(grp);
    }
  } else if (groupBySenior) {
    const buckets = new Map();
    for (const r of list){
      const label = seniorAuthorLabelOf(r);
      if (!buckets.has(label)) buckets.set(label, []);
      buckets.get(label).push(r);
    }
    const coll = new Intl.Collator('en', { sensitivity: 'base' });
    const labels = Array.from(buckets.keys());
    labels.sort((a, b) => {
      const ua = (a === 'Unknown Senior Author'), ub = (b === 'Unknown Senior Author');
      if (ua && ub) return 0;
      if (ua) return 1; // push Unknown to bottom
      if (ub) return -1;
      return coll.compare(a, b);
    });
    for (const label of labels){
      const grp = document.createElement('div'); grp.className='group';
      const header = document.createElement('div'); header.className='group-header';
      const h3 = document.createElement('h3'); h3.textContent = label;
      const count = document.createElement('div'); count.className='group-count';
      const arr = buckets.get(label);
      // Secondary sort inside each senior author: Year ↓ then Title A–Z
      arr.sort((a,b)=>{
        const dy=(parseInt(b.year,10)||0)-(parseInt(a.year,10)||0);
        if (dy!==0) return dy;
        return coll.compare(a.title||'', b.title||'');
      });
      count.textContent = `${arr.length} entr${arr.length===1?'y':'ies'}`;
      header.appendChild(h3); header.appendChild(count);
      const entries = document.createElement('div'); entries.className='entries';
      header.addEventListener('click', ()=>{ entries.classList.toggle('hidden'); });
      for (const r of arr) entries.appendChild(renderEntry(r));
      grp.appendChild(header); grp.appendChild(entries); container.appendChild(grp);
    }
  } else {
    const grp = document.createElement('div'); grp.className='group';
    const header = document.createElement('div'); header.className='group-header';
    const h3 = document.createElement('h3'); h3.textContent = 'All entries';
    const count = document.createElement('div'); count.className='group-count';
    count.textContent = `${list.length} entr${list.length===1?'y':'ies'}`;
    header.appendChild(h3); header.appendChild(count);
    const entries = document.createElement('div'); entries.className='entries';
    header.addEventListener('click', ()=>{ entries.classList.toggle('hidden'); });
    for (const r of list) entries.appendChild(renderEntry(r));
    grp.appendChild(header); grp.appendChild(entries); container.appendChild(grp);
  }
}
// NEW: render authors with truncate/expand for ≥ 7 authors
function renderAuthors(container, record){
  const names = authorNameArray(record.authors);
  container.innerHTML = ''; // clear
  const showAll = Boolean(record._authorsExpanded);
  let display = names;
  if (names.length >= 7 && !showAll) {
    display = [...names.slice(0,3), '…', ...names.slice(-3)];
  }
  // Build "A; B; C … X; Y; Z"
  let first = true;
  for (const part of display){
    if (!first) container.appendChild(document.createTextNode('; '));
    first = false;
    const span = document.createElement('span');
    span.className = 'author';
    span.textContent = part;
    container.appendChild(span);
  }
  if (names.length >= 7) {
    container.appendChild(document.createTextNode(' '));
    const btn = document.createElement('button');
    btn.className = 'mini-btn';
    btn.title = showAll ? 'Show fewer authors' : 'Show all authors';
    btn.textContent = showAll ? 'Show fewer' : `Show all (${names.length})`;
    btn.addEventListener('click', () => { record._authorsExpanded = !record._authorsExpanded; render(); });
    container.appendChild(btn);
  }
}
function renderEntry(r){
  const e = document.createElement('div'); e.className='entry';
  const title = r.title || '(title unavailable)';
  const journal = r.journal || '—';
  const year = r.year || '—';
  const line = document.createElement('div');
  if(r.doi){
    const doiLink = `https://doi.org/${r.doi}`;
    line.innerHTML = `<span class="ok">•</span> <a class="link entry-title" href="${doiLink}" target="_blank" rel="noopener">${title}</a>`;
  } else {
    line.innerHTML = `<span class="ok">•</span> <strong class="entry-title">${title}</strong>`;
  }
  // Append OA badge (when applicable)
  if (r._oa) {
    const badge = document.createElement('span');
    badge.className = 'oa-badge';
    badge.innerHTML = `<span class="oa-dot"></span> OA`;
    line.appendChild(badge);
  }

  const meta = document.createElement('div'); meta.className='meta';
  // Authors (with expand/collapse)
  const authorsWrap = document.createElement('span');
  authorsWrap.className = 'authors';
  renderAuthors(authorsWrap, r);
  // Separator + journal + year
  const sep1 = document.createTextNode(' · ');
  const jEl = document.createElement('em'); jEl.textContent = journal;
  const sep2 = document.createTextNode(' · ');
  const yEl = document.createTextNode(String(year));
  meta.appendChild(authorsWrap);
  meta.appendChild(sep1);
  meta.appendChild(jEl);
  meta.appendChild(sep2);
  meta.appendChild(yEl);
  const controls = document.createElement('div'); controls.className='row';
  const pmidWrap = document.createElement('div'); pmidWrap.className='pmid-wrap';
  const label = document.createElement('span'); label.textContent='PMID:';
  const codeEl = document.createElement('code'); codeEl.textContent = r.pmid || '—';
  const copyBtn = document.createElement('button'); copyBtn.className='mini-btn'; copyBtn.textContent='📋'; if(!r.pmid) copyBtn.disabled = true;
  copyBtn.addEventListener('click', async () => {
    try{ await navigator.clipboard.writeText(String(r.pmid)); setStatus('PMID copied'); setTimeout(()=>setStatus(''),1200);} 
    catch{ setStatus('Clipboard failed'); setTimeout(()=>setStatus(''),1500);} 
  });
  pmidWrap.appendChild(label); pmidWrap.appendChild(codeEl); pmidWrap.appendChild(copyBtn);
  const absBtn=document.createElement('button'); absBtn.className='mini-btn'; absBtn.textContent=r._abstractShown?'Hide abstract':'Show abstract';
  const absContainer = document.createElement('div'); absContainer.className = 'abstract' + (r._abstractShown ? '' : ' hidden');
  if (r._abstractShown) {
    // content will be filled below after OA / non-OA decision
  } else {
    absContainer.textContent = '';
  }
  absBtn.addEventListener('click', async () => {
    if (!r._abstractShown) {
      if (r._oa) {
        setStatus('Fetching OA abstract...');
        if (!r._abstract && r.pmid) {
          r._abstract = await pubmedAbstractByPMID(r.pmid);
        }
        r._abstractShown = true;
        setStatus('');
      } else {
        // Non‑OA: just reveal the "View on PubMed" link (built in render below)
        r._abstractShown = true;
      }
    } else {
      r._abstractShown = false;
    }
    render();
  });
  // Keywords row
  const kwWrap = document.createElement('div'); kwWrap.className='kw-wrap';
  (Array.isArray(r.keywords) ? r.keywords : []).slice(0,24).forEach(kw => {
    const span = document.createElement('span'); span.className='kw'; span.textContent = kw; kwWrap.appendChild(span);
  });
  controls.appendChild(pmidWrap);
  controls.appendChild(absBtn);
  e.appendChild(line);
  e.appendChild(meta);
  e.appendChild(controls);
  if((r.keywords || []).length) e.appendChild(kwWrap);
  // Fill abstract container based on OA flag
  if (r._abstractShown) {
    if (r._oa && r._abstract) {
      // OA abstract with attribution (not cached; transient)
      const html = `
        <div class="oa-abstract">
          ${String(r._abstract).replace(/\n/g, '<br>')}
          <div class="attribution">
            <em>Open‑access abstract provided via NLM E‑utilities and/or CrossRef. Abstract text © publisher or authors; redistributed under the applicable open license.</em>
          </div>
        </div>
      `;
      absContainer.innerHTML = html;
    } else {
      // Non‑OA: provide a direct link to PubMed
      const url = r.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${r.pmid}/` : '#';
      absContainer.innerHTML = `
        <div class="non-oa-abstract">
          <a class="link" href="${url}" target="_blank" rel="noopener">View abstract on PubMed (not open‑access)</a>
        </div>
      `;
    }
  } else {
    absContainer.innerHTML = '';
  }
  e.appendChild(absContainer);
  return e;
}
function setStatus(msg){
  const el = document.getElementById('status');
  if(el) el.textContent = msg || '';
}

// =============================
// Networking & Queue
// =============================
let inFlight = 0; const queue = []; let lastRun = 0;
async function schedule(task){
  return new Promise((resolve,reject)=>{ queue.push({task,resolve,reject}); pump(); });
}
async function pump(){
  while(inFlight < MAX_CONCURRENT && queue.length){
    const now = Date.now(); const since = now - lastRun; const wait = Math.max(0, MIN_DELAY_MS - since);
    const {task,resolve,reject} = queue.shift();
    inFlight++; state.queueSize = inFlight + queue.length; render();
    setTimeout(async () => {
      lastRun = Date.now();
      try{ const v = await task(); resolve(v); }
      catch(e){ reject(e); }
      finally{ inFlight--; state.queueSize = inFlight + queue.length; render(); pump(); }
    }, wait);
  }
}

// =============================
// Cache (versioned)
// =============================
function packCache(){
  // Strip transient fields before saving to localStorage
  const lean = state.records.map(r => {
    if (!r) return r;
    const { _abstract, _abstractShown, _authorsExpanded, raw, ...rest } = r;
    return rest;
  });
  return { version: CACHE_VERSION, records: lean };
}
function unpackCache(obj){
  if(!obj || obj.version!==CACHE_VERSION || !Array.isArray(obj.records)) return null;
  return obj.records.map(r => {
    if (r && r._abstract !== undefined) { try { delete r._abstract; } catch(_){} }
    if (r && r._abstractShown !== undefined) { try { delete r._abstractShown; } catch(_){} }
    if (r && r._authorsExpanded !== undefined){ try { delete r._authorsExpanded; } catch(_){} }
    return r;
  });
}
let _saveCacheTimer = null;
function saveCacheDebounced(delay = 250){
  if(_saveCacheTimer) clearTimeout(_saveCacheTimer);
  _saveCacheTimer = setTimeout(() => {
    _saveCacheTimer = null;
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(packCache())); } catch (e) {}
  }, delay);
}

// Load PMIDs from id_queue_pmids.txt and add/enrich them one at a time
async function loadPmidsQueue(){
  const res = await fetch(ID_QUEUE_FILE, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to fetch ${ID_QUEUE_FILE}: ${res.status}`);
  const text = await res.text();
  // Accepts plain PMIDs per line; ignores blank lines & lines starting with '#'
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'));
  let processed = 0, addedOrUpdated = 0, skipped = 0;
  for (const line of lines) {
    const m = line.match(/\d+/);
    if (!m) { skipped++; continue; }
    const pmid = m[0];
    // Skip if this PMID already exists AND is complete (prevents re-work after refresh)
    const existing = state.index.get(`pmid:${pmid}`);
    if (existing && recordIsComplete(existing)) { skipped++; continue; }
    try {
      const rec = await resolveIdentifier({ type: 'pmid', id: pmid });
      const changed = addOrMerge(rec);
      if (changed) { addedOrUpdated++; saveCacheDebounced(); render(); }
      processed++;
      setStatus(`Processed ${processed}/${lines.length}… (added/updated: ${addedOrUpdated}, skipped: ${skipped})`);
    } catch (err) {
      skipped++;
      setStatus(`Processed ${processed}/${lines.length}… (added/updated: ${addedOrUpdated}, skipped: ${skipped})`);
    }
  }
  setStatus(`Done. Processed ${processed}/${lines.length}. Added/updated ${addedOrUpdated}, skipped ${skipped}.`);
}

// =============================
// Resolution Pipeline
// =============================
async function resolveIdentifier(ident){
  if(ident.type === 'pmid'){
    let a = await schedule(() => pubmedSummaryByPMID(ident.id));
    if(a?.doi){ const b = await schedule(() => crossrefByDOI(normalizeDOI(a.doi))); a = mergeRecords(a, b); }
    return a;
  } else if(ident.type === 'doi'){
    let a = await schedule(() => crossrefByDOI(normalizeDOI(ident.id)));
    if(!a.title || !a.journal || !a.year || ((a.authors || []).length === 0)){
      const b = await schedule(() => pubmedSearchByDOI(normalizeDOI(ident.id), a.title));
      a = mergeRecords(a, b);
    }
    return a;
  }
  throw new Error('Unknown identifier type');
}
async function resolveMissingForRecord(rec){
  try{
    if(rec.pmid){
      const rich = await resolveIdentifier({type:'pmid', id:rec.pmid});
      return mergeRecords(rec, rich);
    }
    if(rec.doi){
      const cr = await schedule(() => crossrefByDOI(rec.doi));
      return mergeRecords(rec, cr);
    }
    return rec;
  }catch(e){ return rec; }
}
function recordIsComplete(r){
  const hasCore = Boolean((r.title || '').trim()) && Boolean((r.journal || '').trim()) && ((parseInt(r.year,10) || 0) > 0);
  const hasAuthors = Array.isArray(r.authors) && r.authors.length > 0;
  const hasId = Boolean(r.pmid) || Boolean(r.doi);
  return hasCore && hasAuthors && hasId; // adjust if you want keywords mandatory
}
async function enrichAllIncremental(){
  const total = state.records.length; let done=0, skipped=0;
  for(let i=0; i<state.records.length; i++){
    const r = state.records[i];
    if(recordIsComplete(r)){ skipped++; continue; }
    const enriched = await resolveMissingForRecord(r);
    const changed = addOrMerge(enriched);
    if(changed){ saveCacheDebounced(); render(); }
    done++; setStatus(`Enriched ${done}, skipped ${skipped}, of ${total}…`);
  }
  setStatus(`Ready. Enriched ${done}, skipped ${skipped}.`);
}

// =============================
// Export / Download Helpers
// =============================
function collectAllPmids(){
  const set = new Set();
  for (const r of state.records){
    const p = normalizePMID(r && r.pmid);
    if (p) set.add(p);
  }
  return Array.from(set);
}
function downloadTextFile(filename, text){
  try{
    const blob = new Blob([text], {type:'text/plain'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    return true;
  }catch(e){
    try{ // Fallback
      const a = document.createElement('a');
      a.href = 'data:text/plain;charset=utf-8,' + encodeURIComponent(text);
      a.download = filename; document.body.appendChild(a); a.click(); a.remove();
      return true;
    }catch(_){ }
  }
  return false;
}
function downloadAllPmids(){
  const pmids = collectAllPmids();
  const content = pmids.join('\n') + (pmids.length ? '\n' : '');
  const ok = downloadTextFile('all_pmids.txt', content);
  if (ok) setStatus(`Saved ${pmids.length} PMID${pmids.length===1?'':'s'} to all_pmids.txt`);
  else setStatus('Download failed');
}

// =============================
// Boot
// =============================
function wireUI(){
  // Core controls
  const searchEl = document.getElementById('search');
  const sortEl = document.getElementById('sort');
  const resetEl = document.getElementById('reset');
  const addBtn = document.getElementById('addId');
  const idInput = document.getElementById('idInput');
  // Search, sort, reset
  if(searchEl) searchEl.addEventListener('input', e=>{ state.query = e.target.value; saveCacheDebounced(); render(); });
  if(sortEl) sortEl.addEventListener('change', e=>{ state.sort = e.target.value; saveCacheDebounced(); render(); });
  if(resetEl) resetEl.addEventListener('click', ()=>{ state.query=''; if(searchEl) searchEl.value=''; state.sort='year_desc'; if(sortEl) sortEl.value='year_desc'; saveCacheDebounced(); render(); });
  // Online/offline indicator
  const onlinePill = document.getElementById('netIndicator');
  function updateNet(){ if(!onlinePill) return; onlinePill.textContent = navigator.onLine ? 'Online' : 'Offline'; onlinePill.style.color = navigator.onLine ? '#a7f3d0' : '#fecaca'; }
  window.addEventListener('online', updateNet);
  window.addEventListener('offline', updateNet);
  updateNet();
  // Add-by-ID interactions
  if(addBtn) addBtn.addEventListener('click', addById);
  if(idInput) idInput.addEventListener('keydown', e=>{ if (e.key === 'Enter') addById(); });
  // Optional: hook up "Download PMIDs" button if present
  const dlBtn = document.getElementById('downloadPmids');
  if (dlBtn) dlBtn.addEventListener('click', downloadAllPmids);
}
function classifyId(input){
  const v = String(input || '').trim();
  if(/^\d+$/.test(v)) return {type:'pmid', id:v};
  if(/^10\./.test(v) || /^doi:/i.test(v) || /^https?:\/\/doi\.org\//i.test(v)) return {type:'doi', id:normalizeDOI(v)};
  return null;
}
async function addById(){
  const el = document.getElementById('idInput');
  const raw = el ? el.value.trim() : '';
  if(!raw){ setStatus('Please paste a DOI or a PubMed ID.'); return; }
  const ident = classifyId(raw);
  if(!ident){ setStatus('Could not detect DOI or PMID.'); return; }
  setStatus('Adding entry…');
  try{
    const rec = await resolveIdentifier(ident);
    addOrMerge(rec); render(); saveCacheDebounced(); setStatus('Entry added.');
    if(el) el.value = '';
  }catch(err){ setStatus('Failed to add entry.'); }
}

(async function(){
  wireUI();
  // 1) Load cache first for an instant enriched view (if available)
  try{
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) {
      const obj = JSON.parse(raw);
      const cached = unpackCache(obj);
      if (cached) {
        state.records = cached;
        state.index = new Map();
        for (const r of state.records) {
          if (r.doi) state.index.set(`doi:${String(r.doi).toLowerCase()}`, r);
          if (r.pmid) state.index.set(`pmid:${r.pmid}`, r);
        }
        console.log('[cache] startup summary → records:', state.records.length,
          ', complete:', state.records.filter(recordIsComplete).length,
          ', incomplete:', state.records.length - state.records.filter(recordIsComplete).length,
          ', indexKeys:', state.index.size);
        render();
        setStatus(`Loaded ${state.records.length} record(s) from local cache.`);
      }
    }
  }catch(e){ /* ignore */ }
  await new Promise(r => setTimeout(r, 0));
  // 2) Load newline-delimited PMIDs and add them one at a time
  try {
    await loadPmidsQueue();
  } catch (err) {
    setStatus(`Could not load ${ID_QUEUE_FILE}: ${err.message}`);
  }
  // 3) Incremental enrichment – only enrich incomplete records
  await enrichAllIncremental();
})();
