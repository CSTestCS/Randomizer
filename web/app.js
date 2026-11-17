'use strict';

/* ======================================================================
   Constants
   ====================================================================== */
const RARITIES = ['common', 'uncommon', 'rare', 'legendary', 'exotic'];
const RARITY_INFO = {
  common:    { label: 'Common',    color: '#b9c2d3', stars: 1, build: 1500, weight: 60 },
  uncommon:  { label: 'Uncommon',  color: '#4fe08a', stars: 2, build: 1800, weight: 25 },
  rare:      { label: 'Rare',      color: '#3fa3ff', stars: 3, build: 2200, weight: 10 },
  legendary: { label: 'Legendary', color: '#ffb627', stars: 4, build: 2900, weight: 4 },
  exotic:    { label: 'Exotic',    color: '#ff4fd8', stars: 5, build: 3700, weight: 1 },
};

/* ======================================================================
   State
   ====================================================================== */
let library = { collections: [], settings: {} };
let view = { screen: 'home', collectionId: null };
// The active session for the open collection. Reset whenever a collection is opened.
let session = null;

const $ = (sel, root = document) => root.querySelector(sel);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function settings() {
  const s = library.settings || (library.settings = {});
  if (!s.weights) s.weights = Object.fromEntries(RARITIES.map((r) => [r, RARITY_INFO[r].weight]));
  if (s.sound === undefined) s.sound = true;
  if (s.perCategory === undefined) s.perCategory = 1;
  const au = s.audio || (s.audio = {});
  if (au.master === undefined) au.master = 0.8;
  if (au.buildVol === undefined) au.buildVol = 0.8;
  if (au.revealVol === undefined) au.revealVol = 0.9;
  if (!au.buildup) au.buildup = 'riser';
  if (!au.reveal) au.reveal = Object.fromEntries(RARITIES.map((r) => [r, 'chime']));
  if (!au.files) au.files = {}; // slot ('buildup' | rarity) -> { file, name }
  return s;
}
const weightOf = (rarity) => Math.max(0, Number(settings().weights[rarity]) || 0);

/* ======================================================================
   Server API
   ====================================================================== */
async function api(method, path, body, raw) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    if (raw) opts.body = body;
    else { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  }
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(await res.text());
  return res.status === 204 ? null : res.json();
}
let saveChain = Promise.resolve();
function saveLibrary() {
  const snapshot = JSON.stringify(library);
  saveChain = saveChain.then(() => api('PUT', '/api/library', snapshot, true)).catch((e) => toast('Save failed: ' + e.message));
  return saveChain;
}
async function uploadFile(blob, name) {
  const res = await api('POST', '/api/images?name=' + encodeURIComponent(name), blob, true);
  return res.file;
}
// Downscale an image so the app never has to decode full HD originals.
// Returns null for formats that should be kept as-is (GIF animations, SVG).
async function shrinkImage(blob, max) {
  if (/gif|svg/i.test(blob.type)) return null;
  const bmp = await createImageBitmap(blob);
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close && bmp.close();
  let out = await new Promise((r) => c.toBlob(r, 'image/webp', 0.88));
  let ext = '.webp';
  if (!out || out.type !== 'image/webp') { out = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9)); ext = '.jpg'; }
  return { blob: out, ext };
}
const FULL_SIZE = 1024, THUMB_SIZE = 320;
// Store a display-sized copy (for reveals) and a small thumbnail (for grids).
async function uploadImage(file) {
  const full = await shrinkImage(file, FULL_SIZE);
  if (!full) { const f = await uploadFile(file, file.name || 'image.gif'); return { image: f, thumb: f }; }
  const thumb = await shrinkImage(file, THUMB_SIZE);
  const [image, th] = await Promise.all([uploadFile(full.blob, 'full' + full.ext), uploadFile(thumb.blob, 'thumb' + thumb.ext)]);
  return { image, thumb: th };
}
// One-time pass for entries added before thumbnails existed.
async function optimizeExistingImages() {
  const todo = library.collections.flatMap((c) => c.categories.flatMap((k) => k.entries)).filter((e) => e.image && !e.thumb);
  if (!todo.length) return;
  toast(`Optimizing ${todo.length} image${todo.length === 1 ? '' : 's'}…`);
  for (const e of todo) {
    try {
      const blob = await (await fetch(imgURL(e.image))).blob();
      const name = e.image;
      const res = await uploadImage(new File([blob], name, { type: blob.type }));
      e.image = res.image; e.thumb = res.thumb;
    } catch (err) { e.thumb = e.image; }
  }
  saveLibrary();
  if (session) session.claimed.forEach(refreshSnapshot);
  if (!G.el || G.phase === 'idle') render();
  toast('Images optimized.');
}
// Refresh image refs on result/claim snapshots from the live entry.
function refreshSnapshot(item) {
  const coll = getCollection(item.collectionId) || getCollection();
  const hit = coll && findEntry(coll, item.entryId);
  if (hit) { item.image = hit.entry.image || null; item.thumb = hit.entry.thumb || null; }
  return item;
}
const imgURL = (file) => '/img/' + encodeURIComponent(file);

/* ======================================================================
   Helpers: lookups
   ====================================================================== */
const getCollection = (id = view.collectionId) => library.collections.find((c) => c.id === id);
function findEntry(coll, entryId) {
  for (const cat of coll.categories) {
    const e = cat.entries.find((x) => x.id === entryId);
    if (e) return { cat, entry: e };
  }
  return null;
}

function artHTML(item, size = 'thumb') {
  const file = size === 'full' ? item.image : (item.thumb || item.image);
  if (file) return `<img src="${imgURL(file)}" alt="" draggable="false" decoding="async"${size === 'full' ? '' : ' loading="lazy"'}>`;
  const c = RARITY_INFO[item.rarity]?.color || '#888';
  const letter = esc((item.name || '?').trim().charAt(0).toUpperCase() || '?');
  return `<div class="placeholder" style="background:radial-gradient(circle at 30% 25%, ${c}66, ${c}11 70%)">${letter}</div>`;
}

/* ======================================================================
   UI primitives: toast, modal
   ====================================================================== */
function toast(msg, ms = 2600) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), ms);
}

let modalResolve = null;
function openModal(html, onMount) {
  const wrap = $('#modal');
  const box = $('.modal', wrap);
  box._cleanup && box._cleanup(); box._cleanup = null;
  box.innerHTML = html;
  wrap.classList.remove('hidden');
  return new Promise((resolve) => {
    modalResolve = resolve;
    onMount && onMount(box, closeModal);
    const first = box.querySelector('input[type=text], input:not([type=hidden]), select');
    first && setTimeout(() => { first.focus(); first.select && first.select(); }, 30);
  });
}
function closeModal(value) {
  const box = $('#modal .modal');
  box._cleanup && box._cleanup(); box._cleanup = null;
  $('#modal').classList.add('hidden');
  box.innerHTML = '';
  const r = modalResolve;
  modalResolve = null;
  r && r(value);
}
$('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') closeModal(null); });

