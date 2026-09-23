// «Глазок» — телефон-камера. Сервер: статика + сигналинг WebRTC.
// Зависимостей нет — только стандартные модули Node.js.
// Запуск: node server.js  (по умолчанию порт 8000, можно PORT=8080)

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8000;
const ROOT = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// Подключённые клиенты (SSE): id -> { role: 'camera' | 'watch', res }
const clients = new Map();

function send(id, obj) {
  const c = clients.get(id);
  if (c && !c.res.destroyed) c.res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function broadcast(obj, exceptId) {
  for (const id of clients.keys()) if (id !== exceptId) send(id, obj);
}

// ---------- ICE/TURN-конфигурация ----------
// Если в окружении заданы CF_ACCOUNT_ID и CF_API_TOKEN (Cloudflare Calls TURN),
// раздаём рлей с двойным стеком IPv4+IPv6 — единственный рабочий путь для
// мобильных операторов с IPv6-only. Иначе — публичный openrelay (только IPv4).
const FALLBACK_ICE = [
  { urls: ['stun:stun.l.google.com:19302'] },
  {
    urls: [
      'turn:openrelay.metered.ca:80',
      'turn:openrelay.metered.ca:443?transport=tcp',
      'turns:openrelay.metered.ca:443?transport=tcp',
    ],
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
];

let iceCache = { at: 0, servers: null };

async function getIceServers() {
  const accountId = process.env.CF_ACCOUNT_ID;
  const token = process.env.CF_API_TOKEN;
  if (accountId && token && Date.now() - iceCache.at > 6 * 3600 * 1000) {
    try {
      const r = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/calls/turn`,
        { headers: { Authorization: `Bearer ${token}` } });
      const j = await r.json();
      if (j && j.success && j.result && Array.isArray(j.result.turnURIs)
          && j.result.turnURIs.length) {
        iceCache = {
          at: Date.now(),
          servers: [
            { urls: ['stun:stun.cloudflare.com:3478'] },
            { urls: j.result.turnURIs, username: j.result.username, credential: j.result.password },
          ],
        };
        console.log('ICE: конфигурация Cloudflare TURN обновлена');
      }
    } catch (e) {
      console.warn('ICE: Cloudflare TURN не получен, используем запасной:', e.message);
    }
  }
  return iceCache.servers || FALLBACK_ICE;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // --- SSE-канал клиента (получение сообщений) ---
  if (url.pathname === '/api/events') {
    const id = url.searchParams.get('id') || Math.random().toString(36).slice(2, 10);
    const role = url.searchParams.get('role') === 'camera' ? 'camera' : 'watch';
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    clients.set(id, { role, res });
    send(id, { type: 'hello', id });
    broadcast({ type: 'peer', id, role }, id); // рассказать о себе остальным
    for (const [pid, p] of clients) {         // и узнать, кто уже в сети
      if (pid !== id) send(id, { type: 'peer', id: pid, role: p.role });
    }
    req.on('close', () => {
      clients.delete(id);
      broadcast({ type: 'bye', id });
    });
    return;
  }

  // --- отправка сигнального сообщения конкретному клиенту ---
  if (url.pathname === '/api/signal' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        const msg = JSON.parse(body);
        if (msg.to && clients.has(msg.to)) {
          send(msg.to, { type: 'signal', from: msg.from, data: msg.data });
          res.writeHead(204);
        } else {
          res.writeHead(404);
        }
      } catch {
        res.writeHead(400);
      }
      res.end();
    });
    return;
  }

  // актуальная ICE/TURN-конфигурация для камеры и зрителя
  if (url.pathname === '/api/ice') {
    getIceServers()
      .then((servers) => {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ iceServers: servers }));
      })
      .catch(() => {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ iceServers: FALLBACK_ICE }));
      });
    return;
  }

  // --- статика ---
  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

// Пинг каждые 25 секунд: держит SSE живыми через туннели/прокси
// и заодно вычищает отвалившихся клиентов.
setInterval(() => {
  for (const [id, c] of clients) {
    if (c.res.destroyed) {
      clients.delete(id);
      broadcast({ type: 'bye', id });
      continue;
    }
    c.res.write(': ping\n\n');
  }
}, 25000);

server.listen(PORT, () => {
  console.log(`«Глазок» запущен:  http://localhost:${PORT}`);
  console.log(`Камера:             ${'/camera.html'}   Зритель: ${'/watch.html'}`);
});
