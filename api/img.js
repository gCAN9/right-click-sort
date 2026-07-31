// Vercel serverless function: GET /api/img?u=<https image url>

const { imgResponse } = require('../lib/opensea');

module.exports = async (req, res) => {
  const q = new URL(req.url, 'http://localhost').searchParams;
  const r = await imgResponse(q.get('u'));
  if (r.buffer) {
    res.statusCode = 200;
    res.setHeader('Content-Type', r.contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=604800');
    res.end(r.buffer);
    return;
  }
  res.statusCode = r.status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(r.body));
};