function promptText(title, label, value = '', okText = 'Save') {
  return openModal(`
    <h2>${esc(title)}</h2>
    <form>
      <label class="field"><span>${esc(label)}</span><input type="text" name="v" maxlength="120" value="${esc(value)}"></label>
      <div class="actions"><button type="button" class="btn ghost" data-cancel>Cancel</button><button class="btn primary">${esc(okText)}</button></div>
    </form>`, (box, close) => {
    box.querySelector('[data-cancel]').onclick = () => close(null);
    box.querySelector('form').onsubmit = (e) => {
      e.preventDefault();
      const v = box.querySelector('input').value.trim();
      if (!v) { toast('A name is required.'); return; }
      close(v);
    };
  });
}
function confirmBox(title, text, okText = 'Delete') {
  return openModal(`
    <h2>${esc(title)}</h2><p style="color:var(--muted)">${esc(text)}</p>
    <div class="actions"><button class="btn ghost" data-no>Cancel</button><button class="btn primary" data-yes>${esc(okText)}</button></div>`,
  (box, close) => {
    box.querySelector('[data-no]').onclick = () => close(false);
    box.querySelector('[data-yes]').onclick = () => close(true);
  });
}

/* ======================================================================
   Rendering: router
   ====================================================================== */
function render() {
  if (view.screen === 'collection' && getCollection()) renderCollection();
  else { view = { screen: 'home', collectionId: null }; session = null; renderHome(); }
}

/* ---------------------------- Home ---------------------------- */
function rarityBar(entries) {
  if (!entries.length) return '<div class="rarity-bar"></div>';
  const counts = RARITIES.map((r) => entries.filter((e) => e.rarity === r).length);
  return `<div class="rarity-bar">${RARITIES.map((r, i) => counts[i] ? `<span style="flex:${counts[i]};background:${RARITY_INFO[r].color}"></span>` : '').join('')}</div>`;
}

function renderHome() {
  const app = $('#app');
  const cards = library.collections.map((c) => {
    const entries = c.categories.flatMap((k) => k.entries);
    return `<div class="coll-card" data-open="${c.id}">
      <div class="card-tools">
        <button class="btn small icon" data-rename="${c.id}" title="Rename">✎</button>
        <button class="btn small icon danger" data-delete="${c.id}" title="Delete">🗑</button>
      </div>
      <h3>${esc(c.name)}</h3>
      <div class="meta">${c.categories.length} categor${c.categories.length === 1 ? 'y' : 'ies'} · ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}</div>
      ${rarityBar(entries)}
    </div>`;
  }).join('');

  app.innerHTML = `
    <div class="topbar">
      <div class="logo">✦ Randomizer</div>
      <div class="spacer"></div>
      <button class="btn" data-act="load-session">📂 Load session</button>
      <button class="btn" data-act="settings">⚙ Settings</button>
      <button class="btn primary" data-act="new-collection">＋ New collection</button>
    </div>
    <div class="page">
      ${library.collections.length ? `<div class="coll-grid">${cards}</div>` :
        `<div class="empty"><h2 style="margin-bottom:8px">No collections yet</h2>Create a collection, add some categories and entries, then pull!<br><br>
         <button class="btn primary" data-act="new-collection">＋ Create your first collection</button></div>`}
    </div>`;

  app.onclick = async (e) => {
    const t = e.target.closest('[data-act],[data-open],[data-rename],[data-delete]');
    if (!t) return;
    if (t.dataset.act === 'new-collection') {
      const name = await promptText('New collection', 'Collection name', '', 'Create');
      if (!name) return;
      const c = { id: uid(), name, categories: [] };
      library.collections.push(c);
      saveLibrary();
      openCollection(c.id);
    } else if (t.dataset.act === 'settings') {
      openSettings();
    } else if (t.dataset.act === 'load-session') {
      openLoadSession(null);
    } else if (t.dataset.rename) {
      e.stopPropagation();
      const c = getCollection(t.dataset.rename);
      const name = await promptText('Rename collection', 'Collection name', c.name);
      if (name) { c.name = name; saveLibrary(); render(); }
    } else if (t.dataset.delete) {
      e.stopPropagation();
      const c = getCollection(t.dataset.delete);
      if (await confirmBox('Delete collection?', `"${c.name}" and all its categories and entries will be permanently deleted.`)) {
        library.collections = library.collections.filter((x) => x !== c);
        saveLibrary(); render();
      }
    } else if (t.dataset.open) {
      openCollection(t.dataset.open);
    }
  };
}

/* ---------------------------- Session ---------------------------- */
function newSession(collectionId) {
  return { id: null, name: null, collectionId, noRepeat: false, drawn: [], claimed: [] };
}
function openCollection(id, restored) {
  view = { screen: 'collection', collectionId: id };
  // Opening a collection always starts a fresh session unless restoring a saved one.
  session = restored || newSession(id);
  render();
  window.scrollTo(0, 0);
}
const drawnSet = () => new Set(session.drawn);

/* ---------------------------- Collection ---------------------------- */
function chanceTable(cat) {
  // Probability of each entry for a single pull from this category (respecting no-repeat).
  const excluded = session.noRepeat ? drawnSet() : new Set();
  const pool = cat.entries.filter((e) => !excluded.has(e.id));
  const total = pool.reduce((s, e) => s + weightOf(e.rarity), 0);
  const map = {};
  for (const e of pool) map[e.id] = total > 0 ? (weightOf(e.rarity) / total) * 100 : 0;
  return { map, remaining: pool.length };
}
const fmtPct = (p) => (p === undefined ? '—' : p >= 10 ? p.toFixed(0) + '%' : p >= 1 ? p.toFixed(1) + '%' : p > 0 ? p.toFixed(2) + '%' : '0%');

