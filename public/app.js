// Right-Click-Sort — front-end logic

const entryView = document.getElementById('entry-view');
const workspaceView = document.getElementById('workspace-view');
const entryStatus = document.getElementById('entry-status');
const canvasEl = document.getElementById('canvas');
const canvasWrap = document.getElementById('canvas-wrap');
const canvasScroller = document.getElementById('canvas-scroller');
const canvasW = document.getElementById('canvas-w');
const canvasH = document.getElementById('canvas-h');
const paddingRange = document.getElementById('padding-range');
const bgColor = document.getElementById('bg-color');
const paddingValue = document.getElementById('padding-value');
const exportBtn = document.getElementById('export-btn');
const backBtn = document.getElementById('back-btn');

// Each item: { src, name, natW, natH, width (current display width px) }
let items = [];
let itemEls = [];

// The canvas keeps its logical pixel size; on small screens it is visually
// scaled down to fit. Pointer math divides by this where needed.
let viewScale = 1;

// ---------- Undo / redo ----------

const undoBtn = document.getElementById('undo-btn');
const redoBtn = document.getElementById('redo-btn');
const HISTORY_MAX = 50;
let history = [];
let future = [];

const snapshotItems = () => items.map((it) => ({ ...it }));

function updateUndoButtons() {
  undoBtn.disabled = !history.length;
  redoBtn.disabled = !future.length;
}

// Push a pre-mutation snapshot onto the undo stack.
function commitHistory(pre) {
  history.push(pre);
  if (history.length > HISTORY_MAX) history.shift();
  future = [];
  updateUndoButtons();
}

function resetHistory() {
  history = [];
  future = [];
  updateUndoButtons();
}

function undo() {
  if (!history.length) return;
  future.push(snapshotItems());
  items = history.pop();
  updateUndoButtons();
  render();
}

function redo() {
  if (!future.length) return;
  history.push(snapshotItems());
  items = future.pop();
  updateUndoButtons();
  render();
}

undoBtn.addEventListener('click', undo);
redoBtn.addEventListener('click', redo);

window.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey)) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea') return;
  if (e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
  } else if (e.key.toLowerCase() === 'y') {
    e.preventDefault();
    redo();
  }
});

const SNAP_DIST = 8;

// data: URLs (on-chain SVG art) load directly; everything else goes through
// the proxy so canvas export stays un-tainted.
const proxied = (url) =>
  url.startsWith('data:') ? url : `/api/img?u=${encodeURIComponent(url)}`;

// Primary image source: wsrv.nl, a caching/resizing image CDN. Originals are
// often multi-MB files on slow IPFS gateways; a cached ≤1200px version loads
// orders of magnitude faster, serves CORS headers (export stays clean), and
// parallelizes freely. Our own proxy remains the fallback.
const cdnResized = (url) =>
  `https://wsrv.nl/?url=${encodeURIComponent(url)}&w=1200&fit=inside&we=1&maxage=1y`;

const gapPx = () => parseInt(paddingRange.value, 10) || 0;
const canvasWidth = () => parseInt(canvasW.value, 10) || 1200;
const canvasHeight = () => parseInt(canvasH.value, 10) || 1200;
const itemHeight = (it) => it.width * (it.natH / it.natW);

// ---------- Entry / loading ----------

function setStatus(msg, isError = false) {
  entryStatus.hidden = !msg;
  entryStatus.textContent = msg;
  entryStatus.classList.toggle('error', isError);
}

// ---------- Profile picker (search → collections → items) ----------

const profileInput = document.getElementById('profile-input');
const profileResults = document.getElementById('profile-results');
const collectionsList = document.getElementById('collections-list');
let searchTimer = null;
let activeProfile = null;

const escapeHtml = (s) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

profileInput.addEventListener('input', () => {
  activeProfile = null;
  collectionsList.hidden = true;
  clearTimeout(searchTimer);
  const q = profileInput.value.trim();
  if (q.length < 3) {
    profileResults.hidden = true;
    return;
  }
  searchTimer = setTimeout(() => searchProfiles(q), 400);
});

document.addEventListener('pointerdown', (e) => {
  if (!profileResults.hidden && !e.target.closest('.picker-field')) {
    profileResults.hidden = true;
  }
  const addResultsEl = document.getElementById('add-results');
  if (!addResultsEl.hidden && !e.target.closest('#add-control')) {
    addResultsEl.hidden = true;
  }
  const exportMenuEl = document.getElementById('export-menu');
  if (!exportMenuEl.hidden && !e.target.closest('#export-split')) {
    exportMenuEl.hidden = true;
  }
});

