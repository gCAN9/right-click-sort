// Right-Click-Sort — NFT grid arranger
// Zero-dependency Node server: static files + OpenSea image extraction + image proxy.
// Optional: set OPENSEA_API_KEY to use the official API instead of page scraping.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const API_KEY = process.env.OPENSEA_API_KEY || '';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

// The image proxy accepts any public https host (NFT media can live anywhere —
// seadn, IPFS gateways, Arweave, project CDNs), but never local/private targets.
function isForbiddenImgHost(hostname) {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) {
    return true;
  }
  // IP literals: block private/loopback/link-local ranges.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const [a, b] = h.split('.').map(Number);
    return (
      a === 10 || a === 127 || a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  if (h.includes(':')) return true; // IPv6 literals — not needed for NFT media
  return false;
}

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(data);
}

// ---------- OpenSea URL parsing ----------

function parseOpenSeaUrl(raw) {
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (!/(^|\.)opensea\.io$/.test(u.hostname)) return null;
  const parts = u.pathname.split('/').filter(Boolean);

  // /collection/{slug}[/...]
  if (parts[0] === 'collection' && parts[1]) {
    return { type: 'collection', slug: parts[1] };
  }
  // /assets/{chain}/{contract}/{tokenId} or /item/{chain}/{contract}/{tokenId}
  if ((parts[0] === 'assets' || parts[0] === 'item') && parts.length >= 4) {
    return { type: 'asset', chain: parts[1], contract: parts[2], tokenId: parts[3] };
  }
  // /{username}?addresses=0x..,0x..&collectionSlugs=slug1,slug2 — filtered profile view
  const RESERVED = new Set([
    'rankings', 'category', 'learn', 'blog', 'login', 'account', 'explore', 'stats', 'studio',
  ]);
  if (parts.length === 1 && !RESERVED.has(parts[0])) {
    const split = (s) => (s || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    return {
      type: 'profile',
      user: parts[0],
      addresses: split(u.searchParams.get('addresses')).filter((a) => /^0x[0-9a-f]{40}$/.test(a)),
      slugs: split(u.searchParams.get('collectionSlugs')),
    };
  }
  return null;
}

// ---------- Strategies ----------

async function fetchViaApi(parsed) {
  const headers = { 'x-api-key': API_KEY, 'Accept': 'application/json' };
  if (parsed.type === 'collection') {
    const r = await fetch(
      `https://api.opensea.io/api/v2/collection/${parsed.slug}/nfts?limit=100`,
      { headers }
    );
    if (!r.ok) throw new Error(`OpenSea API responded ${r.status}`);
    const data = await r.json();
    return (data.nfts || [])
      .map((n) => ({ url: n.display_image_url || n.image_url, name: n.name || '' }))
      .filter((n) => n.url);
  }
  const r = await fetch(
    `https://api.opensea.io/api/v2/chain/${parsed.chain}/contract/${parsed.contract}/nfts/${parsed.tokenId}`,
    { headers }
  );
  if (!r.ok) throw new Error(`OpenSea API responded ${r.status}`);
  const data = await r.json();
  const n = data.nft || {};
  const url = n.display_image_url || n.image_url;
  return url ? [{ url, name: n.name || '' }] : [];
}

function extractImageUrls(html) {
  // Hydration JSON escapes "&" as \u0026 and "/" as \/ — normalize before matching.
  const text = html.replace(/\\u0026/g, '&').replace(/\\\//g, '/');

  // Primary: per-NFT imageUrl fields on seadn.io. Collection banners/logos live
  // under /collection/… — item images live under /{chain}/{contract}/… paths.
  const seen = new Map(); // key: url without query → {url, name}
  const itemRe = /"imageUrl":"(https:\/\/[a-z0-9]+\.seadn\.io\/(?!collection\/|profiles\/)[^"]+)"/g;
  for (const m of text.matchAll(itemRe)) {
    const url = m[1];
    let key;
    try {
      const u = new URL(url);
      key = u.origin + u.pathname;
    } catch {
      continue;
    }
    if (/\.(svg|json|mp4|webm)(\?|$)/i.test(key)) continue;
    if (seen.has(key)) continue;
    // The item's display name (e.g. "#1715") follows shortly after in the same object.
    const nameMatch = text.slice(m.index, m.index + 2000).match(/"name":"([^"]{0,120})"/);
    seen.set(key, { url, name: nameMatch ? nameMatch[1] : '' });
  }
  if (seen.size) return [...seen.values()];

  // Fallback: any plausible image URL on known NFT media hosts.
  const looseRe = /https:\/\/(?:[a-z0-9]+\.seadn\.io|openseauserdata\.com|arweave\.net)\/[^\s"'\\<>)]+\.(?:png|jpe?g|webp|gif|avif)[^\s"'\\<>)]*/gi;
  for (const m of text.matchAll(looseRe)) {
    const url = m[0];
    try {
      const u = new URL(url);
      const key = u.origin + u.pathname;
      if (!seen.has(key)) seen.set(key, { url, name: '' });
    } catch {}
  }
  return [...seen.values()];
}

