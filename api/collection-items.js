// Vercel serverless function: GET /api/collection-items?address=0x…&contract=0x…

const { collectionItemsResponse } = require('../lib/opensea');

module.exports = async (req, res) => {
  const q = new URL(req.url, 'http://localhost').searchParams;
  const r = await collectionItemsResponse(q.get('address'), q.get('contract'), q.get('chain'));
  res.statusCode = r.status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(r.body));
};