async function searchProfiles(q) {
  profileResults.innerHTML = '<div class="dropdown-note">Searching…</div>';
  profileResults.hidden = false;
  try {
    const r = await fetch(`/api/profile?q=${encodeURIComponent(q)}`);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `Server responded ${r.status}`);
    if (q !== profileInput.value.trim()) return; // stale response
    if (!d.results.length) {
      profileResults.innerHTML =
        '<div class="dropdown-note">No profiles found — try an exact OpenSea username, ENS name or 0x address</div>';
      return;
    }
    profileResults.innerHTML = '';
    d.results.forEach((p) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dropdown-row';
      b.innerHTML = `<span>${escapeHtml(p.name)}</span><span class="addr">${p.address.slice(0, 6)}…${p.address.slice(-4)}</span>`;
      b.addEventListener('click', () => pickProfile(p));
      profileResults.appendChild(b);
    });
  } catch (e) {
    profileResults.innerHTML = `<div class="dropdown-note">${escapeHtml(e.message)}</div>`;
  }
}

const CHAINS = ['ethereum', 'base', 'polygon', 'arbitrum', 'optimism', 'zksync', 'gnosis'];
const MAX_FILTER_RESULTS = 100;
let allCollections = [];

// Same ordering as the server: alphabetical, address-only names last.
function sortCollections(list) {
  const isAddrName = (n) => /^0x[0-9a-f]{4}/i.test(n);
  list.sort((a, b) => {
    if (isAddrName(a.name) !== isAddrName(b.name)) return isAddrName(a.name) ? 1 : -1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
  });
}

async function pickProfile(p) {
  activeProfile = p;
  profileInput.value = p.name;
  profileResults.hidden = true;
  collectionsList.hidden = false;
  allCollections = [];

  // Progress: one parallel request per chain, bar advances as chains finish.
  collectionsList.innerHTML = `
    <div class="col-progress">
      <div class="progress-track"><div class="progress-fill" style="width:0%"></div></div>
      <div class="dropdown-note" id="col-progress-note">Loading collections… 0/${CHAINS.length} chains</div>
    </div>`;
  const fill = collectionsList.querySelector('.progress-fill');
  const note = collectionsList.querySelector('#col-progress-note');
  let done = 0;

  await Promise.allSettled(
    CHAINS.map(async (chain) => {
      try {
        const r = await fetch(`/api/collections?address=${p.address}&chain=${chain}`);
        const d = await r.json();
        if (r.ok) allCollections.push(...d.collections);
      } catch {}
      done++;
      fill.style.width = `${Math.round((done / CHAINS.length) * 100)}%`;
      note.textContent = `Loading collections… ${done}/${CHAINS.length} chains · ${allCollections.length} found`;
    })
  );

  if (activeProfile !== p) return; // user picked a different profile meanwhile
  if (!allCollections.length) {
    collectionsList.innerHTML =
      '<div class="dropdown-note">No NFT collections found for this wallet</div>';
    return;
  }
  sortCollections(allCollections);

  collectionsList.innerHTML = `
    <input id="collections-search" type="text" spellcheck="false" autocomplete="off"
      placeholder="Type to filter ${allCollections.length} collections…" />
    <div id="collections-results"></div>`;
  const search = collectionsList.querySelector('#collections-search');
  const results = collectionsList.querySelector('#collections-results');

  const renderMatches = async () => {
    const raw = search.value.trim();
    const q = raw.toLowerCase();
    results.innerHTML = '';
    if (!q) {
      results.innerHTML = `<div class="dropdown-note">${allCollections.length} collections loaded — start typing to filter. You can also paste an OpenSea collection URL.</div>`;
      return;
    }

    // Pasted OpenSea collection URL: resolve the slug to its contract, since
    // many contracts (ERC-1155 editions) have no on-chain name to match on.
    const slugMatch = raw.match(/opensea\.io\/collection\/([a-z0-9-]+)/i);
    if (slugMatch) {
      results.innerHTML = '<div class="dropdown-note">Resolving collection…</div>';
      try {
        const r = await fetch(`/api/resolve-collection?slug=${encodeURIComponent(slugMatch[1])}`);
        const d = await r.json();
        if (search.value.trim() !== raw) return; // stale
        if (!r.ok) throw new Error(d.error || `Server responded ${r.status}`);
        const held = allCollections.find(
          (c) => c.contract === d.contract.toLowerCase() && c.chain === d.chain
        );
        results.innerHTML = '';
        if (held) {
          results.appendChild(collectionRow({ ...held, name: `${slugMatch[1]} (${held.name})` }));
        } else {
          results.innerHTML =
            '<div class="dropdown-note">This wallet holds nothing from that collection (or its chain is not supported).</div>';
        }
      } catch (e) {
        results.innerHTML = `<div class="dropdown-note">${escapeHtml(e.message)}</div>`;
      }
      return;
    }

    const matches = allCollections.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        (c.symbol || '').toLowerCase().includes(q) ||
        c.contract.includes(q)
    );
    if (!matches.length) {
      results.innerHTML =
        '<div class="dropdown-note">No collections match — try pasting the OpenSea collection URL</div>';
      return;
    }
    matches.slice(0, MAX_FILTER_RESULTS).forEach((c) => results.appendChild(collectionRow(c)));
    if (matches.length > MAX_FILTER_RESULTS) {
      results.insertAdjacentHTML(
        'beforeend',
        `<div class="dropdown-note">+${matches.length - MAX_FILTER_RESULTS} more — keep typing to narrow down</div>`
      );
    }
  };

  search.addEventListener('input', renderMatches);
  renderMatches();
  search.focus();
}