async function fetchViaScrape(parsed) {
  const pageUrl =
    parsed.type === 'collection'
      ? `https://opensea.io/collection/${parsed.slug}`
      : `https://opensea.io/assets/${parsed.chain}/${parsed.contract}/${parsed.tokenId}`;
  const r = await fetch(pageUrl, { headers: BROWSER_HEADERS, redirect: 'follow' });
  if (!r.ok) throw new Error(`OpenSea page responded ${r.status}`);
  const html = await r.text();
  return extractImageUrls(html);
}

// ---------- Profile views (via public Blockscout indexers) ----------

const BLOCKSCOUT_HOSTS = {
  ethereum: 'eth.blockscout.com',
  base: 'base.blockscout.com',
  matic: 'polygon.blockscout.com',
  polygon: 'polygon.blockscout.com',
  arbitrum: 'arbitrum.blockscout.com',
  optimism: 'optimism.blockscout.com',
  zksync: 'zksync.blockscout.com',
  gnosis: 'gnosis.blockscout.com',
};

async function fetchJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': BROWSER_HEADERS['User-Agent'], Accept: 'application/json' } });
  if (!r.ok) throw new Error(`${new URL(url).hostname} responded ${r.status}`);
  return r.json();
}

const ipfsToHttp = (u) =>
  u && u.startsWith('ipfs://') ? `https://ipfs.io/ipfs/${u.slice(7).replace(/^ipfs\//, '')}` : u;

function instanceToImage(inst, collectionName) {
  const md = inst.metadata || {};
  const url = inst.image_url || ipfsToHttp(md.image) || null;
  if (!url) return null;
  return { url, name: md.name || `${collectionName || ''} #${inst.id}`.trim() };
}

