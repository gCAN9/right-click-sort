// Vercel serverless function: GET /api/collections?address=0x…

const { collectionsResponse } = require('../lib/opensea');

module.exports = async (req, res) => {
  const q = new URL(req.url, 'http://localhost').searchParams;
  const r = await collectionsResponse(q.get('address'), q.get('chain'));
  res.statusCode = r.status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(r.body));
};
