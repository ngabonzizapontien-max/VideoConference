'use strict';

const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();

// ── Create HTTP server ───────────────────────────────────────────────────────
// Render automatically provides HTTPS externally
const server = http.createServer(app);

// ── WebSocket server ─────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

// ── Static files (public/) ──────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Main route ───────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── In-memory session store ─────────────────────────────────────────────────
// sessions: Map<sessionId, { actors: Map<actorId, { ws, name }> }>
const sessions = new Map();
const MAX_ACTORS = 20;

// ── Helpers ─────────────────────────────────────────────────────────────────
function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function broadcast(session, fromId, obj) {
  const data = JSON.stringify(obj);

  session.actors.forEach(({ ws }, id) => {
    if (id !== fromId && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  });
}

function sendTo(session, targetId, obj) {
  const actor = session.actors.get(targetId);

  if (actor) {
    send(actor.ws, obj);
  }
}

function roomList(session) {
  return [...session.actors.entries()].map(([id, a]) => ({
    id,
    name: a.name,
  }));
}

// ── WebSocket handling ──────────────────────────────────────────────────────
wss.on('connection', (ws) => {

  const actorId = uuidv4();

  ws.actorId = actorId;
  ws.sessionId = null;

  console.log(`[+] Actor connected: ${actorId}`);

  ws.on('message', (raw) => {

    let msg;

    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {

      // ── JOIN SESSION ──────────────────────────────────────────────────────
      case 'join': {

        const sid = msg.sessionId || 'default';
        const name = msg.name || `Actor-${actorId.slice(0, 4)}`;

        if (!sessions.has(sid)) {
          sessions.set(sid, {
            actors: new Map()
          });
        }

        const session = sessions.get(sid);

        if (session.actors.size >= MAX_ACTORS) {

          send(ws, {
            type: 'error',
            reason: 'room_full',
            max: MAX_ACTORS
          });

          return;
        }

        // Store actor
        session.actors.set(actorId, {
          ws,
          name
        });

        ws.sessionId = sid;

        // Confirm join
        send(ws, {
          type: 'joined',
          actorId,
          sessionId: sid,
          peers: roomList(session).filter(
            (p) => p.id !== actorId
          ),
        });

        // Notify others
        broadcast(session, actorId, {
          type: 'peer_joined',
          peerId: actorId,
          name,
        });

        console.log(
          `[room:${sid}] ${name} joined (${session.actors.size}/${MAX_ACTORS})`
        );

        break;
      }

      // ── WEBRTC SIGNALING ──────────────────────────────────────────────────
      case 'offer':
      case 'answer':
      case 'ice_candidate': {

        const session = sessions.get(ws.sessionId);

        if (!session) return;

        sendTo(session, msg.targetId, {
          ...msg,
          senderId: actorId,
        });

        break;
      }

      // ── PHOTO SHARE ───────────────────────────────────────────────────────
      case 'photo': {

        const session = sessions.get(ws.sessionId);

        if (!session) return;

        broadcast(session, actorId, {
          type: 'photo',
          senderId: actorId,
          senderName: session.actors.get(actorId)?.name,
          dataURL: msg.dataURL,
          filter: msg.filter,
        });

        break;
      }

      // ── REMOTE CONTROLS ───────────────────────────────────────────────────
      case 'ctrl_mute_audio':
      case 'ctrl_mute_video':
      case 'ctrl_kick': {

        const session = sessions.get(ws.sessionId);

        if (!session) return;

        sendTo(session, msg.targetId, {
          ...msg,
          senderId: actorId,
          senderName: session.actors.get(actorId)?.name,
        });

        break;
      }

      // ── CHAT ──────────────────────────────────────────────────────────────
      case 'chat': {

        const session = sessions.get(ws.sessionId);

        if (!session) return;

        broadcast(session, actorId, {
          type: 'chat',
          senderId: actorId,
          senderName: session.actors.get(actorId)?.name,
          text: msg.text,
          ts: Date.now(),
        });

        break;
      }

      default:
        break;
    }
  });

  // ── DISCONNECT ────────────────────────────────────────────────────────────
  ws.on('close', () => {

    const session = sessions.get(ws.sessionId);

    if (session) {

      const actor = session.actors.get(actorId);

      session.actors.delete(actorId);

      broadcast(session, actorId, {
        type: 'peer_left',
        peerId: actorId,
      });

      if (session.actors.size === 0) {

        sessions.delete(ws.sessionId);

        console.log(
          `[room:${ws.sessionId}] session closed (empty)`
        );
      }

      console.log(
        `[-] ${actor?.name || actorId} left room ${ws.sessionId}`
      );
    }
  });

  ws.on('error', (e) => {
    console.error('WS error:', e.message);
  });
});

// ── API endpoint ────────────────────────────────────────────────────────────
app.get('/api/sessions', (_, res) => {

  const info = {};

  sessions.forEach((session, sid) => {

    info[sid] = {
      count: session.actors.size,
      actors: roomList(session),
    };
  });

  res.json(info);
});

// ── Start server ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`🎥 VideoConf server ready on port ${PORT}`);
});