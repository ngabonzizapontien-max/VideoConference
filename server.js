'use strict';

const express  = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const http     = require('http');
const { v4: uuidv4 } = require('uuid');
const path     = require('path');
const crypto   = require('crypto');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ═══════════════════════════════════════════════════════════════════════════
// In-memory stores
// ═══════════════════════════════════════════════════════════════════════════
const sessions = new Map();
const users    = new Map();
const MAX_ACTORS = 20;

function hashPw(pw) { return crypto.createHash('sha256').update(pw).digest('hex'); }

// Default admin account — change password in production
users.set('admin', { passwordHash: hashPw('admin123'), role: 'admin' });

function makeSession(sid, password) {
  return {
    id:           sid,
    passwordHash: password ? hashPw(password) : '',
    actors:       new Map(),
    files:        [],
    transcripts:  [],
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────
function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
function broadcast(session, fromId, obj) {
  const data = JSON.stringify(obj);
  session.actors.forEach(({ ws }, id) => {
    if (id !== fromId && ws.readyState === WebSocket.OPEN) ws.send(data);
  });
}
function broadcastAll(session, obj) {
  const data = JSON.stringify(obj);
  session.actors.forEach(({ ws }) => { if (ws.readyState === WebSocket.OPEN) ws.send(data); });
}
function sendTo(session, targetId, obj) {
  const a = session.actors.get(targetId);
  if (a) send(a.ws, obj);
}
function roomList(session) {
  return [...session.actors.entries()].map(([id, a]) => ({
    id, name: a.name, role: a.role,
    audioMuted: a.audioMuted, videoMuted: a.videoMuted,
  }));
}
function authToken(token) {
  if (!token) return null;
  try {
    const [username] = Buffer.from(token, 'base64').toString().split(':');
    const u = users.get(username);
    return u ? { username, role: u.role } : null;
  } catch { return null; }
}

// ═══════════════════════════════════════════════════════════════════════════
// REST — Auth
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
  if (users.has(username))    return res.status(409).json({ error: 'Username taken' });
  users.set(username, { passwordHash: hashPw(password), role: 'user' });
  res.json({ ok: true, username, role: 'user' });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = users.get(username);
  if (!u || u.passwordHash !== hashPw(password))
    return res.status(401).json({ error: 'Invalid credentials' });
  const token = Buffer.from(`${username}:${Date.now()}`).toString('base64');
  res.json({ ok: true, token, username, role: u.role });
});

