// Vercel serverless function: GET /api/resolve-collection?slug=<opensea slug>

const { resolveCollectionResponse } = require('../lib/opensea');

module.exports = async (req, res) => {
  const q = new URL(req.url, 'http://localhost').searchParams;
  const r = await resolveCollectionResponse(q.get('slug'));
  res.statusCode = r.status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(r.body));
};
