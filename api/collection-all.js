// Vercel serverless function: GET /api/collection-all?contract=0x…&chain=<chain>

const { collectionAllResponse } = require('../lib/opensea');

module.exports = async (req, res) => {
  const q = new URL(req.url, 'http://localhost').searchParams;
  const r = await collectionAllResponse(q.get('contract'), q.get('chain'));
  res.statusCode = r.status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(r.body));
};