function collectionRow(c, onClick = pickCollection) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'collection-row';
  const thumb = c.thumb
    ? `<img src="${escapeHtml(proxied(c.thumb))}" alt="" loading="lazy" />`
    : '<span class="thumb-placeholder"></span>';
  const chainBadge =
    c.chain && c.chain !== 'ethereum' ? `<span class="col-chain">${escapeHtml(c.chain)}</span>` : '';
  b.innerHTML = `${thumb}<span class="col-name">${escapeHtml(c.name)}</span>${chainBadge}<span class="col-count">${c.count} item${c.count === 1 ? '' : 's'}</span>`;
  b.addEventListener('click', () => onClick(c));
  return b;
}

async function fetchCollectionImages(c) {
  const r = await fetch(
    `/api/collection-items?address=${activeProfile.address}&contract=${c.contract}&chain=${encodeURIComponent(c.chain || 'ethereum')}`
  );
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || `Server responded ${r.status}`);
  return d.images;
}

// ---------- Toolbar: add more collections to the current grid ----------

const addSearch = document.getElementById('add-search');
const addResults = document.getElementById('add-results');

addSearch.addEventListener('input', async () => {
  const raw = addSearch.value.trim();
  if (!raw) {
    addResults.hidden = true;
    return;
  }
  addResults.hidden = false;

  if (!activeProfile || !allCollections.length) {
    addResults.innerHTML = '<div class="dropdown-note">No profile loaded</div>';
    return;
  }

  // Pasted OpenSea collection URL: resolve slug → contract (unnamed contracts).
  const slugMatch = raw.match(/opensea\.io\/collection\/([a-z0-9-]+)/i);
  if (slugMatch) {
    addResults.innerHTML = '<div class="dropdown-note">Resolving collection…</div>';
    try {
      const r = await fetch(`/api/resolve-collection?slug=${encodeURIComponent(slugMatch[1])}`);
      const d = await r.json();
      if (addSearch.value.trim() !== raw) return; // stale
      if (!r.ok) throw new Error(d.error || `Server responded ${r.status}`);
      const held = allCollections.find(
        (c) => c.contract === d.contract.toLowerCase() && c.chain === d.chain
      );
      addResults.innerHTML = '';
      if (held) {
        addResults.appendChild(
          collectionRow({ ...held, name: `${slugMatch[1]} (${held.name})` }, addCollection)
        );
      } else {
        addResults.innerHTML =
          '<div class="dropdown-note">This wallet holds nothing from that collection.</div>';
      }
    } catch (e) {
      addResults.innerHTML = `<div class="dropdown-note">${escapeHtml(e.message)}</div>`;
    }
    return;
  }

  const q = raw.toLowerCase();
  const matches = allCollections.filter(
    (c) =>
      c.name.toLowerCase().includes(q) ||
      (c.symbol || '').toLowerCase().includes(q) ||
      c.contract.includes(q)
  );
  addResults.innerHTML = '';
  if (!matches.length) {
    addResults.innerHTML = '<div class="dropdown-note">No collections match</div>';
    return;
  }
  matches.slice(0, 12).forEach((c) => addResults.appendChild(collectionRow(c, addCollection)));
  if (matches.length > 12) {
    addResults.insertAdjacentHTML(
      'beforeend',
      `<div class="dropdown-note">+${matches.length - 12} more — keep typing</div>`
    );
  }
});

