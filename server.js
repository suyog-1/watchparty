const express = require('express');
const { createServer } = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

const app = express();
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

app.use(express.static(path.join(__dirname, 'public')));

// rooms[id] = { members: Map<ws, {username}>, state: {playing, currentTime}, video }
const rooms = {};

function makeId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(roomId, obj, except = null) {
  const room = rooms[roomId];
  if (!room) return;
  for (const [ws] of room.members) {
    if (ws !== except) send(ws, obj);
  }
}

function broadcastAll(roomId, obj) {
  broadcast(roomId, obj, null);
}

function memberNames(roomId) {
  return [...rooms[roomId].members.values()].map(m => m.username);
}

wss.on('connection', (ws) => {
  let roomId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // heartbeat ping — silently absorb
    if (msg.type === 'ping') return;

    switch (msg.type) {

      case 'create': {
        const id = makeId();
        rooms[id] = { members: new Map([[ws, { username: msg.username, version: msg.version || '?' }]]), state: { playing: false, currentTime: 0 }, video: null, lastUrl: null };
        roomId = id;
        console.log(`[room ${id}] CREATE by ${msg.username} (v${msg.version || '?'})`);
        send(ws, { type: 'created', roomId: id });
        broadcastAll(id, { type: 'members', members: memberNames(id) });
        break;
      }

      case 'join': {
        const id = msg.roomId?.toUpperCase();
        if (!id) { send(ws, { type: 'error', message: 'Room code required.' }); return; }
        let recreated = false;
        if (!rooms[id]) {
          if (msg.isReconnect) {
            rooms[id] = { members: new Map(), state: { playing: false, currentTime: 0 }, video: null, lastUrl: null };
            recreated = true;
            console.log(`[room ${id}] RECREATE on reconnect by ${msg.username}`);
          } else {
            console.log(`[room ${id}] JOIN FAILED — room not found, requested by ${msg.username}`);
            send(ws, { type: 'error', message: 'Room not found. Check the code.' });
            return;
          }
        }
        rooms[id].members.set(ws, { username: msg.username, version: msg.version || '?' });
        roomId = id;
        console.log(`[room ${id}] JOIN by ${msg.username} (v${msg.version || '?'}) → ${rooms[id].members.size} members`);

        // detect version mismatch and warn everyone — older clients miss sync fixes
        const versions = [...rooms[id].members.values()].map(m => m.version);
        const uniqueVersions = [...new Set(versions)];
        if (uniqueVersions.length > 1) {
          console.log(`[room ${id}] ⚠️ VERSION MISMATCH: ${versions.join(' vs ')}`);
          const versionList = [...rooms[id].members.values()]
            .map(m => `${m.username}: v${m.version}`).join(', ');
          broadcastAll(id, { type: 'version-mismatch', versions: versionList });
        }

        send(ws, { type: 'joined', roomId: id, video: rooms[id].video, state: rooms[id].state, lastUrl: rooms[id].lastUrl, recreated });
        broadcastAll(id, { type: 'members', members: memberNames(id) });
        broadcast(id, { type: 'peer-joined', username: msg.username }, ws);
        break;
      }

      case 'set-video': {
        if (!roomId || !rooms[roomId]) return;
        rooms[roomId].video = { videoType: msg.videoType, videoId: msg.videoId };
        rooms[roomId].state = { playing: false, currentTime: 0 };
        broadcast(roomId, { type: 'set-video', video: rooms[roomId].video }, ws);
        break;
      }

      case 'playback': {
        if (!roomId || !rooms[roomId]) {
          console.warn(`[playback] DROPPED — sender not in any room (msg=${JSON.stringify(msg)})`);
          return;
        }
        // backwards compat: accept either `eventType` (v2.0+) or `action` (v1.x)
        const eventType = msg.eventType || msg.action;
        const isPlay = eventType === 'play';
        const isPause = eventType === 'pause';
        // update room state only on meaningful changes (play/pause/seek), not volume/rate
        if (isPlay || isPause || eventType === 'seeked') {
          rooms[roomId].state = {
            playing: isPlay ? true : isPause ? false : rooms[roomId].state.playing,
            currentTime: msg.currentTime != null ? msg.currentTime : rooms[roomId].state.currentTime,
            volume: msg.volume != null ? msg.volume : rooms[roomId].state.volume,
            rate: msg.rate != null ? msg.rate : rooms[roomId].state.rate,
          };
        }
        const from = rooms[roomId].members.get(ws)?.username || 'someone';
        const recipientCount = rooms[roomId].members.size - 1;
        console.log(`[room ${roomId}] PLAYBACK ${eventType} @ ${msg.currentTime?.toFixed(1)}s from ${from} → ${recipientCount} others`);
        broadcast(roomId, {
          type: 'playback', eventType, action: eventType, // include both for backwards compat
          currentTime: msg.currentTime, volume: msg.volume, rate: msg.rate, from,
        }, ws);
        break;
      }

      case 'state-ping': {
        // silent heartbeat: updates server state for late-joiners, never broadcasts
        if (!roomId || !rooms[roomId]) return;
        rooms[roomId].state = {
          playing: msg.action === 'play',
          currentTime: msg.currentTime,
          volume: msg.volume != null ? msg.volume : rooms[roomId].state.volume,
          rate: msg.rate != null ? msg.rate : rooms[roomId].state.rate,
        };
        break;
      }

      case 'buffering':
      case 'buffered': {
        // partner buffering events — broadcast to the OTHER members so they auto-pause/resume
        if (!roomId || !rooms[roomId]) return;
        const from = rooms[roomId].members.get(ws)?.username || 'someone';
        console.log(`[room ${roomId}] ${msg.type.toUpperCase()} from ${from}`);
        broadcast(roomId, { type: msg.type, from }, ws);
        break;
      }

      case 'countdown': {
        // 3-2-1 synchronized start
        if (!roomId || !rooms[roomId]) return;
        const from = rooms[roomId].members.get(ws)?.username || 'someone';
        console.log(`[room ${roomId}] COUNTDOWN triggered by ${from}`);
        broadcast(roomId, { type: 'countdown', from }, ws);
        break;
      }

      case 'sync-ping': {
        // latency probe — echo it straight back to sender so they can measure RTT
        send(ws, { type: 'sync-pong', t: msg.t });
        break;
      }

      case 'chat': {
        if (!roomId || !rooms[roomId]) return;
        const username = rooms[roomId].members.get(ws)?.username || 'someone';
        broadcastAll(roomId, { type: 'chat', username, text: msg.text });
        break;
      }

      case 'reaction': {
        if (!roomId || !rooms[roomId]) return;
        const username = rooms[roomId].members.get(ws)?.username || 'someone';
        broadcastAll(roomId, { type: 'reaction', emoji: msg.emoji, username });
        break;
      }

      case 'gif': {
        if (!roomId || !rooms[roomId]) return;
        const username = rooms[roomId].members.get(ws)?.username || 'someone';
        broadcastAll(roomId, { type: 'gif', url: msg.url, username });
        break;
      }

      case 'jumpscare': {
        if (!roomId || !rooms[roomId]) return;
        const username = rooms[roomId].members.get(ws)?.username || 'someone';
        // forward imageUrl (data URL of custom scare image, if uploaded). Cap size at ~250KB
        // to prevent abuse — already enforced client-side but defense in depth.
        let imageUrl = msg.imageUrl;
        if (typeof imageUrl !== 'string' || imageUrl.length > 250_000) imageUrl = undefined;
        broadcast(roomId, { type: 'jumpscare', username, imageUrl }, ws);
        break;
      }

      case 'url-change': {
        if (!roomId || !rooms[roomId]) return;
        rooms[roomId].lastUrl = msg.url; // remember so new joiners can be redirected
        const username = rooms[roomId].members.get(ws)?.username || 'someone';
        broadcast(roomId, { type: 'url-change', url: msg.url, username }, ws);
        break;
      }
    }
  });

  ws.on('close', () => {
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    const username = room.members.get(ws)?.username;
    room.members.delete(ws);
    if (room.members.size === 0) { delete rooms[roomId]; return; }
    broadcastAll(roomId, { type: 'members', members: memberNames(roomId) });
    broadcastAll(roomId, { type: 'peer-left', username });
  });
});

// Protocol-level WebSocket ping every 25s to keep Render proxy from declaring connections idle.
// The `ws` library auto-handles pong replies from clients (no JS-level handling needed).
const pingInterval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.readyState === ws.OPEN) {
      try { ws.ping(); } catch (_) {}
    }
  });
}, 25000);
wss.on('close', () => clearInterval(pingInterval));

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`watchparty running on http://localhost:${PORT}`));