// Resolve a collection slug to its chain + contract by scraping the collection
// page: per-item image URLs embed both, e.g. i2c.seadn.io/ethereum/0xed34…/….
async function resolveCollection(slug) {
  const r = await fetch(`https://opensea.io/collection/${slug}`, {
    headers: BROWSER_HEADERS,
    redirect: 'follow',
  });
  if (!r.ok) throw new Error(`Collection page for "${slug}" responded ${r.status}`);
  const text = (await r.text()).replace(/\\u0026/g, '&').replace(/\\\//g, '/');
  const counts = new Map();
  for (const m of text.matchAll(/seadn\.io\/([a-z-]+)\/(0x[0-9a-f]{40})\//g)) {
    const key = `${m[1]}/${m[2]}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let best = null;
  for (const [key, n] of counts) if (!best || n > counts.get(best)) best = key;
  if (!best) throw new Error(`Could not determine the contract for collection "${slug}".`);
  const [chain, contract] = best.split('/');
  return { chain, contract };
}

// All instances of one contract held by one address.
async function blockscoutInstances(host, contract, holder, collectionName) {
  const out = [];
  let params = new URLSearchParams({ holder_address_hash: holder });
  for (let page = 0; page < 5 && out.length < 100; page++) {
    const d = await fetchJson(
      `https://${host}/api/v2/tokens/${contract}/instances?${params}`
    );
    for (const inst of d.items || []) {
      const img = instanceToImage(inst, collectionName);
      if (img) out.push(img);
    }
    if (!d.next_page_params) break;
    params = new URLSearchParams({ holder_address_hash: holder });
    for (const [k, v] of Object.entries(d.next_page_params)) params.set(k, String(v));
  }
  return out;
}

// All NFTs a wallet holds (no collection filter) — Ethereum mainnet only.
async function blockscoutWalletNfts(host, holder) {
  const out = [];
  let params = new URLSearchParams({ type: 'ERC-721,ERC-1155' });
  for (let page = 0; page < 3 && out.length < 100; page++) {
    const d = await fetchJson(`https://${host}/api/v2/addresses/${holder}/nft?${params}`);
    for (const inst of d.items || []) {
      const img = instanceToImage(inst, (inst.token || {}).name);
      if (img) out.push(img);
    }
    if (!d.next_page_params) break;
    params = new URLSearchParams({ type: 'ERC-721,ERC-1155' });
    for (const [k, v] of Object.entries(d.next_page_params)) params.set(k, String(v));
  }
  return out;
}

// Fallback when the URL has no addresses param: the profile page's hydration
// data contains the account's wallet address.
async function resolveProfileAddress(user) {
  const r = await fetch(`https://opensea.io/${user}`, { headers: BROWSER_HEADERS, redirect: 'follow' });
  if (!r.ok) throw new Error(`Profile page for "${user}" responded ${r.status}`);
  const text = await r.text();
  const m = text.match(/seadn\.io\/profiles\/(0x[0-9a-f]{40})\//) || text.match(/"address":"(0x[0-9a-f]{40})"/);
  if (!m) throw new Error(`Could not find a wallet address for profile "${user}".`);
  return [m[1].toLowerCase()];
}

async function fetchProfileItems(parsed) {
  const addresses = parsed.addresses.length
    ? parsed.addresses
    : await resolveProfileAddress(parsed.user);

  const images = [];
  if (parsed.slugs.length) {
    for (const slug of parsed.slugs) {
      const { chain, contract } = await resolveCollection(slug);
      const host = BLOCKSCOUT_HOSTS[chain];
      if (!host) throw new Error(`Chain "${chain}" (collection "${slug}") is not supported yet.`);
      for (const addr of addresses) {
        images.push(...(await blockscoutInstances(host, contract, addr, slug)));
      }
    }
  } else {
    for (const addr of addresses) {
      images.push(...(await blockscoutWalletNfts(BLOCKSCOUT_HOSTS.ethereum, addr)));
    }
  }

  // Dedupe (same token could surface via multiple addresses if transferred
  // mid-query, but be safe). Data-URLs are truncated for the key.
  const seen = new Set();
  return images.filter((img) => {
    const key = img.name + '|' + img.url.slice(0, 300);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function handleNfts(req, res, query) {
  const raw = query.get('url') || '';
  const parsed = parseOpenSeaUrl(raw);
  if (!parsed) {
    return json(res, 400, {
      error:
        'That does not look like an OpenSea URL. Expected opensea.io/collection/… or opensea.io/assets/…',
    });
  }
  if (parsed.type === 'profile') {
    try {
      const images = await fetchProfileItems(parsed);
      if (!images.length) {
        return json(res, 404, {
          error: 'No NFTs found for that profile view. Check the addresses and collection filters in the URL.',
        });
      }
      return json(res, 200, { images: images.slice(0, 100) });
    } catch (e) {
      return json(res, 502, { error: `Could not load profile items: ${e.message}` });
    }
  }

  const attempts = [];
  if (API_KEY) attempts.push(fetchViaApi);
  attempts.push(fetchViaScrape);

  let lastError = null;
  for (const attempt of attempts) {
    try {
      const images = await attempt(parsed);
      if (images.length) return json(res, 200, { images: images.slice(0, 100) });
      lastError = new Error('No images found on that page.');
    } catch (e) {
      lastError = e;
    }
  }
  json(res, 502, {
    error: `Could not extract images: ${lastError ? lastError.message : 'unknown error'}. OpenSea may be blocking automated access — setting OPENSEA_API_KEY and restarting the server makes this reliable.`,
  });
}

// ---------- Image proxy (keeps canvas export un-tainted) ----------

async function handleImg(req, res, query) {
  const raw = query.get('u') || '';
  let u;
  try {
    u = new URL(raw);
  } catch {
    return json(res, 400, { error: 'Bad image URL' });
  }
  if (u.protocol !== 'https:' || isForbiddenImgHost(u.hostname)) {
    return json(res, 403, { error: 'Image host not allowed' });
  }
  try {
    const r = await fetch(u.href, { headers: { 'User-Agent': BROWSER_HEADERS['User-Agent'] } });
    if (!r.ok) return json(res, 502, { error: `Upstream responded ${r.status}` });
    const type = r.headers.get('content-type') || 'image/png';
    // Only relay actual images, capped at 25 MB — this endpoint must not be a
    // general-purpose proxy on a public deployment.
    if (!/^image\//.test(type)) return json(res, 415, { error: 'Not an image' });
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 25 * 1024 * 1024) return json(res, 413, { error: 'Image too large' });
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'public, max-age=86400',
      'Content-Length': buf.length,
    });
    res.end(buf);
  } catch (e) {
    json(res, 502, { error: `Image fetch failed: ${e.message}` });
  }
}

// ---------- Static files ----------

function serveStatic(req, res, pathname) {
  let filePath = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

http
  .createServer((req, res) => {
    const u = new URL(req.url, `http://${req.headers.host}`);
    if (u.pathname === '/api/nfts') return handleNfts(req, res, u.searchParams);
    if (u.pathname === '/api/img') return handleImg(req, res, u.searchParams);
    serveStatic(req, res, u.pathname);
  })
  .listen(PORT, () => {
    console.log(`Right-Click-Sort running at http://localhost:${PORT}`);
    if (!API_KEY) console.log('No OPENSEA_API_KEY set — falling back to page scraping.');
  });
