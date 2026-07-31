// Right-Click-Sort — front-end logic

const entryView = document.getElementById('entry-view');
const workspaceView = document.getElementById('workspace-view');
const urlForm = document.getElementById('url-form');
const urlInput = document.getElementById('url-input');
const entryStatus = document.getElementById('entry-status');
const canvasEl = document.getElementById('canvas');
const canvasWrap = document.getElementById('canvas-wrap');
const canvasScroller = document.getElementById('canvas-scroller');
const canvasW = document.getElementById('canvas-w');
const canvasH = document.getElementById('canvas-h');
const paddingRange = document.getElementById('padding-range');
const paddingValue = document.getElementById('padding-value');
const exportBtn = document.getElementById('export-btn');
const backBtn = document.getElementById('back-btn');

// Each item: { src, name, natW, natH, width (current display width px) }
let items = [];
let itemEls = [];

// The canvas keeps its logical pixel size; on small screens it is visually
// scaled down to fit. Pointer math divides by this where needed.
let viewScale = 1;

const SNAP_DIST = 8;

// data: URLs (on-chain SVG art) load directly; everything else goes through
// the proxy so canvas export stays un-tainted.
const proxied = (url) =>
  url.startsWith('data:') ? url : `/api/img?u=${encodeURIComponent(url)}`;

const gapPx = () => parseInt(paddingRange.value, 10) || 0;
const canvasWidth = () => parseInt(canvasW.value, 10) || 1200;
const canvasHeight = () => parseInt(canvasH.value, 10) || 800;
const itemHeight = (it) => it.width * (it.natH / it.natW);

// ---------- Entry / loading ----------

urlForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = urlInput.value.trim();
  if (!url) return;

  urlInput.classList.add('loading');
  setStatus('Fetching NFT images…');

  try {
    const r = await fetch(`/api/nfts?url=${encodeURIComponent(url)}`);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `Server responded ${r.status}`);

    setStatus(`Found ${data.images.length} images — loading…`);
    const loaded = await loadImages(data.images);
    if (!loaded.length) throw new Error('None of the images could be loaded.');

    items = loaded;
    enterWorkspace();
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    urlInput.classList.remove('loading');
  }
});

urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    urlForm.requestSubmit();
  }
});

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

  const renderMatches = () => {
    const q = search.value.trim().toLowerCase();
    results.innerHTML = '';
    if (!q) {
      results.innerHTML = `<div class="dropdown-note">${allCollections.length} collections loaded — start typing to filter</div>`;
      return;
    }
    const matches = allCollections.filter(
      (c) => c.name.toLowerCase().includes(q) || (c.symbol || '').toLowerCase().includes(q)
    );
    if (!matches.length) {
      results.innerHTML = '<div class="dropdown-note">No collections match</div>';
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

function collectionRow(c) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'collection-row';
  const thumb = c.thumb
    ? `<img src="${escapeHtml(proxied(c.thumb))}" alt="" loading="lazy" />`
    : '<span class="thumb-placeholder"></span>';
  const chainBadge =
    c.chain && c.chain !== 'ethereum' ? `<span class="col-chain">${escapeHtml(c.chain)}</span>` : '';
  b.innerHTML = `${thumb}<span class="col-name">${escapeHtml(c.name)}</span>${chainBadge}<span class="col-count">${c.count} item${c.count === 1 ? '' : 's'}</span>`;
  b.addEventListener('click', () => pickCollection(c));
  return b;
}

async function pickCollection(c) {
  setStatus(`Fetching ${c.name}…`);
  try {
    const r = await fetch(
      `/api/collection-items?address=${activeProfile.address}&contract=${c.contract}&chain=${encodeURIComponent(c.chain || 'ethereum')}`
    );
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `Server responded ${r.status}`);
    setStatus(`Found ${d.images.length} images — loading…`);
    const loaded = await loadImages(d.images);
    if (!loaded.length) throw new Error('None of the images could be loaded.');
    items = loaded;
    setStatus('');
    enterWorkspace();
  } catch (e) {
    setStatus(e.message, true);
  }
}

async function loadImages(list) {
  const results = await Promise.allSettled(
    list.map(
      ({ url, name }) =>
        new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () =>
            resolve({
              src: proxied(url),
              name,
              natW: img.naturalWidth,
              natH: img.naturalHeight,
              width: 0,
            });
          img.onerror = () => reject(new Error(`failed: ${url}`));
          img.src = proxied(url);
        })
    )
  );
  return results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
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
  urlInput.select();
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
      applyGroupSwap(index, drop.indices);
    } else if (drop.index !== index && drop.index !== index + 1) {
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

exportBtn.addEventListener('click', async () => {
  exportBtn.disabled = true;
  exportBtn.textContent = 'Rendering…';
  try {
    await exportPng();
  } catch (e) {
    alert(`Export failed: ${e.message}`);
  } finally {
    exportBtn.disabled = false;
    exportBtn.textContent = 'Save as picture';
  }
});

async function exportPng() {
  const scale = 2; // export at 2x for crispness
  const w = canvasEl.clientWidth;
  const h = canvasEl.clientHeight;
  const out = document.createElement('canvas');
  out.width = w * scale;
  out.height = h * scale;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, out.width, out.height);

  const rects = computeLayout();

  await Promise.all(
    items.map(async (it, i) => {
      const bitmap = await loadBitmap(it.src);
      const r = rects[i];
      ctx.drawImage(bitmap, r.x * scale, r.y * scale, r.w * scale, r.h * scale);
    })
  );

  const blob = await new Promise((resolve) => out.toBlob(resolve, 'image/png'));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'nft-grid.png';
  a.click();
  URL.revokeObjectURL(a.href);
}

function loadBitmap(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image load failed during export'));
    img.src = src;
  });
}