function renderCollection() {
  const coll = getCollection();
  const s = settings();
  const drawn = drawnSet();
  const app = $('#app');

  const catsHTML = coll.categories.map((cat) => {
    const { map, remaining } = chanceTable(cat);
    const entries = cat.entries.map((e) => {
      const isDrawn = session.noRepeat && drawn.has(e.id);
      return `<div class="entry r-${e.rarity} ${isDrawn ? 'drawn' : ''}" data-edit-entry="${e.id}" data-cat="${cat.id}" title="Click to edit">
        ${isDrawn ? '<div class="drawn-tag">drawn</div>' : ''}
        <div class="thumb">${artHTML(e)}</div>
        <div class="info"><div class="name">${esc(e.name)}</div>
          <div class="sub"><span class="rlabel">${RARITY_INFO[e.rarity].label}</span><span>${isDrawn ? '' : fmtPct(map[e.id])}</span></div></div>
      </div>`;
    }).join('');
    return `<section class="category" data-cat-id="${cat.id}">
      <div class="cat-head">
        <h2>${esc(cat.name)}</h2>
        <span class="count">${cat.entries.length} entr${cat.entries.length === 1 ? 'y' : 'ies'}${session.noRepeat ? ` · ${remaining} left` : ''}</span>
        <button class="btn small icon" data-rename-cat="${cat.id}" title="Rename category">✎</button>
        <button class="btn small icon danger" data-delete-cat="${cat.id}" title="Delete category">🗑</button>
        <div class="spacer"></div>
        <button class="btn small" data-add-entry="${cat.id}">＋ Entry</button>
        <span class="count">Results</span>
        <input type="number" min="1" max="100" value="${cat._pullCount || 1}" data-cat-count="${cat.id}" title="How many results to pull from this category">
        <button class="btn pull small" data-pull-cat="${cat.id}" ${cat.entries.length ? '' : 'disabled'}>✦ Pull</button>
      </div>
      <div class="entries">${entries || '<div class="empty">No entries yet. Add one with “＋ Entry”.</div>'}</div>
    </section>`;
  }).join('');

  const claimedHTML = session.claimed.map((c) => `
    <div class="claimed-item r-${c.rarity}">
      <div class="mini">${artHTML(c)}</div>
      <div class="txt"><div class="name">${esc(c.name)}</div><div class="sub"><span class="rlabel">${RARITY_INFO[c.rarity].label}</span> · ${esc(c.categoryName)}</div></div>
      <button class="btn small icon ghost" data-unclaim="${c.uid}" title="Remove from claimed">✕</button>
    </div>`).join('');

  const totalEntries = coll.categories.reduce((n, c) => n + c.entries.length, 0);

  app.innerHTML = `
    <div class="topbar">
      <button class="btn ghost" data-act="home">◀ Collections</button>
      <h1>${esc(coll.name)}</h1>
      <button class="btn small icon" data-act="rename" title="Rename collection">✎</button>
      <div class="spacer"></div>
      <span class="session-tag">${session.name ? `Session: <b>${esc(session.name)}</b>` : 'Unsaved session'}</span>
      <button class="btn" data-act="save-session">💾 Save session</button>
      <button class="btn" data-act="load-session">📂 Load session</button>
      <button class="btn" data-act="settings">⚙</button>
    </div>
    <div class="page">
      <div class="toolbar">
        <div class="group">
          <span>Per category</span>
          <input type="number" min="1" max="100" value="${s.perCategory}" id="perCat" title="Results to pull from each category">
          <button class="btn pull" data-act="pull-all" ${totalEntries ? '' : 'disabled'}>✦ Pull entire collection</button>
        </div>
        <div class="sep"></div>
        <label class="switch" title="When on, an entry can only be drawn once this session. Toggling resets it.">
          <input type="checkbox" id="noRepeat" ${session.noRepeat ? 'checked' : ''}><span class="track"></span>
          <span>No repeats${session.noRepeat ? ` <span class="session-tag">(${session.drawn.length} drawn)</span>` : ''}</span>
        </label>
        <label class="switch"><input type="checkbox" id="sound" ${s.sound ? 'checked' : ''}><span class="track"></span><span>Sound</span></label>
        <input type="range" id="masterVol" min="0" max="100" value="${pct(s.audio.master)}" title="Master volume" class="mini-range">
        <div class="spacer"></div>
        <button class="btn primary" data-act="add-category">＋ Category</button>
      </div>
      <div class="coll-layout">
        <div>${catsHTML || '<div class="empty"><h2 style="margin-bottom:8px">No categories yet</h2>Categories group entries together (e.g. “Weapons”, “Characters”).<br><br><button class="btn primary" data-act="add-category">＋ Add a category</button></div>'}</div>
        <aside class="sidebar">
          <div class="sidebar-head"><h2>★ Claimed</h2><span class="session-tag">${session.claimed.length}</span><div class="spacer"></div>
            ${session.claimed.length ? '<button class="btn small ghost" data-act="clear-claimed">Clear</button>' : ''}</div>
          <div class="claimed-list">${claimedHTML || '<div class="session-tag" style="padding:14px;text-align:center">Claim results during a pull to set them aside here.</div>'}</div>
        </aside>
      </div>
    </div>`;

  $('#noRepeat').onchange = (e) => {
    session.noRepeat = e.target.checked;
    session.drawn = []; // toggling either way resets the drawn list
    toast(session.noRepeat ? 'No repeats ON — each entry can be drawn once this session.' : 'No repeats OFF — drawn entries are back in the pool.');
    render();
  };
  $('#sound').onchange = (e) => { s.sound = e.target.checked; saveLibrary(); };
  $('#masterVol').oninput = (e) => { s.audio.master = e.target.value / 100; SFX.setMaster(s.audio.master); };
  $('#masterVol').onchange = () => saveLibrary();
  $('#perCat').onchange = (e) => { s.perCategory = clampCount(e.target.value); e.target.value = s.perCategory; saveLibrary(); };
  app.querySelectorAll('[data-cat-count]').forEach((inp) => {
    inp.onchange = () => { const c = coll.categories.find((x) => x.id === inp.dataset.catCount); c._pullCount = clampCount(inp.value); inp.value = c._pullCount; };
  });

  app.onclick = async (e) => {
    const t = e.target.closest('button, [data-edit-entry]');
    if (!t) return;
    const d = t.dataset;
    const catOf = (id) => coll.categories.find((c) => c.id === id);
    if (d.act === 'home') { view.screen = 'home'; render(); }
    else if (d.act === 'rename') {
      const name = await promptText('Rename collection', 'Collection name', coll.name);
      if (name) { coll.name = name; saveLibrary(); render(); }
    } else if (d.act === 'add-category') {
      const name = await promptText('New category', 'Category name', '', 'Create');
      if (name) { coll.categories.push({ id: uid(), name, entries: [] }); saveLibrary(); render(); }
    } else if (d.act === 'pull-all') {
      const n = clampCount($('#perCat').value);
      startPull(coll.categories.filter((c) => c.entries.length).map((c) => ({ cat: c, count: n })), 'Entire collection');
    } else if (d.act === 'save-session') saveSessionDialog();
    else if (d.act === 'load-session') openLoadSession(coll.id);
    else if (d.act === 'settings') openSettings();
    else if (d.act === 'clear-claimed') {
      if (await confirmBox('Clear claimed?', 'Remove all claimed results from this session?', 'Clear')) { session.claimed = []; render(); }
    } else if (d.unclaim) { session.claimed = session.claimed.filter((c) => c.uid !== d.unclaim); render(); }
    else if (d.renameCat) {
      const cat = catOf(d.renameCat);
      const name = await promptText('Rename category', 'Category name', cat.name);
      if (name) { cat.name = name; saveLibrary(); render(); }
    } else if (d.deleteCat) {
      const cat = catOf(d.deleteCat);
      if (await confirmBox('Delete category?', `"${cat.name}" and its ${cat.entries.length} entries will be permanently deleted.`)) {
        coll.categories = coll.categories.filter((c) => c !== cat); saveLibrary(); render();
      }
    } else if (d.addEntry) editEntry(catOf(d.addEntry), null);
    else if (d.editEntry) { const cat = catOf(d.cat); editEntry(cat, cat.entries.find((x) => x.id === d.editEntry)); }
    else if (d.pullCat) {
      const cat = catOf(d.pullCat);
      const n = clampCount(app.querySelector(`[data-cat-count="${cat.id}"]`).value);
      cat._pullCount = n;
      startPull([{ cat, count: n }], cat.name);
    }
  };
}
const clampCount = (v) => Math.max(1, Math.min(100, Math.floor(Number(v)) || 1));

