// Right-Click-Sort — front-end logic

const entryView = document.getElementById('entry-view');
const workspaceView = document.getElementById('workspace-view');
const urlForm = document.getElementById('url-form');
const urlInput = document.getElementById('url-input');
const entryStatus = document.getElementById('entry-status');
const canvasEl = document.getElementById('canvas');
const canvasW = document.getElementById('canvas-w');
const canvasH = document.getElementById('canvas-h');
const paddingRange = document.getElementById('padding-range');
const paddingValue = document.getElementById('padding-value');
const exportBtn = document.getElementById('export-btn');
const backBtn = document.getElementById('back-btn');

// Each item: { src, name, natW, natH, width (current display width px) }
let items = [];
let itemEls = [];

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
  canvasEl.style.width = `${canvasWidth()}px`;
  canvasEl.style.height = `${parseInt(canvasH.value, 10) || 800}px`;
  paddingValue.textContent = `${gapPx()}px`;
}

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

  const onMove = (ev) => update(startW + (ev.clientX - startX));
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
  let dropIndex = index;

  const onMove = (ev) => {
    if (!dragging) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
      dragging = true;
      div.classList.add('dragging');
      ghost = div.cloneNode(true);
      ghost.classList.add('drag-ghost');
      ghost.style.width = `${div.offsetWidth * 0.6}px`;
      ghost.style.left = '';
      ghost.style.top = '';
      document.body.appendChild(ghost);
      indicator = document.createElement('div');
      indicator.className = 'drop-indicator';
      canvasEl.appendChild(indicator);
    }
    ghost.style.left = `${ev.clientX + 8}px`;
    ghost.style.top = `${ev.clientY + 8}px`;

    dropIndex = findDropIndex(ev.clientX, ev.clientY, index);
    positionIndicator(indicator, dropIndex);
  };

  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    if (!dragging) return;
    div.classList.remove('dragging');
    ghost.remove();
    indicator.remove();
    if (dropIndex !== index && dropIndex !== index + 1) {
      const [moved] = items.splice(index, 1);
      items.splice(dropIndex > index ? dropIndex - 1 : dropIndex, 0, moved);
    }
    render();
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

// Insertion index: before/after the item whose center is nearest the pointer.
function findDropIndex(x, y, dragIndex) {
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
  if (bestI < 0) return items.length;
  return bestI + (after ? 1 : 0);
}

function positionIndicator(indicator, dropIndex) {
  const canvasRect = canvasEl.getBoundingClientRect();
  let r;
  let left;
  if (dropIndex < itemEls.length) {
    r = itemEls[dropIndex].getBoundingClientRect();
    left = r.left - canvasRect.left - 4;
  } else {
    r = itemEls[itemEls.length - 1].getBoundingClientRect();
    left = r.right - canvasRect.left + 1;
  }
  indicator.style.left = `${left}px`;
  indicator.style.top = `${r.top - canvasRect.top}px`;
  indicator.style.height = `${r.height}px`;
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