async function addCollection(c) {
  addResults.innerHTML = `<div class="dropdown-note">Fetching ${escapeHtml(c.name)}…</div>`;
  try {
    const images = await fetchCollectionImages(c);
    // Skip images already on the canvas (compared by original URL).
    const have = new Set(items.map((it) => it.orig || it.src));
    const fresh = images.filter((img) => !have.has(img.url));
    const skipped = images.length - fresh.length;

    const note = addResults.querySelector('.dropdown-note');
    const w = defaultItemWidth();
    const pre = snapshotItems();
    let added = 0;
    await loadImagesProgressive(fresh, (it, n) => {
      it.width = w;
      items.push(it);
      added++;
      scheduleRender();
      note.textContent = `Loading ${n}/${fresh.length}…`;
    });

    if (added) commitHistory(pre);
    note.textContent = `Added ${added} image${added === 1 ? '' : 's'}${skipped ? ` (${skipped} already on the canvas)` : ''}`;
    addSearch.value = '';
    setTimeout(() => {
      if (!addSearch.value.trim()) addResults.hidden = true;
    }, 2000);
  } catch (e) {
    addResults.innerHTML = `<div class="dropdown-note">${escapeHtml(e.message)}</div>`;
  }
}

const loadPill = document.getElementById('load-pill');

function showLoadPill(text) {
  loadPill.hidden = false;
  loadPill.textContent = text;
}

function hideLoadPill() {
  loadPill.hidden = true;
}

// Default width for images newly placed on the canvas (4-column fit).
function defaultItemWidth() {
  const gap = gapPx();
  return Math.floor((canvasWidth() - gap * 5) / 4);
}

async function pickCollection(c) {
  setStatus(`Fetching ${c.name}…`);
  try {
    const images = await fetchCollectionImages(c);
    setStatus('');
    // Enter the workspace right away and stream images in as they load.
    items = [];
    resetHistory();
    enterWorkspace();
    const w = defaultItemWidth();
    showLoadPill(`Loading 0/${images.length}…`);
    const loaded = await loadImagesProgressive(images, (it, n) => {
      it.width = w;
      items.push(it);
      scheduleRender();
      showLoadPill(`Loading ${n}/${images.length}…`);
    });
    hideLoadPill();
    if (!loaded) {
      workspaceView.hidden = true;
      entryView.hidden = false;
      setStatus('None of the images could be loaded.', true);
    }
  } catch (e) {
    hideLoadPill();
    setStatus(e.message, true);
  }
}

