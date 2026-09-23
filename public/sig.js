// Общий сигналинг для страниц камеры и зрителя.
// Входящие сообщения — через EventSource (SSE), исходящие — POST /api/signal.

function randomId() {
  return Math.random().toString(36).slice(2, 10);
}

class Sig {
  constructor(role, onMessage) {
    this.id = randomId();
    this.role = role;
    this.es = new EventSource(`/api/events?id=${this.id}&role=${role}`);
    this.es.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'hello') this.id = m.id;
      onMessage(m);
    };
  }

  send(to, data) {
    return fetch('/api/signal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: this.id, to, data }),
    }).then((r) => r.ok);
  }
}

// ICE-серверы. STUN помогает соединиться напрямую; TURN (Open Relay Project,
// бесплатный публичный) выручает, когда операторский NAT блокирует прямую
// связь — тогда видео идёт через релей, но всё равно зашифровано.
const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  ],
};
