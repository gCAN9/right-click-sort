// Vercel serverless function: GET /api/profile?q=<name | ens | address>

const { profileResponse } = require('../lib/opensea');

module.exports = async (req, res) => {
  const q = new URL(req.url, 'http://localhost').searchParams;
  const r = await profileResponse(q.get('q'));
  res.statusCode = r.status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(r.body));
};