/* ---------------------------- Entry editor ---------------------------- */
function editEntry(cat, entry) {
  const isNew = !entry;
  const draft = entry ? { ...entry } : { id: uid(), name: '', rarity: 'common', image: null, thumb: null };
  const rarityOpts = RARITIES.map((r) => `<label class="r-${r}"><input type="radio" name="rarity" value="${r}" ${draft.rarity === r ? 'checked' : ''}><span class="opt">${RARITY_INFO[r].label}</span></label>`).join('');
  openModal(`
    <h2>${isNew ? 'New entry' : 'Edit entry'} <span class="session-tag">in ${esc(cat.name)}</span></h2>
    <form>
      <label class="field"><span>Name (required)</span><input type="text" name="name" maxlength="120" value="${esc(draft.name)}"></label>
      <div class="field"><span>Rarity</span><div class="rarity-pick">${rarityOpts}</div></div>
      <div class="field"><span>Image (optional)</span>
        <div class="img-pick">
          <div class="preview"></div>
          <div style="display:flex;flex-direction:column;gap:6px">
            <label class="btn small" style="text-align:center">Choose image…<input type="file" accept="image/*" hidden></label>
            <button type="button" class="btn small ghost" data-remove-img>Remove image</button>
          </div>
        </div>
      </div>
      <div class="actions">
        ${isNew ? '' : '<button type="button" class="btn danger" data-del style="margin-right:auto">Delete</button>'}
        <button type="button" class="btn ghost" data-cancel>Cancel</button>
        <button class="btn primary">${isNew ? 'Add entry' : 'Save'}</button>
      </div>
    </form>`, (box, close) => {
    const preview = box.querySelector('.preview');
    const showPreview = () => { preview.innerHTML = draft.image ? `<img src="${imgURL(draft.thumb || draft.image)}">` : 'No image'; box.querySelector('[data-remove-img]').disabled = !draft.image; };
    showPreview();
    box.querySelector('input[type=file]').onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      preview.textContent = 'Uploading…';
      try { Object.assign(draft, await uploadImage(f)); } catch (err) { toast('Image upload failed: ' + err.message); }
      showPreview();
    };
    box.querySelector('[data-remove-img]').onclick = () => { draft.image = null; draft.thumb = null; showPreview(); };
    box.querySelector('[data-cancel]').onclick = () => close(null);
    const del = box.querySelector('[data-del]');
    if (del) del.onclick = () => {
      cat.entries = cat.entries.filter((x) => x.id !== entry.id);
      saveLibrary(); close(null); render();
    };
    box.querySelector('form').onsubmit = (e) => {
      e.preventDefault();
      draft.name = box.querySelector('[name=name]').value.trim();
      draft.rarity = box.querySelector('[name=rarity]:checked').value;
      if (!draft.name) { toast('An entry must have a name.'); return; }
      if (isNew) cat.entries.push(draft);
      else Object.assign(entry, draft);
      saveLibrary(); close(null); render();
      if (isNew) toast(`Added “${draft.name}”`);
    };
  });
}

/* ---------------------------- Settings ---------------------------- */
function soundSelect(slot, current, presets) {
  const opts = Object.entries(presets).map(([id, p]) => `<option value="${id}" ${current === id ? 'selected' : ''}>${esc(p.label)}</option>`).join('');
  return `<select data-snd="${slot}">${opts}<option value="custom" ${current === 'custom' ? 'selected' : ''}>Custom file…</option></select>`;
}
function customFileUI(slot) {
  const f = settings().audio.files[slot];
  return `<span class="custom-file" data-custom="${slot}">
    <label class="btn small">${f ? '↺' : 'Choose…'}<input type="file" accept="audio/*,.mp3,.wav,.ogg,.m4a" hidden data-file="${slot}"></label>
    <span class="session-tag" title="${esc(f?.name || '')}">${esc(f?.name || 'no file')}</span></span>`;
}
const pct = (x) => Math.round(x * 100);

