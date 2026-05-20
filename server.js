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

    switch (msg.type) {

      case 'create': {
        const id = makeId();
        rooms[id] = { members: new Map([[ws, { username: msg.username }]]), state: { playing: false, currentTime: 0 }, video: null };
        roomId = id;
        send(ws, { type: 'created', roomId: id });
        broadcastAll(id, { type: 'members', members: memberNames(id) });
        break;
      }

      case 'join': {
        const id = msg.roomId?.toUpperCase();
        if (!rooms[id]) { send(ws, { type: 'error', message: 'Room not found. Check the code.' }); return; }
        rooms[id].members.set(ws, { username: msg.username });
        roomId = id;
        send(ws, { type: 'joined', roomId: id, video: rooms[id].video, state: rooms[id].state });
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
        if (!roomId || !rooms[roomId]) return;
        rooms[roomId].state = { playing: msg.action === 'play', currentTime: msg.currentTime };
        const from = rooms[roomId].members.get(ws)?.username || 'someone';
        broadcast(roomId, { type: 'playback', action: msg.action, currentTime: msg.currentTime, from }, ws);
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
        broadcastAll(roomId, { type: 'jumpscare', username });
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

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`watchparty running on http://localhost:${PORT}`));
