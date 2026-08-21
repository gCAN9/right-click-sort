// Temporary diagnostic: can this deployment mint an OpenSea key and use it?

module.exports = async (req, res) => {
  const out = {};
  try {
    const r = await fetch('https://api.opensea.io/api/v2/auth/keys', { method: 'POST' });
    out.mintStatus = r.status;
    const text = await r.text();
    let key = null;
    try {
      key = JSON.parse(text).api_key || null;
    } catch {}
    out.gotKey = !!key;
    if (!key) out.body = text.slice(0, 300);
    if (key) {
      const t = await fetch(
        'https://api.opensea.io/api/v2/chain/robinhood/contract/0x470926dd39141c65d33794b8182adbe8fbeff912/nfts/285',
        { headers: { 'X-API-KEY': key, Accept: 'application/json' } }
      );
      out.nftStatus = t.status;
      const nft = (await t.json().catch(() => ({}))).nft || {};
      out.hasDisplayImage = !!nft.display_image_url;
    }
  } catch (e) {
    out.error = e.message;
  }
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(out));
};