function openSettings() {
  const s = settings(), au = s.audio;
  const weightRows = () => {
    const total = RARITIES.reduce((n, r) => n + weightOf(r), 0);
    return RARITIES.map((r) => `<span class="rlabel r-${r}">${RARITY_INFO[r].label}</span>
      <input type="number" min="0" max="10000" step="any" data-w="${r}" value="${s.weights[r]}" style="width:90px">
      <span class="pct" data-pct="${r}">${total ? fmtPct((weightOf(r) / total) * 100) : '—'}</span>`).join('');
  };
  const slider = (key, label) => `<label class="vol-row"><span>${label}</span>
    <input type="range" min="0" max="100" value="${pct(au[key])}" data-vol="${key}"><span class="vol-val">${pct(au[key])}%</span></label>`;
  const revealRows = RARITIES.map((r) => `
    <div class="snd-row"><span class="rlabel r-${r}">${RARITY_INFO[r].label}</span>
      ${soundSelect(r, au.reveal[r], SFX.REVEALS)}
      <button class="btn small icon" data-preview="${r}" title="Preview build-up + reveal">▶</button>
      ${customFileUI(r)}</div>`).join('');

  openModal(`
    <h2>⚙ Settings</h2>
    <h3 class="set-h">🔊 Sound</h3>
    <label class="switch" style="margin-bottom:12px"><input type="checkbox" data-enable ${s.sound ? 'checked' : ''}><span class="track"></span><span>Sound effects</span></label>
    ${slider('master', 'Master volume')}
    ${slider('buildVol', 'Build-up volume')}
    ${slider('revealVol', 'Reveal volume')}
    <div class="set-sub">Build-up sound <span class="session-tag">— plays while the orb charges</span></div>
    <div class="snd-row"><span class="session-tag">All rarities</span>${soundSelect('buildup', au.buildup, SFX.BUILDUPS)}
      <button class="btn small icon" data-preview="buildup" title="Preview">▶</button>${customFileUI('buildup')}</div>
    <div class="set-sub">Reveal sound <span class="session-tag">— per rarity; every preset gets bigger for rarer pulls</span></div>
    <div class="snd-row"><span class="session-tag">Set all to</span>
      <select data-all><option value="">—</option>${Object.entries(SFX.REVEALS).map(([id, p]) => `<option value="${id}">${esc(p.label)}</option>`).join('')}</select>
      <button class="btn small ghost" data-surprise>🎲 Mix it up</button></div>
    ${revealRows}
    <h3 class="set-h">🎲 Rarity weights</h3>
    <p class="session-tag" style="margin-top:0">An entry's chance is its rarity's weight divided by the total weight of all entries in its category. The percentage shown is for a category containing one entry of each rarity.</p>
    <div class="weights">${weightRows()}</div>
    <div class="actions"><button class="btn ghost" data-reset style="margin-right:auto">Reset weights</button><button class="btn primary" data-done>Done</button></div>`,
  (box, close) => {
    box.parentElement.classList.add('wide');
    const syncCustom = () => box.querySelectorAll('[data-snd]').forEach((sel) => {
      box.querySelector(`[data-custom="${sel.dataset.snd}"]`).classList.toggle('hidden', sel.value !== 'custom');
    });
    syncCustom();
    box.querySelector('[data-enable]').onchange = (e) => { s.sound = e.target.checked; };
    box.querySelectorAll('[data-vol]').forEach((inp) => {
      inp.oninput = () => { au[inp.dataset.vol] = inp.value / 100; inp.nextElementSibling.textContent = inp.value + '%'; if (inp.dataset.vol === 'master') SFX.setMaster(au.master); };
    });
    box.querySelectorAll('[data-snd]').forEach((sel) => {
      sel.onchange = () => {
        if (sel.dataset.snd === 'buildup') au.buildup = sel.value; else au.reveal[sel.dataset.snd] = sel.value;
        syncCustom();
      };
    });
    box.querySelector('[data-all]').onchange = (e) => {
      if (!e.target.value) return;
      RARITIES.forEach((r) => { au.reveal[r] = e.target.value; box.querySelector(`[data-snd="${r}"]`).value = e.target.value; });
      e.target.value = ''; syncCustom();
    };
    box.querySelector('[data-surprise]').onclick = () => {
      const ids = Object.keys(SFX.REVEALS).filter((id) => id !== 'none');
      RARITIES.forEach((r) => { au.reveal[r] = ids[Math.floor(Math.random() * ids.length)]; box.querySelector(`[data-snd="${r}"]`).value = au.reveal[r]; });
      syncCustom();
    };
    box.querySelectorAll('[data-file]').forEach((inp) => {
      inp.onchange = async () => {
        const f = inp.files[0];
        if (!f) return;
        try {
          const file = await uploadFile(f, f.name);
          au.files[inp.dataset.file] = { file, name: f.name };
          SFX.preload(file);
          const wrap = box.querySelector(`[data-custom="${inp.dataset.file}"] .session-tag`);
          wrap.textContent = f.name; wrap.title = f.name;
        } catch (err) { toast('Could not use that file: ' + err.message); }
      };
    });
    let stopPrev = [];
    box.querySelectorAll('[data-preview]').forEach((b) => {
      b.onclick = () => {
        stopPrev.forEach((f) => f()); stopPrev = [];
        if (!s.sound) { toast('Sound effects are turned off.'); return; }
        const slot = b.dataset.preview;
        if (slot === 'buildup') { stopPrev.push(SFX.buildup(soundCfg('build'), RARITY_INFO.legendary.build, 3)); return; }
        const rank = RARITIES.indexOf(slot), ms = Math.min(RARITY_INFO[slot].build, 2000);
        const stop = SFX.buildup(soundCfg('build'), ms, rank);
        stopPrev.push(stop);
        const t = setTimeout(() => { stop(); stopPrev.push(SFX.reveal(soundCfg('reveal', slot), rank)); }, ms);
        stopPrev.push(() => clearTimeout(t));
      };
    });
    const refresh = () => {
      const total = RARITIES.reduce((n, r) => n + weightOf(r), 0);
      RARITIES.forEach((r) => { box.querySelector(`[data-pct="${r}"]`).textContent = total ? fmtPct((weightOf(r) / total) * 100) : '—'; });
    };
    box.querySelectorAll('[data-w]').forEach((inp) => { inp.oninput = () => { s.weights[inp.dataset.w] = Math.max(0, Number(inp.value) || 0); refresh(); }; });
    box.querySelector('[data-reset]').onclick = () => {
      RARITIES.forEach((r) => { s.weights[r] = RARITY_INFO[r].weight; box.querySelector(`[data-w="${r}"]`).value = s.weights[r]; });
      refresh();
    };
    box.querySelector('[data-done]').onclick = () => close(true);
    box._cleanup = () => stopPrev.forEach((f) => f());
  }).then(() => { $('#modal').classList.remove('wide'); saveLibrary(); render(); });
}

/* ---------------------------- Save / load sessions ---------------------------- */
async function saveSessionDialog() {
  const coll = getCollection();
  const name = await promptText('Save session', 'Session name', session.name || `${coll.name} — ${new Date().toLocaleDateString()}`);
  if (!name) return;
  const existing = (await api('GET', '/api/sessions')).find((x) => x.collectionId === coll.id && x.name === name);
  session.id = existing ? existing.id : (session.name === name && session.id) || uid();
  session.name = name;
  const payload = { ...session, collectionName: coll.name, savedAt: new Date().toISOString() };
  await api('PUT', '/api/sessions/' + session.id, payload);
  toast(`Session “${name}” saved.`);
  render();
}

