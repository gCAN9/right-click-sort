// Right-Click-Sort — NFT extraction + image proxy logic.
// Host-agnostic: used by server.js (local dev) and api/*.js (Vercel functions).
// Optional: set OPENSEA_API_KEY to use the official API instead of page scraping.

const API_KEY = process.env.OPENSEA_API_KEY || '';

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

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

// ---------- Collection strategies ----------

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
  // under /collection/…, avatars under /profiles/… — item images live under
  // /{chain}/{contract}/… paths.
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
  robinhood: 'robinhoodchain.blockscout.com',
};

// Max images returned per request across all flows.
const MAX_ITEMS = 150;

// Some Blockscout instances intermittently 500 — retry idempotent GETs with
// backoff before giving up.
async function fetchRetry(url) {
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt) await new Promise((res) => setTimeout(res, 700 * attempt));
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': BROWSER_HEADERS['User-Agent'], Accept: 'application/json' },
      });
      if (r.ok) return r;
      lastErr = new Error(`${new URL(url).hostname} responded ${r.status}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

async function fetchJson(url) {
  const r = await fetchRetry(url);
  return r.json();
}

// Like fetchJson, but keeps next_page_params values as raw strings: Blockscout
// cursors can contain token ids above Number.MAX_SAFE_INTEGER, which
// JSON.parse would turn into floats ("1.008e+25") that the API rejects (422).
async function fetchJsonPage(url) {
  const r = await fetchRetry(url);
  const text = await r.text();
  const data = JSON.parse(text);
  const m = text.match(/"next_page_params"\s*:\s*(\{[^{}]*\})/);
  if (m && data.next_page_params) {
    const raw = {};
    for (const kv of m[1].matchAll(/"([^"]+)"\s*:\s*(?:"([^"]*)"|(-?\d+(?:\.\d+)?)|(null|true|false))/g)) {
      const value = kv[2] !== undefined ? kv[2] : kv[3] !== undefined ? kv[3] : kv[4];
      if (value !== 'null') raw[kv[1]] = value;
    }
    data.next_page_params = raw;
  }
  return data;
}

function nextPageParams(base, next) {
  const params = new URLSearchParams(base);
  for (const [k, v] of Object.entries(next)) {
    if (v !== null && v !== undefined) params.set(k, String(v));
  }
  return params;
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
    // Only real chain segments — seadn also serves /profiles/{address}/ avatars.
    if (!BLOCKSCOUT_HOSTS[m[1]]) continue;
    const key = `${m[1]}/${m[2]}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let best = null;
  for (const [key, n] of counts) if (!best || n > counts.get(best)) best = key;
  if (!best) throw new Error(`Could not determine the contract for collection "${slug}".`);
  const [chain, contract] = best.split('/');
  return { chain, contract };
}

// Instances of one contract — held by one address, or (holder = null) the
// whole collection.
async function blockscoutInstances(host, contract, holder, collectionName) {
  const out = [];
  const base = holder ? { holder_address_hash: holder } : {};
  let params = new URLSearchParams(base);
  for (let page = 0; page < 8 && out.length < MAX_ITEMS; page++) {
    let d;
    try {
      d = await fetchJsonPage(`https://${host}/api/v2/tokens/${contract}/instances?${params}`);
    } catch (e) {
      // Flaky indexers: keep the pages we already have.
      if (page === 0) throw e;
      break;
    }
    for (const inst of d.items || []) {
      const img = instanceToImage(inst, collectionName);
      if (img) out.push(img);
    }
    if (!d.next_page_params) break;
    params = nextPageParams(base, d.next_page_params);
  }
  return out;
}