// Dead or private IPFS gateways (project vanity gateways get shut down) still
// carry the CID — rewrite to a public gateway as a fallback.
function ipfsRewrite(url) {
  const m = url.match(/\/ipfs\/(Qm[1-9A-HJ-NP-Za-km-z]{44}(?:\/[^?#]*)?|baf[a-zA-Z0-9]+(?:\/[^?#]*)?)/);
  if (m && !url.startsWith('https://ipfs.io/')) return `https://ipfs.io/ipfs/${m[1]}`;
  return null;
}

// Load one image: resizing CDN first, then CDN over a public IPFS gateway,
// then our own proxy.
function loadOne({ url, name }) {
  return new Promise((resolve, reject) => {
    let candidates;
    if (url.startsWith('data:')) {
      candidates = [url];
    } else {
      const rw = ipfsRewrite(url);
      candidates = [cdnResized(url)];
      if (rw) candidates.push(cdnResized(rw));
      candidates.push(proxied(rw || url));
    }
    let i = 0;
    const tryNext = () => {
      if (i >= candidates.length) return reject(new Error(`failed: ${url}`));
      const src = candidates[i++];
      const img = new Image();
      if (!src.startsWith('data:')) img.crossOrigin = 'anonymous';
      img.onload = () =>
        resolve({ src, orig: url, name, natW: img.naturalWidth, natH: img.naturalHeight, width: 0 });
      img.onerror = tryNext;
      img.src = src;
    };
    tryNext();
  });
}

// Loads all images concurrently, invoking onOne(item, loadedSoFar) as each
// arrives so the grid can fill progressively. Resolves with the loaded count.
async function loadImagesProgressive(list, onOne) {
  let loaded = 0;
  await Promise.allSettled(
    list.map((entry) =>
      loadOne(entry).then((it) => {
        loaded++;
        onOne(it, loaded);
      })
    )
  );
  return loaded;
}

// Coalesce many per-image renders into one per frame.
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function enterWorkspace() {
  // Initial size: fit a ~4-wide grid into the canvas.
  const gap = gapPx();
  const cols = Math.min(4, items.length);
  const w = Math.floor((canvasWidth() - gap * (cols + 1)) / cols);
  items.forEach((it) => (it.width = w));

  entryView.hidden = true;
  workspaceView.hidden = false;
  render();
}

backBtn.addEventListener('click', () => {
  workspaceView.hidden = true;
  entryView.hidden = false;
  setStatus('');
  profileInput.focus();
});

// ---------- Layout: top-left first-fit packing ----------
// Items are placed in array order at the topmost (then leftmost) free spot.
// Smaller images naturally stack in second/third rows beside a larger one.

function computeLayout() {
  const gap = gapPx();
  const cw = canvasWidth();
  const placed = [];

  for (const it of items) {
    const w = it.width;
    const h = itemHeight(it);

    const xs = [gap, ...placed.map((p) => p.x + p.w + gap)]
      .filter((x) => x + w <= cw - gap + 0.5)
      .sort((a, b) => a - b);
    const ys = [gap, ...placed.map((p) => p.y + p.h + gap)].sort((a, b) => a - b);

    let best = null;
    for (const y of ys) {
      for (const x of xs) {
        const collides = placed.some(
          (p) => x < p.x + p.w + gap - 0.5 && p.x < x + w + gap - 0.5 &&
                 y < p.y + p.h + gap - 0.5 && p.y < y + h + gap - 0.5
        );
        if (!collides) {
          best = { x, y };
          break;
        }
      }
      if (best) break;
    }
    if (!best) {
      // Wider than the canvas allows at any position: drop below everything.
      const maxBottom = placed.reduce((m, p) => Math.max(m, p.y + p.h), 0);
      best = { x: gap, y: maxBottom + gap };
    }
    placed.push({ x: best.x, y: best.y, w, h });
  }
  return placed;
}

function applyLayout() {
  const rects = computeLayout();
  rects.forEach((r, i) => {
    const el = itemEls[i];
    if (!el) return;
    el.style.left = `${r.x}px`;
    el.style.top = `${r.y}px`;
    el.style.width = `${r.w}px`;
  });
  return rects;
}

// ---------- Rendering ----------

function applyCanvasStyle() {
  const cw = canvasWidth();
  const ch = canvasHeight();
  canvasEl.style.width = `${cw}px`;
  canvasEl.style.height = `${ch}px`;
  canvasEl.style.background = bgColor.value;
  paddingValue.textContent = `${gapPx()}px`;

  // Fit-to-width scaling for small screens (never enlarges past 1:1).
  const avail = canvasScroller.clientWidth - 2 * 12;
  viewScale = Math.min(1, avail > 0 ? avail / cw : 1);
  canvasEl.style.transform = viewScale < 1 ? `scale(${viewScale})` : '';
  canvasWrap.style.width = `${cw * viewScale}px`;
  canvasWrap.style.height = `${ch * viewScale}px`;
  // Counter-scale factor for handles/badges (capped so they don't get huge).
  canvasEl.style.setProperty('--ui', Math.min(3, 1 / viewScale));
}

window.addEventListener('resize', () => {
  if (!workspaceView.hidden) applyCanvasStyle();
});

function render() {
  applyCanvasStyle();
  canvasEl.innerHTML = '';
  itemEls = [];

  items.forEach((it, i) => {
    const div = document.createElement('div');
    div.className = 'item';
    div.dataset.index = i;

    const img = document.createElement('img');
    if (!it.src.startsWith('data:')) img.crossOrigin = 'anonymous';
    img.src = it.src;
    img.alt = it.name;
    img.draggable = false;
    div.appendChild(img);

    const handle = document.createElement('div');
    handle.className = 'resize-handle';
    div.appendChild(handle);

    const remove = document.createElement('button');
    remove.className = 'remove-btn';
    remove.textContent = '×';
    remove.title = 'Remove';
    remove.addEventListener('click', () => {
      commitHistory(snapshotItems());
      items.splice(i, 1);
      render();
    });
    div.appendChild(remove);

    handle.addEventListener('pointerdown', (e) => startResize(e, i, div));
    div.addEventListener('pointerdown', (e) => {
      if (e.target === handle || e.target === remove) return;
      startReorder(e, i, div);
    });

    canvasEl.appendChild(div);
    itemEls.push(div);
  });

  applyLayout();
}

canvasW.addEventListener('input', () => {
  applyCanvasStyle();
  applyLayout();
});
bgColor.addEventListener('input', applyCanvasStyle);
canvasH.addEventListener('input', applyCanvasStyle);
paddingRange.addEventListener('input', () => {
  applyCanvasStyle();
  applyLayout();
});

// ---------- Auto layouts: distribute the set across the canvas ----------

function packedBottom() {
  return computeLayout().reduce((m, r) => Math.max(m, r.y + r.h), 0);
}

// Uniform grid: try column counts, keep the one whose packed height comes
// closest to the canvas height without overflowing (else minimal overflow).
function autoGrid() {
  if (!items.length) return;
  commitHistory(snapshotItems());
  const gap = gapPx();
  const cw = canvasWidth();
  const H = canvasHeight();
  let best = null;
  for (let cols = 1; cols <= Math.min(items.length, 16); cols++) {
    const w = (cw - gap * (cols + 1)) / cols;
    if (w < 40) break;
    items.forEach((it) => (it.width = w));
    const bottom = packedBottom() + gap;
    const score = bottom > H + 0.5 ? 1e6 + (bottom - H) : H - bottom;
    if (!best || score < best.score) best = { w, score };
  }
  items.forEach((it) => (it.width = best.w));
  applyLayout();
}

// Justified rows: every row spans the full canvas width with a shared height;
// the target row height is binary-searched so the whole set fills the canvas.
function autoRows() {
  if (!items.length) return;
  commitHistory(snapshotItems());
  const gap = gapPx();
  const cw = canvasWidth();
  const H = canvasHeight();
  const aspects = items.map((it) => it.natW / it.natH);

  function layoutRows(targetH) {
    const widths = new Array(items.length);
    let i = 0;
    let totalH = gap;
    while (i < items.length) {
      let k = 0;
      let sumA = 0;
      while (i + k < items.length) {
        const a = aspects[i + k];
        const needed = (sumA + a) * targetH + gap * (k + 2);
        if (k > 0 && needed > cw) break;
        sumA += a;
        k++;
      }
      // Scale the row to span the width exactly (0.5px slack for float safety).
      let h = (cw - gap * (k + 1) - 0.5) / sumA;
      // Don't let a sparse final row blow up.
      if (i + k >= items.length && h > targetH * 1.5) h = targetH;
      for (let j = 0; j < k; j++) widths[i + j] = aspects[i + j] * h;
      totalH += h + gap;
      i += k;
    }
    return { widths, totalH };
  }

  let lo = 30;
  let hi = H;
  let bestWidths = layoutRows(lo).widths;
  for (let iter = 0; iter < 24; iter++) {
    const mid = (lo + hi) / 2;
    const r = layoutRows(mid);
    if (r.totalH > H) {
      hi = mid;
    } else {
      lo = mid;
      bestWidths = r.widths;
    }
  }
  items.forEach((it, i) => (it.width = Math.max(24, bestWidths[i])));
  applyLayout();
}

// Mosaic: modular grid where every 5th image spans exactly two base columns
// (2w + gap), keeping everything aligned. The base column count is chosen so
// the packed result best fills the canvas.
function autoMosaic() {
  if (!items.length) return;
  commitHistory(snapshotItems());
  const gap = gapPx();
  const cw = canvasWidth();
  const H = canvasHeight();

  const setWidths = (cols) => {
    const w = (cw - gap * (cols + 1)) / cols;
    items.forEach((it, i) => {
      const big = i % 5 === 0 && cols >= 3;
      it.width = big ? 2 * w + gap : w;
    });
    return w;
  };

  let best = null;
  for (let cols = 2; cols <= Math.min(items.length, 16); cols++) {
    if (setWidths(cols) < 40) break;
    const bottom = packedBottom() + gap;
    const score = bottom > H + 0.5 ? 1e6 + (bottom - H) : H - bottom;
    if (!best || score < best.score) best = { cols, score };
  }
  setWidths(best.cols);
  applyLayout();
}

document.getElementById('auto-grid').addEventListener('click', autoGrid);
document.getElementById('auto-rows').addEventListener('click', autoRows);
document.getElementById('auto-mosaic').addEventListener('click', autoMosaic);

// ---------- Resize (proportions preserved, snapping, live size badge) ----------

// Snap targets: other items' widths (equal sizing), N-column fits, and
// "reach the canvas's right edge from my current x".
function snapWidth(raw, index) {
  const gap = gapPx();
  const cw = canvasWidth();
  const candidates = [];

  items.forEach((it, j) => {
    if (j !== index) candidates.push(it.width);
  });
  for (let n = 1; n <= 8; n++) {
    candidates.push((cw - gap * (n + 1)) / n);
  }
  const el = itemEls[index];
  if (el) {
    const x = parseFloat(el.style.left) || 0;
    candidates.push(cw - gap - x);
  }

  let best = raw;
  let bestD = SNAP_DIST;
  for (const c of candidates) {
    const d = Math.abs(c - raw);
    if (c >= 40 && d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return { width: Math.round(best), snapped: best !== raw };
}

function startResize(e, index, div) {
  e.preventDefault();
  e.stopPropagation();
  const it = items[index];
  const startX = e.clientX;
  const startW = it.width;
  const maxW = canvasWidth() - 2 * gapPx();
  const pre = snapshotItems();

  const badge = document.createElement('div');
  badge.className = 'size-badge';
  div.appendChild(badge);
  div.classList.add('no-anim', 'resizing');

  const update = (raw) => {
    const clamped = Math.min(maxW, Math.max(40, raw));
    const { width, snapped } = snapWidth(clamped, index);
    it.width = Math.min(maxW, width);
    badge.textContent = `${it.width} × ${Math.round(itemHeight(it))} px`;
    badge.classList.toggle('snapped', snapped);
    applyLayout();
  };
  update(startW);

  const onMove = (ev) => update(startW + (ev.clientX - startX) / viewScale);
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    badge.remove();
    div.classList.remove('no-anim', 'resizing');
    if (it.width !== startW) commitHistory(pre);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

// ---------- Reorder (drag an image; others shift to make room) ----------

function startReorder(e, index, div) {
  e.preventDefault();
  const startX = e.clientX;
  const startY = e.clientY;
  let dragging = false;
  let ghost = null;
  let indicator = null;
  let drop = { mode: 'insert', index };

  const clearSwapHighlight = () => {
    canvasEl.querySelectorAll('.swap-target').forEach((el) => el.classList.remove('swap-target'));
  };

  const onMove = (ev) => {
    if (!dragging) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
      dragging = true;
      div.classList.add('dragging');
      ghost = div.cloneNode(true);
      ghost.classList.add('drag-ghost');
      ghost.style.width = `${div.offsetWidth * viewScale * 0.6}px`;
      ghost.style.left = '';
      ghost.style.top = '';
      document.body.appendChild(ghost);
      indicator = document.createElement('div');
      indicator.className = 'drop-indicator';
      canvasEl.appendChild(indicator);
    }
    ghost.style.left = `${ev.clientX + 8}px`;
    ghost.style.top = `${ev.clientY + 8}px`;

    drop = findDropTarget(ev.clientX, ev.clientY, index);
    clearSwapHighlight();
    if (drop.mode === 'swap') {
      indicator.hidden = true;
      drop.indices.forEach((i) => itemEls[i].classList.add('swap-target'));
    } else {
      indicator.hidden = false;
      positionIndicator(indicator, drop.index);
    }
  };

  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    if (!dragging) return;
    div.classList.remove('dragging');
    clearSwapHighlight();
    ghost.remove();
    indicator.remove();
    if (drop.mode === 'swap') {
      commitHistory(snapshotItems());
      if (drop.indices.length === 1) {
        swapImagesKeepSize(index, drop.indices[0]);
      } else {
        applyGroupSwap(index, drop.indices);
      }
    } else if (drop.index !== index && drop.index !== index + 1) {
      commitHistory(snapshotItems());
      const [moved] = items.splice(index, 1);
      items.splice(drop.index > index ? drop.index - 1 : drop.index, 0, moved);
    }
    render();
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

// Dropping on top of other images swaps places. The dragged image's own
// footprint (projected around the pointer) decides what it lands on: every
// image whose center falls inside it swaps as a group — so a large image
// trades places with all the smaller ones it covers. Dropping around an
// image (near its edges or between items) inserts at that spot instead.
function findDropTarget(x, y, dragIndex) {
  const canvasRect = canvasEl.getBoundingClientRect();
  const px = (x - canvasRect.left) / viewScale;
  const py = (y - canvasRect.top) / viewScale;
  const it = items[dragIndex];
  const w = it.width;
  const h = itemHeight(it);
  const P = { l: px - w / 2, t: py - h / 2, r: px + w / 2, b: py + h / 2 };

  const rects = computeLayout();
  const group = [];
  rects.forEach((r, i) => {
    if (i === dragIndex) return;
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    if (cx > P.l && cx < P.r && cy > P.t && cy < P.b) group.push(i);
  });
  if (group.length) return { mode: 'swap', indices: group };

  // Footprint covers no centers — fall back to the hovered item's zones
  // (covers dragging a small image onto a larger one).
  const CENTER = 0.6; // inner fraction that counts as "on top"
  for (let i = 0; i < itemEls.length; i++) {
    if (i === dragIndex) continue;
    const r = itemEls[i].getBoundingClientRect();
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
    const fx = (x - r.left) / r.width;
    const fy = (y - r.top) / r.height;
    const edge = (1 - CENTER) / 2;
    if (fx > edge && fx < 1 - edge && fy > edge && fy < 1 - edge) {
      return { mode: 'swap', indices: [i] };
    }
    return { mode: 'insert', index: i + (fx > 0.5 ? 1 : 0) };
  }
  // Not over any item: insert before/after the nearest one.
  let bestI = -1;
  let bestD = Infinity;
  let after = false;
  itemEls.forEach((el, i) => {
    if (i === dragIndex) return;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const d = (x - cx) ** 2 + (y - cy) ** 2;
    if (d < bestD) {
      bestD = d;
      bestI = i;
      after = x > cx;
    }
  });
  if (bestI < 0) return { mode: 'insert', index: items.length };
  return { mode: 'insert', index: bestI + (after ? 1 : 0) };
}

// One-on-one swap: the two slots keep their sizes and positions — only the
// image content trades places, so the rest of the grid never reflows.
function swapImagesKeepSize(a, b) {
  const A = items[a];
  const B = items[b];
  for (const k of ['src', 'orig', 'name', 'natW', 'natH']) {
    const t = A[k];
    A[k] = B[k];
    B[k] = t;
  }
}

// The dragged item takes the group's place (at the group's first slot); the
// group members move together into the dragged item's old slot.
function applyGroupSwap(dragIndex, group) {
  const sorted = [...group].sort((a, b) => a - b);
  const groupSet = new Set(sorted);
  const first = sorted[0];
  const out = [];
  items.forEach((it, i) => {
    if (i === dragIndex) {
      sorted.forEach((g) => out.push(items[g]));
    } else if (i === first) {
      out.push(items[dragIndex]);
    } else if (!groupSet.has(i)) {
      out.push(it);
    }
  });
  items = out;
}

function positionIndicator(indicator, dropIndex) {
  // Screen-space rects → the canvas's logical coordinates (it may be scaled).
  const canvasRect = canvasEl.getBoundingClientRect();
  let r;
  let left;
  if (dropIndex < itemEls.length) {
    r = itemEls[dropIndex].getBoundingClientRect();
    left = (r.left - canvasRect.left) / viewScale - 4;
  } else {
    r = itemEls[itemEls.length - 1].getBoundingClientRect();
    left = (r.right - canvasRect.left) / viewScale + 1;
  }
  indicator.style.left = `${left}px`;
  indicator.style.top = `${(r.top - canvasRect.top) / viewScale}px`;
  indicator.style.height = `${r.height / viewScale}px`;
}

// ---------- Export ----------

const exportMore = document.getElementById('export-more');
const exportMenu = document.getElementById('export-menu');
const exportHires = document.getElementById('export-hires');

async function runExport(options) {
  exportBtn.disabled = true;
  exportMore.disabled = true;
  exportMenu.hidden = true;
  exportBtn.textContent = 'Rendering…';
  try {
    await exportPng(options);
  } catch (e) {
    alert(`Export failed: ${e.message}`);
  } finally {
    hideLoadPill();
    exportBtn.disabled = false;
    exportMore.disabled = false;
    exportBtn.textContent = 'Save as picture';
  }
}

exportBtn.addEventListener('click', () => runExport({}));
exportHires.addEventListener('click', () => runExport({ scale: 3, useOriginals: true }));
exportMore.addEventListener('click', () => {
  exportMenu.hidden = !exportMenu.hidden;
});

// The fast path draws the ≤1200px CDN versions already on screen. High-res
// pulls the originals through our proxy (slower, but full source resolution),
// falling back to the display version per image if an original won't load.
function loadExportBitmap(it, useOriginals) {
  if (!useOriginals || it.src.startsWith('data:')) return loadBitmap(it.src);
  const orig = it.orig || it.src;
  const rw = ipfsRewrite(orig);
  return loadBitmap(proxied(rw || orig)).catch(() => loadBitmap(it.src));
}

async function exportPng({ scale = 2, useOriginals = false } = {}) {
  const w = canvasEl.clientWidth;
  const h = canvasEl.clientHeight;
  const out = document.createElement('canvas');
  out.width = w * scale;
  out.height = h * scale;
  const ctx = out.getContext('2d');
  ctx.fillStyle = bgColor.value || '#ffffff';
  ctx.fillRect(0, 0, out.width, out.height);

  const rects = computeLayout();
  let done = 0;

  await Promise.all(
    items.map(async (it, i) => {
      const bitmap = await loadExportBitmap(it, useOriginals);
      const r = rects[i];
      ctx.drawImage(bitmap, r.x * scale, r.y * scale, r.w * scale, r.h * scale);
      done++;
      if (useOriginals) showLoadPill(`Rendering high-res… ${done}/${items.length}`);
    })
  );
  hideLoadPill();

  const blob = await new Promise((resolve) => out.toBlob(resolve, 'image/png'));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = useOriginals ? 'nft-grid-hires.png' : 'nft-grid.png';
  a.click();
  URL.revokeObjectURL(a.href);
}

function loadBitmap(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (!src.startsWith('data:')) img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image load failed during export'));
    img.src = src;
  });
}