async function openLoadSession(collectionId) {
  let list = await api('GET', '/api/sessions');
  if (collectionId) list = list.filter((x) => x.collectionId === collectionId);
  list.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
  const rows = list.map((x) => {
    const exists = !!getCollection(x.collectionId);
    return `<div class="session-row">
      <div class="txt"><div><b>${esc(x.name)}</b></div>
        <div class="sub">${esc(x.collectionName || '')}${exists ? '' : ' (collection deleted)'} · ${new Date(x.savedAt).toLocaleString()}<br>
        No repeats: ${x.noRepeat ? `on (${x.drawn.length} drawn)` : 'off'} · ${x.claimed.length} claimed</div></div>
      <button class="btn small primary" data-load="${x.id}" ${exists ? '' : 'disabled'}>Load</button>
      <button class="btn small icon danger" data-del="${x.id}" title="Delete saved session">🗑</button>
    </div>`;
  }).join('');
  openModal(`
    <h2>📂 Load session</h2>
    ${rows || '<div class="empty" style="padding:24px">No saved sessions yet. Open a collection and use “Save session”.</div>'}
    <div class="actions"><button class="btn ghost" data-close>Close</button></div>`,
  (box, close) => {
    box.querySelector('[data-close]').onclick = () => close(null);
    box.querySelectorAll('[data-load]').forEach((b) => b.onclick = () => {
      const x = list.find((s) => s.id === b.dataset.load);
      const restored = { id: x.id, name: x.name, collectionId: x.collectionId, noRepeat: !!x.noRepeat, drawn: x.drawn || [], claimed: (x.claimed || []).map((c) => refreshSnapshot({ ...c, collectionId: x.collectionId })) };
      close(null);
      openCollection(x.collectionId, restored);
      toast(`Loaded session “${x.name}”.`);
    });
    box.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
      const x = list.find((s) => s.id === b.dataset.del);
      await api('DELETE', '/api/sessions/' + x.id);
      if (session && session.id === x.id) { session.id = null; session.name = null; }
      close(null);
      openLoadSession(collectionId);
      toast('Saved session deleted.');
    });
  });
}

/* ======================================================================
   Drawing
   ====================================================================== */
function weightedPick(pool) {
  const total = pool.reduce((s, e) => s + weightOf(e.rarity), 0);
  if (total <= 0) return pool[Math.floor(Math.random() * pool.length)];
  let r = Math.random() * total;
  for (const e of pool) { r -= weightOf(e.rarity); if (r < 0) return e; }
  return pool[pool.length - 1];
}

// plan: [{cat, count}] -> list of result objects
function drawResults(plan) {
  const results = [];
  let shortfall = 0;
  const excluded = session.noRepeat ? drawnSet() : new Set();
  for (const { cat, count } of plan) {
    for (let i = 0; i < count; i++) {
      const pool = cat.entries.filter((e) => !excluded.has(e.id) && (weightOf(e.rarity) > 0 || cat.entries.every((x) => weightOf(x.rarity) === 0)));
      if (!pool.length) { shortfall += count - i; break; }
      const e = weightedPick(pool);
      if (session.noRepeat) { excluded.add(e.id); session.drawn.push(e.id); }
      results.push({
        uid: uid(), entryId: e.id, categoryId: cat.id, categoryName: cat.name,
        name: e.name, rarity: e.rarity, image: e.image || null, thumb: e.thumb || null,
      });
    }
  }
  return { results, shortfall };
}

const isClaimed = (r) => session.claimed.some((c) => c.uid === r.uid);
function toggleClaim(r) {
  if (isClaimed(r)) session.claimed = session.claimed.filter((c) => c.uid !== r.uid);
  else session.claimed.push({ ...r, claimedAt: Date.now() });
}

/* ======================================================================
   Sound (Web Audio synth — no files needed)
   ====================================================================== */
function soundCfg(kind, rarity) {
  const s = settings(), au = s.audio;
  const slot = kind === 'build' ? 'buildup' : rarity;
  const id = kind === 'build' ? au.buildup : au.reveal[rarity];
  return { enabled: s.sound, master: au.master, volume: kind === 'build' ? au.buildVol : au.revealVol, id, file: au.files[slot]?.file };
}

/* ======================================================================
   Particle FX on canvas
   ====================================================================== */
const DPR = Math.min(window.devicePixelRatio || 1, 1.25);
const MAX_PARTS = 700;
const fx = {
  canvas: null, ctx: null, parts: [], raf: 0, mode: null, color: '#fff', rainbow: false, emitInward: 0, rainConfetti: 0,
  init() {
    this.canvas = $('#fx'); this.ctx = this.canvas.getContext('2d');
    const resize = () => { this.canvas.width = innerWidth * DPR; this.canvas.height = innerHeight * DPR; };
    addEventListener('resize', resize); resize();
  },
  start() { if (!this.raf) this.raf = requestAnimationFrame(() => this.tick()); },
  stop() { cancelAnimationFrame(this.raf); this.raf = 0; this.parts = []; this.emitInward = 0; this.rainConfetti = 0; this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); },
  col() { return this.rainbow ? `hsl(${Math.random() * 360},100%,65%)` : this.color; },
  inward(n) {
    const W = this.canvas.width, H = this.canvas.height, cx = W / 2, cy = H / 2;
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * Math.PI * 2, dist = Math.max(W, H) * (0.45 + Math.random() * 0.3);
      const x = cx + Math.cos(ang) * dist, y = cy + Math.sin(ang) * dist;
      const sp = (8 + Math.random() * 10) * DPR;
      this.parts.push({ x, y, vx: -Math.cos(ang) * sp, vy: -Math.sin(ang) * sp, life: dist / sp, max: dist / sp, size: (1 + Math.random() * 2.5) * DPR, color: this.col(), streak: true });
    }
  },
  burst(n, power = 1) {
    const cx = this.canvas.width / 2, cy = this.canvas.height / 2;
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * Math.PI * 2, sp = (4 + Math.random() * 16 * power) * DPR;
      this.parts.push({ x: cx, y: cy, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, life: 50 + Math.random() * 60, max: 110, size: (2 + Math.random() * 4) * DPR, color: this.col(), drag: 0.95, grav: 0.12 * DPR, spark: true });
    }
  },
  firework() {
    const W = this.canvas.width, H = this.canvas.height;
    const x = W * (0.15 + Math.random() * 0.7), y = H * (0.15 + Math.random() * 0.5), c = this.col();
    for (let i = 0; i < 50; i++) {
      const ang = (i / 50) * Math.PI * 2, sp = (3 + Math.random() * 3) * DPR;
      this.parts.push({ x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, life: 60 + Math.random() * 30, max: 90, size: 2.2 * DPR, color: this.rainbow ? this.col() : c, drag: 0.96, grav: 0.05 * DPR, spark: true });
    }
  },
  confetti(n) {
    const W = this.canvas.width;
    for (let i = 0; i < n; i++) {
      this.parts.push({ x: Math.random() * W, y: -20, vx: (Math.random() - 0.5) * 3, vy: (2 + Math.random() * 3) * DPR, life: 400, max: 400, size: (4 + Math.random() * 5) * DPR, color: `hsl(${Math.random() * 360},100%,62%)`, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.3, confetti: true });
    }
  },
  tick() {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (this.parts.length < MAX_PARTS) {
      if (this.emitInward) this.inward(this.emitInward);
      if (this.rainConfetti && Math.random() < this.rainConfetti) this.confetti(2);
      if (this.fireworks && Math.random() < this.fireworks) this.firework();
    }
    ctx.globalCompositeOperation = 'lighter';
    const next = [];
    for (const p of this.parts) {
      p.life--;
      if (p.drag) { p.vx *= p.drag; p.vy *= p.drag; }
      if (p.grav) p.vy += p.grav;
      const ox = p.x, oy = p.y;
      p.x += p.vx; p.y += p.vy;
      if (p.life <= 0 || p.y > canvas.height + 40) continue;
      const a = Math.min(1, p.life / p.max * 1.5);
      if (p.confetti) {
        ctx.globalCompositeOperation = 'source-over';
        p.rot += p.vr;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillStyle = p.color; ctx.globalAlpha = a;
        ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2); ctx.restore();
        ctx.globalCompositeOperation = 'lighter';
      } else if (p.streak) {
        ctx.strokeStyle = p.color; ctx.globalAlpha = 0.8; ctx.lineWidth = p.size;
        ctx.beginPath(); ctx.moveTo(ox - p.vx * 2, oy - p.vy * 2); ctx.lineTo(p.x, p.y); ctx.stroke();
      } else {
        ctx.fillStyle = p.color; ctx.globalAlpha = a;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (0.5 + a / 2), 0, Math.PI * 2); ctx.fill();
      }
      next.push(p);
    }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    this.parts = next;
    this.raf = requestAnimationFrame(() => this.tick());
  },
};