// ═══════════════════════════════════════════════════════════════════════════
// REST — Admin
// ═══════════════════════════════════════════════════════════════════════════
function adminOnly(req, res, next) {
  const auth = authToken((req.headers.authorization || '').replace('Bearer ', ''));
  if (!auth || auth.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  req.admin = auth;
  next();
}

app.get('/api/admin/sessions', adminOnly, (_, res) => {
  const info = {};
  sessions.forEach((s, sid) => {
    info[sid] = { count: s.actors.size, hasPassword: !!s.passwordHash, actors: roomList(s) };
  });
  res.json(info);
});

app.get('/api/admin/users', adminOnly, (_, res) => {
  res.json([...users.entries()].map(([u, d]) => ({ username: u, role: d.role })));
});

app.delete('/api/admin/session/:sid', adminOnly, (req, res) => {
  const s = sessions.get(req.params.sid);
  if (s) {
    broadcastAll(s, { type: 'kicked', reason: 'Session closed by admin' });
    sessions.delete(req.params.sid);
  }
  res.json({ ok: true });
});

app.get('/api/sessions', (_, res) => {
  const info = {};
  sessions.forEach((s, sid) => {
    info[sid] = { count: s.actors.size, hasPassword: !!s.passwordHash };
  });
  res.json(info);
});

// ═══════════════════════════════════════════════════════════════════════════
// WebSocket
// ═══════════════════════════════════════════════════════════════════════════
wss.on('connection', (ws) => {
  const actorId = uuidv4();
  ws.actorId    = actorId;
  ws.sessionId  = null;
  ws.authedUser = null;

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'auth': {
        const info = authToken(msg.token);
        if (!info) { send(ws, { type: 'auth_error', reason: 'Invalid token' }); return; }
        ws.authedUser = info;
        send(ws, { type: 'auth_ok', username: info.username, role: info.role });
        break;
      }

      case 'join': {
        if (!ws.authedUser) { send(ws, { type: 'error', reason: 'not_authenticated' }); return; }
        const sid  = msg.sessionId || 'default';
        const name = ws.authedUser.username;
        const role = ws.authedUser.role;

        if (!sessions.has(sid)) sessions.set(sid, makeSession(sid, msg.roomPassword || ''));
        const session = sessions.get(sid);

        if (session.passwordHash && hashPw(msg.password || '') !== session.passwordHash) {
          send(ws, { type: 'error', reason: 'wrong_password' }); return;
        }
        if (session.actors.size >= MAX_ACTORS) {
          send(ws, { type: 'error', reason: 'room_full' }); return;
        }

        session.actors.set(actorId, { ws, name, role, audioMuted: false, videoMuted: false });
        ws.sessionId = sid;

        send(ws, {
          type: 'joined', actorId, sessionId: sid,
          peers: roomList(session).filter(p => p.id !== actorId),
          files: session.files,
          transcripts: session.transcripts.slice(-20),
        });

        broadcast(session, actorId, { type: 'peer_joined', peerId: actorId, name, role });
        broadcastAll(session, { type: 'participants_update', participants: roomList(session) });
        console.log(`[${sid}] ${name} joined (${session.actors.size}/${MAX_ACTORS})`);
        break;
      }

      case 'offer':
      case 'answer':
      case 'ice_candidate':
      case 'screen_offer':
      case 'screen_answer':
      case 'screen_ice': {
        const session = sessions.get(ws.sessionId);
        if (!session) return;
        sendTo(session, msg.targetId, {
          ...msg, senderId: actorId,
          senderName: session.actors.get(actorId)?.name || 'Unknown',
        });
        break;
      }

      case 'screen_started':
      case 'screen_stopped':
      case 'recording_started':
      case 'recording_stopped': {
        const session = sessions.get(ws.sessionId);
        if (!session) return;
        broadcast(session, actorId, {
          ...msg, senderId: actorId,
          senderName: session.actors.get(actorId)?.name,
        });
        break;
      }

      case 'photo': {
        const session = sessions.get(ws.sessionId);
        if (!session) return;
        broadcast(session, actorId, {
          type: 'photo', senderId: actorId,
          senderName: session.actors.get(actorId)?.name,
          dataURL: msg.dataURL, filter: msg.filter,
        });
        break;
      }

      case 'file_share': {
        const session = sessions.get(ws.sessionId);
        if (!session) return;
        const fileMeta = {
          id: uuidv4(), name: msg.name, size: msg.size,
          fileType: msg.fileType, dataURL: msg.dataURL,
          senderId: actorId, senderName: session.actors.get(actorId)?.name,
          ts: Date.now(),
        };
        session.files.push(fileMeta);
        if (session.files.length > 50) session.files.shift();
        broadcastAll(session, { type: 'file_shared', file: fileMeta });
        break;
      }

      case 'reaction': {
        const session = sessions.get(ws.sessionId);
        if (!session) return;
        broadcastAll(session, {
          type: 'reaction', emoji: msg.emoji,
          senderId: actorId, senderName: session.actors.get(actorId)?.name,
        });
        break;
      }

      case 'transcript': {
        const session = sessions.get(ws.sessionId);
        if (!session) return;
        const entry = {
          text: msg.text, senderId: actorId,
          senderName: session.actors.get(actorId)?.name,
          ts: Date.now(), final: msg.final || false,
        };
        if (msg.final) { session.transcripts.push(entry); if (session.transcripts.length > 200) session.transcripts.shift(); }
        broadcastAll(session, { type: 'transcript', ...entry });
        break;
      }

      case 'chat': {
        const session = sessions.get(ws.sessionId);
        if (!session) return;
        broadcast(session, actorId, {
          type: 'chat', senderId: actorId,
          senderName: session.actors.get(actorId)?.name,
          text: msg.text, ts: Date.now(),
        });
        break;
      }

      case 'ctrl_mute_audio':
      case 'ctrl_mute_video': {
        const session = sessions.get(ws.sessionId);
        if (!session) return;
        const a = session.actors.get(msg.targetId);
        if (a) { if (msg.type === 'ctrl_mute_audio') a.audioMuted = true; else a.videoMuted = true; }
        sendTo(session, msg.targetId, {
          ...msg, senderId: actorId, senderName: session.actors.get(actorId)?.name,
        });
        broadcastAll(session, { type: 'participants_update', participants: roomList(session) });
        break;
      }

      case 'ctrl_kick':
      case 'admin_kick': {
        const session = sessions.get(ws.sessionId);
        if (!session) return;
        sendTo(session, msg.targetId, {
          type: 'kicked', reason: `Kicked by ${session.actors.get(actorId)?.name}`,
        });
        break;
      }

      case 'admin_mute_all': {
        const session = sessions.get(ws.sessionId);
        if (!session) return;
        session.actors.forEach((a, id) => {
          if (id !== actorId) {
            a.audioMuted = true;
            send(a.ws, { type: 'ctrl_mute_audio', targetId: id,
              senderId: actorId, senderName: session.actors.get(actorId)?.name });
          }
        });
        broadcastAll(session, { type: 'participants_update', participants: roomList(session) });
        break;
      }

      default: break;
    }
  });

  ws.on('close', () => {
    const session = sessions.get(ws.sessionId);
    if (session) {
      const name = session.actors.get(actorId)?.name;
      session.actors.delete(actorId);
      broadcast(session, actorId, { type: 'peer_left', peerId: actorId, name });
      broadcastAll(session, { type: 'participants_update', participants: roomList(session) });
      if (session.actors.size === 0) sessions.delete(ws.sessionId);
      console.log(`[-] ${name || actorId} left ${ws.sessionId}`);
    }
  });

  ws.on('error', e => console.error('WS:', e.message)); });
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎥 VideoConf ready → port ${PORT}`));