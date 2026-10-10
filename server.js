'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const MAX_BODY_SIZE = 128 * 1024;
const REMATCH_COOLDOWN_MS = 5000;

const clients = new Map();
let waitingQueue = [];
let matchRetryTimer = null;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function setCommonHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self)');
}

function json(res, statusCode, body) {
  setCommonHeaders(res);
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;

    req.setEncoding('utf8');
    req.on('data', chunk => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_SIZE) {
        reject(new Error('PAYLOAD_TOO_LARGE'));
        req.destroy();
        return;
      }
      body += chunk;
    });

    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('INVALID_JSON'));
      }
    });

    req.on('error', reject);
  });
}

function validClientId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{8,80}$/.test(value);
}

function validMatchId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9-]{8,80}$/.test(value);
}

function normalizeName(value) {
  if (typeof value !== 'string') return 'Anonyme';
  const clean = value.trim().replace(/\s+/g, ' ').slice(0, 40);
  return clean || 'Anonyme';
}

function getOrCreateClient(clientId) {
  if (!clients.has(clientId)) {
    clients.set(clientId, {
      id: clientId,
      name: 'Anonyme',
      peerId: null,
      matchId: null,
      eventResponse: null,
      disconnectTimer: null,
      lastPeerId: null,
      rematchBlockedUntil: 0
    });
  }
  return clients.get(clientId);
}

function sendEvent(clientId, eventName, payload) {
  const client = clients.get(clientId);
  if (!client?.eventResponse || client.eventResponse.destroyed) return false;

  client.eventResponse.write(`event: ${eventName}\n`);
  client.eventResponse.write(`data: ${JSON.stringify(payload)}\n\n`);
  return true;
}

function removeFromQueue(clientId) {
  waitingQueue = waitingQueue.filter(id => id !== clientId);
}

function breakPair(clientId, notifyPeer = true, reason = 'partner-left') {
  const client = clients.get(clientId);
  if (!client?.peerId) return null;

  const peerId = client.peerId;
  const matchId = client.matchId;
  const peer = clients.get(peerId);

  client.peerId = null;
  client.matchId = null;

  if (peer?.peerId === clientId && peer.matchId === matchId) {
    peer.peerId = null;
    peer.matchId = null;

    if (notifyPeer) {
      sendEvent(peerId, 'partner-left', {
        peerId: clientId,
        matchId,
        reason,
        autoSearch: reason === 'next'
      });
    }
  }

  return peerId;
}

function blockImmediateRematch(firstId, secondId) {
  const until = Date.now() + REMATCH_COOLDOWN_MS;
  const first = clients.get(firstId);
  const second = clients.get(secondId);

  if (first) {
    first.lastPeerId = secondId;
    first.rematchBlockedUntil = until;
  }
  if (second) {
    second.lastPeerId = firstId;
    second.rematchBlockedUntil = until;
  }
}

function canMatch(first, second) {
  if (!first || !second || first.id === second.id) return false;
  const now = Date.now();
  const firstBlocksSecond = first.lastPeerId === second.id && first.rematchBlockedUntil > now;
  const secondBlocksFirst = second.lastPeerId === first.id && second.rematchBlockedUntil > now;
  return !firstBlocksSecond && !secondBlocksFirst;
}

function queueClient(clientId, notify = true) {
  const client = clients.get(clientId);
  if (!client?.eventResponse || client.peerId) return false;

  removeFromQueue(clientId);
  waitingQueue.push(clientId);
  if (notify) sendEvent(clientId, 'searching', { searching: true });
  return true;
}

function scheduleMatchRetry() {
  if (matchRetryTimer || waitingQueue.length < 2) return;

  matchRetryTimer = setTimeout(() => {
    matchRetryTimer = null;
    tryMatch();
  }, 500);
}

function removeClient(clientId) {
  removeFromQueue(clientId);
  breakPair(clientId, true, 'disconnect');

  const client = clients.get(clientId);
  if (client?.disconnectTimer) clearTimeout(client.disconnectTimer);
  clients.delete(clientId);
}

function tryMatch() {
  waitingQueue = [...new Set(waitingQueue)].filter(id => {
    const client = clients.get(id);
    return Boolean(client && client.eventResponse && !client.peerId);
  });

  let matchedSomeone = true;
  while (waitingQueue.length >= 2 && matchedSomeone) {
    matchedSomeone = false;

    for (let firstIndex = 0; firstIndex < waitingQueue.length - 1; firstIndex += 1) {
      const firstId = waitingQueue[firstIndex];
      const first = clients.get(firstId);
      if (!first) continue;

      let secondIndex = -1;
      for (let index = firstIndex + 1; index < waitingQueue.length; index += 1) {
        const candidate = clients.get(waitingQueue[index]);
        if (canMatch(first, candidate)) {
          secondIndex = index;
          break;
        }
      }

      if (secondIndex === -1) continue;

      const secondId = waitingQueue[secondIndex];
      const second = clients.get(secondId);
      waitingQueue.splice(secondIndex, 1);
      waitingQueue.splice(firstIndex, 1);

      if (!second || first.peerId || second.peerId) {
        matchedSomeone = true;
        break;
      }

      const matchId = crypto.randomUUID();
      first.peerId = secondId;
      first.matchId = matchId;
      second.peerId = firstId;
      second.matchId = matchId;

      sendEvent(firstId, 'matched', {
        peerId: secondId,
        peerName: second.name,
        matchId,
        initiator: true
      });

      sendEvent(secondId, 'matched', {
        peerId: firstId,
        peerName: first.name,
        matchId,
        initiator: false
      });

      matchedSomeone = true;
      break;
    }
  }

  if (waitingQueue.length >= 2) scheduleMatchRetry();
}