// All NFTs a wallet holds (no collection filter) — Ethereum mainnet only.
async function blockscoutWalletNfts(host, holder) {
  const out = [];
  let params = new URLSearchParams({ type: 'ERC-721,ERC-1155' });
  for (let page = 0; page < 4 && out.length < MAX_ITEMS; page++) {
    const d = await fetchJsonPage(`https://${host}/api/v2/addresses/${holder}/nft?${params}`);
    for (const inst of d.items || []) {
      const img = instanceToImage(inst, (inst.token || {}).name);
      if (img) out.push(img);
    }
    if (!d.next_page_params) break;
    params = nextPageParams({ type: 'ERC-721,ERC-1155' }, d.next_page_params);
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

// ---------- Profile picker (search → collections → items) ----------

const shortAddr = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// "Search": exact OpenSea username match + ENS/address results via Blockscout.
// (OpenSea's own fuzzy search API is signed and not publicly callable.)
async function profileSearch(q) {
  q = (q || '').trim();
  if (!q) return [];
  if (/^0x[0-9a-fA-F]{40}$/.test(q)) {
    const address = q.toLowerCase();
    return [{ name: shortAddr(address), address, source: 'address' }];
  }

  const results = [];
  if (/^[a-zA-Z0-9_.-]{2,40}$/.test(q) && !q.includes('.')) {
    try {
      const addrs = await resolveProfileAddress(q.toLowerCase());
      results.push({ name: q.toLowerCase(), address: addrs[0], source: 'opensea' });
    } catch {}
  }
  try {
    const d = await fetchJson(
      `https://eth.blockscout.com/api/v2/search?q=${encodeURIComponent(q)}`
    );
    for (const it of d.items || []) {
      const addr = it.address || it.address_hash;
      if (it.type === 'ens_domain' && addr) {
        const name = (it.ens_info && it.ens_info.name) || it.name || q;
        results.push({ name, address: addr.toLowerCase(), source: 'ens' });
      }
      if (results.length >= 10) break;
    }
  } catch {}

  const seen = new Set();
  return results
    .filter((r) => {
      if (seen.has(r.address)) return false;
      seen.add(r.address);
      return true;
    })
    .slice(0, 8);
}

// NFT collections one wallet holds on one chain, with a thumbnail each.
async function chainCollections(chain, host, address) {
  const out = [];
  let params = new URLSearchParams({ type: 'ERC-721,ERC-1155' });
  for (let page = 0; page < 12; page++) {
    let d;
    try {
      d = await fetchJsonPage(
        `https://${host}/api/v2/addresses/${address}/nft/collections?${params}`
      );
    } catch (e) {
      // Some Blockscout instances 500 on deep pages — keep what we have.
      if (page === 0) throw e;
      break;
    }
    for (const c of d.items || []) {
      const tok = c.token || {};
      const contract = (tok.address_hash || tok.address || '').toLowerCase();
      if (!contract) continue;
      const inst = (c.token_instances || [])[0];
      const thumb = inst ? instanceToImage(inst, tok.name) : null;
      // Contracts without an on-chain name (common for ERC-1155 editions):
      // fall back to the first item's metadata name so the row is recognizable.
      const instName = inst && inst.metadata && inst.metadata.name;
      out.push({
        name: tok.name || instName || shortAddr(contract),
        symbol: tok.symbol || '',
        contract,
        chain,
        count: parseInt(c.amount, 10) || (c.token_instances || []).length,
        thumb: thumb ? thumb.url : null,
      });
    }
    if (!d.next_page_params) break;
    params = nextPageParams({ type: 'ERC-721,ERC-1155' }, d.next_page_params);
  }
  return out;
}

// Collections across all supported chains, queried in parallel. A chain whose
// indexer fails or times out is skipped rather than failing the whole list.
async function addressCollections(address) {
  if (!/^0x[0-9a-f]{40}$/i.test(address || '')) throw new Error('Bad address');
  const chains = [...new Map(Object.entries(BLOCKSCOUT_HOSTS).map(([c, h]) => [h, c]))].map(
    ([host, chain]) => ({ chain, host })
  );
  const settled = await Promise.allSettled(
    chains.map(({ chain, host }) => chainCollections(chain, host, address))
  );
  const out = settled.filter((s) => s.status === 'fulfilled').flatMap((s) => s.value);
  if (!out.length && settled.every((s) => s.status === 'rejected')) {
    throw new Error(settled[0].reason.message);
  }
  // Alphabetical; collections without a real name (address placeholder) last.
  const isAddrName = (n) => /^0x[0-9a-f]{4}/i.test(n);
  out.sort((a, b) => {
    if (isAddrName(a.name) !== isAddrName(b.name)) return isAddrName(a.name) ? 1 : -1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
  });
  return out;
}

async function profileResponse(q) {
  try {
    return { status: 200, body: { results: await profileSearch(q) } };
  } catch (e) {
    return { status: 502, body: { error: `Profile search failed: ${e.message}` } };
  }
}

async function collectionsResponse(address, chain) {
  try {
    if (chain) {
      if (!/^0x[0-9a-f]{40}$/i.test(address || '')) throw new Error('Bad address');
      const host = BLOCKSCOUT_HOSTS[chain];
      if (!host) return { status: 400, body: { error: `Unsupported chain "${chain}"` } };
      return { status: 200, body: { collections: await chainCollections(chain, host, address) } };
    }
    return { status: 200, body: { collections: await addressCollections(address) } };
  } catch (e) {
    const bad = /Bad address/.test(e.message);
    return { status: bad ? 400 : 502, body: { error: `Could not load collections: ${e.message}` } };
  }
}

// Resolve an OpenSea collection slug to its chain + contract (for finding a
// held collection whose contract has no on-chain name).
async function resolveCollectionResponse(slug) {
  if (!/^[a-z0-9-]{2,100}$/i.test(slug || '')) {
    return { status: 400, body: { error: 'Bad collection slug' } };
  }
  try {
    const { chain, contract } = await resolveCollection(slug.toLowerCase());
    return { status: 200, body: { chain, contract } };
  } catch (e) {
    return { status: 502, body: { error: e.message } };
  }
}

// Search for collections themselves (not tied to a wallet): an OpenSea
// collection URL/slug resolves exactly; free-text queries search token
// contracts across chains, ranked by holder count to sink copycat contracts.
async function collectionSearchResponse(q) {
  q = (q || '').trim();
  if (!q) return { status: 200, body: { results: [] } };

  const results = [];
  const chains = [...new Map(Object.entries(BLOCKSCOUT_HOSTS).map(([c, h]) => [h, c]))].map(
    ([host, chain]) => ({ chain, host })
  );

  const slugMatch = q.match(/opensea\.io\/collection\/([a-z0-9-]+)/i);
  const slugCand = slugMatch ? slugMatch[1] : /^[a-z0-9-]{2,100}$/.test(q) ? q : null;
  let slugFailed = false;
  if (slugCand) {
    try {
      const { chain, contract } = await resolveCollection(slugCand.toLowerCase());
      results.push({ name: slugCand, symbol: '', contract, chain, holders: null, source: 'opensea' });
    } catch {
      // Newer collection pages 404 on the server side — fall back to
      // searching the de-hyphenated slug as a name.
      slugFailed = true;
    }
  }

  if (!slugMatch || slugFailed) {
    if (slugFailed) q = slugCand.replace(/-/g, ' ');
    const settled = await Promise.allSettled(
      chains.map(async ({ chain, host }) => {
        const d = await fetchJson(`https://${host}/api/v2/search?q=${encodeURIComponent(q)}`);
        return (d.items || [])
          .filter(
            (it) =>
              it.type === 'token' && (it.token_type === 'ERC-721' || it.token_type === 'ERC-1155')
          )
          .slice(0, 5)
          .map((it) => ({
            name: it.name || '',
            symbol: it.symbol || '',
            contract: (it.address || it.address_hash || '').toLowerCase(),
            chain,
            holders: 0,
            source: 'chain',
          }))
          .filter((c) => c.contract);
      })
    );
    const cands = settled.filter((s) => s.status === 'fulfilled').flatMap((s) => s.value);
    await Promise.allSettled(
      cands.map(async (c) => {
        const t = await fetchJson(`https://${BLOCKSCOUT_HOSTS[c.chain]}/api/v2/tokens/${c.contract}`);
        c.holders = parseInt(t.holders_count, 10) || 0;
      })
    );
    cands.sort((a, b) => b.holders - a.holders);
    results.push(...cands);
  }

  const seen = new Set();
  const deduped = results.filter((r) => {
    const key = `${r.chain}/${r.contract}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { status: 200, body: { results: deduped.slice(0, 8) } };
}

// All items of a collection, regardless of owner.
async function collectionAllResponse(contract, chain) {
  if (!/^0x[0-9a-f]{40}$/i.test(contract || '')) {
    return { status: 400, body: { error: 'Bad contract' } };
  }
  const host = BLOCKSCOUT_HOSTS[chain || 'ethereum'];
  if (!host) return { status: 400, body: { error: `Unsupported chain "${chain}"` } };
  try {
    const images = await blockscoutInstances(host, contract, null, null);
    if (!images.length) {
      return { status: 404, body: { error: 'No items found in that collection.' } };
    }
    return { status: 200, body: { images: images.slice(0, MAX_ITEMS) } };
  } catch (e) {
    return { status: 502, body: { error: `Could not load items: ${e.message}` } };
  }
}

async function collectionItemsResponse(address, contract, chain) {
  if (!/^0x[0-9a-f]{40}$/i.test(address || '') || !/^0x[0-9a-f]{40}$/i.test(contract || '')) {
    return { status: 400, body: { error: 'Bad address or contract' } };
  }
  const host = BLOCKSCOUT_HOSTS[chain || 'ethereum'];
  if (!host) return { status: 400, body: { error: `Unsupported chain "${chain}"` } };
  try {
    const images = await blockscoutInstances(host, contract, address, null);
    if (!images.length) {
      return { status: 404, body: { error: 'No items found for this wallet in that collection.' } };
    }
    return { status: 200, body: { images: images.slice(0, MAX_ITEMS) } };
  } catch (e) {
    return { status: 502, body: { error: `Could not load items: ${e.message}` } };
  }
}

// ---------- Entry points ----------

// Returns {status, body} for the /api/nfts endpoint.
async function nftsResponse(rawUrl) {
  const parsed = parseOpenSeaUrl(rawUrl || '');
  if (!parsed) {
    return {
      status: 400,
      body: {
        error:
          'That does not look like an OpenSea URL. Expected opensea.io/collection/…, opensea.io/assets/…, or a profile URL.',
      },
    };
  }

  if (parsed.type === 'profile') {
    try {
      const images = await fetchProfileItems(parsed);
      if (!images.length) {
        return {
          status: 404,
          body: {
            error: 'No NFTs found for that profile view. Check the addresses and collection filters in the URL.',
          },
        };
      }
      return { status: 200, body: { images: images.slice(0, MAX_ITEMS) } };
    } catch (e) {
      return { status: 502, body: { error: `Could not load profile items: ${e.message}` } };
    }
  }

  const attempts = [];
  if (API_KEY) attempts.push(fetchViaApi);
  attempts.push(fetchViaScrape);

  let lastError = null;
  for (const attempt of attempts) {
    try {
      const images = await attempt(parsed);
      if (images.length) return { status: 200, body: { images: images.slice(0, MAX_ITEMS) } };
      lastError = new Error('No images found on that page.');
    } catch (e) {
      lastError = e;
    }
  }
  return {
    status: 502,
    body: {
      error: `Could not extract images: ${lastError ? lastError.message : 'unknown error'}. OpenSea may be blocking automated access — setting OPENSEA_API_KEY makes this reliable.`,
    },
  };
}

// ---------- Image proxy ----------

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

// Returns {status, body} on error or {status: 200, contentType, buffer}.
async function imgResponse(raw) {
  let u;
  try {
    u = new URL(raw || '');
  } catch {
    return { status: 400, body: { error: 'Bad image URL' } };
  }
  if (u.protocol !== 'https:' || isForbiddenImgHost(u.hostname)) {
    return { status: 403, body: { error: 'Image host not allowed' } };
  }
  try {
    const r = await fetch(u.href, { headers: { 'User-Agent': BROWSER_HEADERS['User-Agent'] } });
    if (!r.ok) return { status: 502, body: { error: `Upstream responded ${r.status}` } };
    const type = r.headers.get('content-type') || 'image/png';
    // Only relay actual images, capped at 25 MB — this endpoint must not be a
    // general-purpose proxy on a public deployment.
    if (!/^image\//.test(type)) return { status: 415, body: { error: 'Not an image' } };
    const buffer = Buffer.from(await r.arrayBuffer());
    if (buffer.length > 25 * 1024 * 1024) return { status: 413, body: { error: 'Image too large' } };
    return { status: 200, contentType: type, buffer };
  } catch (e) {
    return { status: 502, body: { error: `Image fetch failed: ${e.message}` } };
  }
}

module.exports = {
  nftsResponse,
  imgResponse,
  profileResponse,
  collectionsResponse,
  collectionItemsResponse,
  resolveCollectionResponse,
  collectionSearchResponse,
  collectionAllResponse,
};
