// Right-Click-Sort — local dev server.
// Zero-dependency: static files + the shared extraction/proxy logic in lib/.
// (Production deploys on Vercel use api/*.js with the same lib.)

const http = require('http');
const fs = require('fs');
const path = require('path');
const {
  nftsResponse,
  imgResponse,
  profileResponse,
  collectionsResponse,
  collectionItemsResponse,
  resolveCollectionResponse,
} = require('./lib/opensea');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

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
  .createServer(async (req, res) => {
    const u = new URL(req.url, `http://${req.headers.host}`);
    if (u.pathname === '/api/nfts') {
      const r = await nftsResponse(u.searchParams.get('url'));
      return json(res, r.status, r.body);
    }
    if (u.pathname === '/api/profile') {
      const r = await profileResponse(u.searchParams.get('q'));
      return json(res, r.status, r.body);
    }
    if (u.pathname === '/api/collections') {
      const r = await collectionsResponse(u.searchParams.get('address'), u.searchParams.get('chain'));
      return json(res, r.status, r.body);
    }
    if (u.pathname === '/api/resolve-collection') {
      const r = await resolveCollectionResponse(u.searchParams.get('slug'));
      return json(res, r.status, r.body);
    }
    if (u.pathname === '/api/collection-items') {
      const r = await collectionItemsResponse(
        u.searchParams.get('address'),
        u.searchParams.get('contract'),
        u.searchParams.get('chain')
      );
      return json(res, r.status, r.body);
    }
    if (u.pathname === '/api/img') {
      const r = await imgResponse(u.searchParams.get('u'));
      if (r.buffer) {
        res.writeHead(200, {
          'Content-Type': r.contentType,
          'Cache-Control': 'public, max-age=86400',
          'Content-Length': r.buffer.length,
        });
        return res.end(r.buffer);
      }
      return json(res, r.status, r.body);
    }
    serveStatic(req, res, u.pathname);
  })
  .listen(PORT, () => {
    console.log(`Right-Click-Sort running at http://localhost:${PORT}`);
    if (!process.env.OPENSEA_API_KEY) {
      console.log('No OPENSEA_API_KEY set — falling back to page scraping.');
    }
  });