function parseIceServers() {
  if (!process.env.ICE_SERVERS_JSON) return [];

  try {
    const parsed = JSON.parse(process.env.ICE_SERVERS_JSON);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.warn('ICE_SERVERS_JSON invalide, configuration ICE locale utilisée.', error.message);
    return [];
  }
}

function serveStatic(req, res, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  let decoded;

  try {
    decoded = decodeURIComponent(requested);
  } catch {
    json(res, 400, { error: 'Chemin invalide.' });
    return;
  }

  const normalized = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(ROOT, normalized);

  if (!filePath.startsWith(ROOT)) {
    json(res, 403, { error: 'Accès refusé.' });
    return;
  }

  fs.stat(filePath, (error, stats) => {
    if (error || !stats.isFile()) {
      json(res, 404, { error: 'Fichier introuvable.' });
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    setCommonHeaders(res);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[extension] || 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/health') {
    json(res, 200, { ok: true, waiting: waitingQueue.length, clients: clients.size });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/config') {
    json(res, 200, { iceServers: parseIceServers() });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/events') {
    const clientId = url.searchParams.get('clientId');
    if (!validClientId(clientId)) {
      json(res, 400, { error: 'clientId invalide.' });
      return true;
    }

    const client = getOrCreateClient(clientId);
    if (client.disconnectTimer) {
      clearTimeout(client.disconnectTimer);
      client.disconnectTimer = null;
    }

    setCommonHeaders(res);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive'
    });
    res.write('retry: 1500\n\n');

    if (client.eventResponse && client.eventResponse !== res && !client.eventResponse.destroyed) {
      client.eventResponse.end();
    }
    client.eventResponse = res;

    sendEvent(clientId, 'ready', { clientId });

    const keepAlive = setInterval(() => {
      if (!res.destroyed) res.write(': keep-alive\n\n');
    }, 20000);

    req.on('close', () => {
      clearInterval(keepAlive);
      const current = clients.get(clientId);
      if (!current || current.eventResponse !== res) return;

      current.eventResponse = null;
      current.disconnectTimer = setTimeout(() => removeClient(clientId), 2500);
    });

    return true;
  }

  if (req.method !== 'POST' || !url.pathname.startsWith('/api/')) return false;

  let body;
  try {
    body = await readJson(req);
  } catch (error) {
    json(res, error.message === 'PAYLOAD_TOO_LARGE' ? 413 : 400, { error: 'Requête invalide.' });
    return true;
  }

  const clientId = body.clientId;
  if (!validClientId(clientId)) {
    json(res, 400, { error: 'clientId invalide.' });
    return true;
  }

  const client = getOrCreateClient(clientId);

  if (url.pathname === '/api/register') {
    client.name = normalizeName(body.name);
    json(res, 200, { ok: true, name: client.name });
    return true;
  }

  if (url.pathname === '/api/search') {
    removeFromQueue(clientId);

    if (!client.eventResponse) {
      json(res, 409, { error: 'Canal temps réel non connecté.' });
      return true;
    }

    const previousPeerId = client.peerId;
    if (previousPeerId) {
      breakPair(clientId, true, 'next');
      blockImmediateRematch(clientId, previousPeerId);
      queueClient(previousPeerId, true);
    }

    queueClient(clientId, true);
    tryMatch();
    json(res, 200, { ok: true, autoRequeuedPeer: Boolean(previousPeerId) });
    return true;
  }

  if (url.pathname === '/api/leave') {
    removeFromQueue(clientId);
    breakPair(clientId, true, 'leave');
    sendEvent(clientId, 'idle', { idle: true });
    json(res, 200, { ok: true });
    return true;
  }

  if (url.pathname === '/api/signal') {
    const peerId = body.peerId;
    const matchId = body.matchId;
    const type = body.type;
    const allowedTypes = new Set(['offer', 'answer', 'ice']);
    const peer = clients.get(peerId);

    if (
      !validClientId(peerId) ||
      !validMatchId(matchId) ||
      !allowedTypes.has(type) ||
      client.peerId !== peerId ||
      client.matchId !== matchId ||
      !peer ||
      peer.peerId !== clientId ||
      peer.matchId !== matchId
    ) {
      json(res, 403, { error: 'Signal non autorisé.' });
      return true;
    }

    sendEvent(peerId, 'signal', {
      from: clientId,
      matchId,
      type,
      data: body.data ?? null
    });

    json(res, 200, { ok: true });
    return true;
  }

  return false;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/auth/login') {
    res.writeHead(302, { Location: '/' });
    res.end();
    return;
  }

  try {
    if (await handleApi(req, res, url)) return;
  } catch (error) {
    console.error('Erreur serveur:', error);
    if (!res.headersSent) json(res, 500, { error: 'Erreur interne.' });
    else res.end();
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    serveStatic(req, res, url.pathname);
    return;
  }

  json(res, 404, { error: 'Route introuvable.' });
});

server.listen(PORT, HOST, () => {
  console.log(`UPHF Meets disponible sur http://localhost:${PORT}`);
});

function shutdown() {
  for (const client of clients.values()) {
    if (client.disconnectTimer) clearTimeout(client.disconnectTimer);
    if (client.eventResponse && !client.eventResponse.destroyed) client.eventResponse.end();
  }
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