/* ======================================================================
   Gacha sequence
   ====================================================================== */
const G = {
  el: null, results: [], index: 0, phase: 'idle', timers: [], stopRiser: null, title: '', plan: null,
};
const wait = (ms) => new Promise((r) => G.timers.push(setTimeout(r, ms)));
function clearTimers() { G.timers.forEach(clearTimeout); G.timers = []; }

function startPull(plan, title) {
  if (!plan.length) { toast('Nothing to pull — add some entries first.'); return; }
  const { results, shortfall } = drawResults(plan);
  if (!results.length) {
    toast(session.noRepeat ? 'Every entry has already been drawn this session. Toggle “No repeats” to reset.' : 'Nothing to pull.', 4000);
    render();
    return;
  }
  if (shortfall) toast(`${shortfall} pull${shortfall === 1 ? '' : 's'} skipped — not enough undrawn entries left.`, 4000);
  G.results = results; G.index = 0; G.title = title; G.plan = plan;
  G.el.classList.remove('hidden');
  document.body.classList.add('gacha-open');
  fx.start();
  playCurrent();
}

function setGlow(color, rainbow) {
  G.el.style.setProperty('--gc', color);
  G.el.classList.toggle('rainbow', !!rainbow);
  fx.color = color; fx.rainbow = !!rainbow;
}

async function playCurrent() {
  clearTimers();
  const r = G.results[G.index];
  const info = RARITY_INFO[r.rarity];
  const rank = RARITIES.indexOf(r.rarity);
  const el = G.el;
  const card = $('.g-card', el), orb = $('.g-orb', el), rays = $('.g-rays', el);

  G.phase = 'build';
  card.classList.add('hidden'); card.innerHTML = '';
  orb.classList.remove('hidden');
  $('.g-actions', el).classList.add('hidden');
  $('.g-hint', el).classList.remove('hidden');
  $('.g-hint', el).textContent = 'Click to reveal';
  rays.classList.remove('on');
  el.classList.remove('shake', 'r-exotic-reveal');
  el.classList.remove('building'); void el.offsetWidth; // restart charge animation
  el.style.setProperty('--bd', info.build + 'ms');
  el.classList.add('building');
  el.style.setProperty('--sk', '2px');
  $('.g-progress', el).innerHTML = `<b>${esc(G.title)}</b>${G.title === r.categoryName ? '' : ` · ${esc(r.categoryName)}`} · Pull <b>${G.index + 1}</b> / ${G.results.length}`;
  $('.g-skip', el).classList.toggle('hidden', G.results.length < 2);
  fx.fireworks = 0; fx.rainConfetti = 0;

  // Stage 1: everyone starts with a white glow. Rarer pulls escalate through the rarity colors.
  setGlow('#ffffff');
  fx.emitInward = 1;
  G.stopReveal && G.stopReveal(); G.stopReveal = null;
  G.stopRiser = SFX.buildup(soundCfg('build'), info.build, rank);
  if (r.image) { const im = new Image(); im.src = imgURL(r.image); im.decode && im.decode().catch(() => {}); }
  const ladder = RARITIES.slice(1, rank + 1); // colors to step through
  const stepTime = info.build * 0.75 / Math.max(1, ladder.length);
  const myIndex = G.index;
  let tAcc = info.build * 0.25;
  ladder.forEach((rr, i) => {
    G.timers.push(setTimeout(() => {
      if (G.index !== myIndex || G.phase !== 'build') return;
      setGlow(RARITY_INFO[rr].color, rr === 'exotic');
      fx.emitInward = 1 + i * 2;
      if (rr === 'legendary' || rr === 'exotic') { el.classList.add('shake'); el.style.setProperty('--sk', rr === 'exotic' ? '7px' : '3px'); }
      fx.burst(10 + i * 10, 0.5);
    }, tAcc + i * stepTime));
  });
  await wait(info.build);
  if (G.index === myIndex && G.phase === 'build') reveal();
}

function reveal() {
  if (G.phase !== 'build') return;
  clearTimers();
  G.phase = 'reveal';
  G.stopRiser && G.stopRiser(); G.stopRiser = null;
  const r = G.results[G.index];
  const info = RARITY_INFO[r.rarity];
  const rank = RARITIES.indexOf(r.rarity);
  const el = G.el;
  const card = $('.g-card', el);

  setGlow(info.color, r.rarity === 'exotic');
  el.classList.remove('building', 'shake');
  fx.emitInward = 0;
  $('.g-orb', el).classList.add('hidden');
  $('.g-hint', el).classList.add('hidden');

  const flash = $('.g-flash', el);
  flash.classList.remove('go'); void flash.offsetWidth; flash.classList.add('go');
  G.stopReveal = SFX.reveal(soundCfg('reveal', r.rarity), rank);

  // Effects scale with rarity.
  fx.burst([30, 60, 110, 180, 300][rank], [0.6, 0.8, 1, 1.3, 1.6][rank]);
  if (rank >= 2) $('.g-rays', el).classList.add('on');
  if (rank >= 3) { fx.fireworks = rank === 4 ? 0.09 : 0.04; el.classList.add('shake'); el.style.setProperty('--sk', rank === 4 ? '8px' : '4px'); G.timers.push(setTimeout(() => el.classList.remove('shake'), rank === 4 ? 700 : 400)); }
  if (rank === 4) { fx.rainConfetti = 0.9; fx.confetti(80); el.classList.add('r-exotic-reveal'); }

  const dupCount = G.results.slice(0, G.index).filter((x) => x.entryId === r.entryId).length;
  card.className = `g-card r-${r.rarity}`;
  card.innerHTML = `
    <div class="shine"></div>
    ${dupCount ? `<div class="dup">Duplicate ×${dupCount + 1}</div>` : ''}
    <div class="art">${artHTML(r, 'full')}</div>
    <div class="cat">${esc(r.categoryName)}</div>
    <div class="nm">${esc(r.name)}</div>
    <div class="stars">${Array.from({ length: info.stars }, (_, i) => `<span style="animation-delay:${0.45 + i * 0.13}s">★</span>`).join('')}</div>
    <div class="rl">${info.label}</div>`;

  G.timers.push(setTimeout(() => {
    $('.g-actions', el).classList.remove('hidden');
    updateClaimBtn();
    $('.g-next', el).textContent = G.index < G.results.length - 1 ? 'Next ▶' : (G.results.length > 1 ? 'View results ▶' : 'Done');
  }, 450));
}

