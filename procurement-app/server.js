const http = require('http');
const fs = require('fs');
const path = require('path');

const port = Number(process.env.PORT || 4173);
const dist = path.join(__dirname, 'dist');

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

async function latestProzorro() {
  const feed = await fetch('https://public-api.prozorro.gov.ua/api/2.5/tenders?limit=8', {
    headers: { Accept: 'application/json' }
  });
  if (!feed.ok) throw new Error(`Prozorro відповів кодом ${feed.status}`);
  const payload = await feed.json();
  const ids = (payload.data || []).map(x => x.id).filter(Boolean).slice(0, 8);
  const records = await Promise.all(ids.map(async id => {
    const response = await fetch(`https://public-api.prozorro.gov.ua/api/2.5/tenders/${id}`, { headers: { Accept: 'application/json' } });
    if (!response.ok) return null;
    const { data } = await response.json();
    return {
      externalId: data.id,
      title: data.title || 'Без назви',
      buyer: data.procuringEntity?.name || 'Не вказано',
      region: data.deliveryAddress?.region || data.items?.[0]?.deliveryAddress?.region || 'Не вказано',
      budget: data.value?.amount || '',
      currency: data.value?.currency || 'UAH',
      deadline: data.tenderPeriod?.endDate || '',
      url: `https://prozorro.gov.ua/tender/${data.tenderID || data.id}`,
      status: data.status || 'active.tendering',
      source: 'Prozorro',
      block: 'budget',
      material: '',
      characteristics: '',
      volume: '',
      winner: '',
      winnerContacts: '',
      evidence: 'Дані з публічного API Prozorro'
    };
  }));
  return records.filter(Boolean);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/api/prozorro') {
    try { send(res, 200, JSON.stringify(await latestProzorro())); }
    catch (error) { send(res, 502, JSON.stringify({ error: error.message })); }
    return;
  }
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.normalize(path.join(dist, requested));
  if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    send(res, 404, 'Не знайдено', 'text/plain; charset=utf-8'); return;
  }
  const ext = path.extname(file);
  const type = ext === '.html' ? 'text/html; charset=utf-8' : 'application/octet-stream';
  send(res, 200, fs.readFileSync(file), type);
});
server.listen(port, () => console.log(`Євроізол: http://localhost:${port}`));