function updateClaimBtn() {
  const b = $('.g-claim', G.el);
  const claimed = isClaimed(G.results[G.index]);
  b.classList.toggle('claimed', claimed);
  b.textContent = claimed ? '★ Claimed' : '☆ Claim';
}

function nextResult() {
  if (G.phase !== 'reveal') return;
  if (G.index < G.results.length - 1) { G.index++; playCurrent(); }
  else finishPull();
}

function finishPull() {
  clearTimers();
  G.stopRiser && G.stopRiser(); G.stopRiser = null;
  G.phase = 'idle';
  document.body.classList.remove('gacha-open');
  G.el.classList.add('hidden');
  G.el.classList.remove('building', 'shake', 'rainbow', 'r-exotic-reveal');
  $('.g-rays', G.el).classList.remove('on');
  fx.stop();
  render();
  if (G.results.length > 1) showSummary();
}

function showSummary() {
  const sm = $('#summary');
  const results = G.results;
  const byCat = [];
  for (const r of results) {
    let g = byCat.find((x) => x.id === r.categoryId);
    if (!g) byCat.push(g = { id: r.categoryId, name: r.categoryName, items: [] });
    g.items.push(r);
  }
  const counts = RARITIES.map((rr) => [rr, results.filter((r) => r.rarity === rr).length]).filter(([, n]) => n);
  let delay = 0;
  sm.innerHTML = `<div class="inner">
    <div class="s-head">
      <h1>✦ Results</h1><span class="session-tag">${esc(G.title)} · ${results.length} pulls</span>
      <div class="s-stats">${counts.map(([rr, n]) => `<span class="chip r-${rr}"><span class="rlabel">${RARITY_INFO[rr].label}</span> ×${n}</span>`).join('')}</div>
      <div class="spacer"></div>
      <button class="btn" data-claim-all>☆ Claim all</button>
      <button class="btn pull" data-again>✦ Pull again</button>
      <button class="btn primary" data-close>Close</button>
    </div>
    ${byCat.map((g) => `<div class="s-cat"><h2>${esc(g.name)}</h2><div class="s-grid">${g.items.map((r) => `
      <div class="s-card r-${r.rarity}" style="animation-delay:${(delay += 0.04).toFixed(2)}s">
        <div class="thumb">${artHTML(r)}</div>
        <div class="info"><div class="name">${esc(r.name)}</div><span class="rlabel">${'★'.repeat(RARITY_INFO[r.rarity].stars)} ${RARITY_INFO[r.rarity].label}</span>
        <button class="btn small claim-btn ${isClaimed(r) ? 'claimed' : ''}" data-claim="${r.uid}">${isClaimed(r) ? '★ Claimed' : '☆ Claim'}</button></div>
      </div>`).join('')}</div></div>`).join('')}
  </div>`;
  sm.classList.remove('hidden');
  sm.scrollTop = 0;
  sm.onclick = (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.claim) {
      const r = results.find((x) => x.uid === t.dataset.claim);
      toggleClaim(r);
      t.classList.toggle('claimed', isClaimed(r));
      t.textContent = isClaimed(r) ? '★ Claimed' : '☆ Claim';
      render();
    } else if ('claimAll' in t.dataset) {
      results.forEach((r) => { if (!isClaimed(r)) toggleClaim(r); });
      showSummary(); render();
    } else if ('close' in t.dataset) {
      sm.classList.add('hidden');
    } else if ('again' in t.dataset) {
      sm.classList.add('hidden');
      // Re-resolve categories in case they changed.
      const coll = getCollection();
      const plan = G.plan.map((p) => ({ cat: coll.categories.find((c) => c.id === p.cat.id), count: p.count })).filter((p) => p.cat && p.cat.entries.length);
      startPull(plan, G.title);
    }
  };
}

function initGacha() {
  G.el = $('#gacha');
  G.el.addEventListener('click', (e) => {
    if (e.target.closest('.g-skip')) { e.stopPropagation(); finishPull(); return; }
    if (e.target.closest('.g-claim')) { toggleClaim(G.results[G.index]); updateClaimBtn(); return; }
    if (e.target.closest('.g-next')) { nextResult(); return; }
    if (e.target.closest('.g-card')) return;
    if (G.phase === 'build') reveal();
    else if (G.phase === 'reveal' && !$('.g-actions', G.el).classList.contains('hidden')) nextResult();
  });
  document.addEventListener('keydown', (e) => {
    if (G.phase === 'idle') {
      if (e.key === 'Escape' && !$('#modal').classList.contains('hidden')) closeModal(null);
      else if (e.key === 'Escape' && !$('#summary').classList.contains('hidden')) $('#summary').classList.add('hidden');
      return;
    }
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); if (G.phase === 'build') reveal(); else nextResult(); }
    else if (e.key.toLowerCase() === 'c' && G.phase === 'reveal') { toggleClaim(G.results[G.index]); updateClaimBtn(); }
    else if (e.key === 'Escape' && G.results.length > 1) finishPull();
  });
}

/* ======================================================================
   Boot
   ====================================================================== */
(async function boot() {
  fx.init();
  initGacha();
  try {
    const data = await api('GET', '/api/library');
    library = { collections: [], settings: {}, ...data };
    library.collections.forEach((c) => { c.categories = c.categories || []; c.categories.forEach((k) => { k.entries = k.entries || []; }); });
  } catch (e) { toast('Could not load library: ' + e.message, 6000); }
  settings();
  render();
  optimizeExistingImages();
})();
