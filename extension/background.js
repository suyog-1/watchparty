// Background service worker: owns the WebSocket connection (bypasses page CSP)
// Routes messages between popup ↔ content script ↔ WebSocket

let ws            = null;
let roomId        = null;
let username      = null;
let activeTabId   = null;     // tab where the party lives
let lastMembers   = [];       // for restoring overlay after page navigation
let lastState     = null;     // last known playback state {action, currentTime} for restoration
let isHost        = false;    // were we the creator? need to preserve across nav
let videoFrames   = {};       // tabId → frameId holding <video>
let keepalivePorts = new Set();

// Restore state on service worker startup (handles SW being killed/restarted)
chrome.storage.session.get(['roomId', 'activeTabId', 'username'], (data) => {
  if (data.roomId)      roomId      = data.roomId;
  if (data.activeTabId) activeTabId = data.activeTabId;
  if (data.username)    username    = data.username;
  // Note: WebSocket itself isn't restored — if SW died, the WS is dead too.
  // The state restore is so the popup can show "disconnected, please rejoin"
  // instead of pretending nothing happened.
  if (roomId && !ws) {
    // we have state but no WS — connection dropped, mark as disconnected
    roomId = null;
    persistState();
  }
});

function persistState() {
  chrome.storage.session.set({
    roomId: roomId || null,
    activeTabId: activeTabId || null,
    username: username || null,
  });
}

// Track open ports from content scripts to keep service worker alive
chrome.runtime.onConnect.addListener(port => {
  keepalivePorts.add(port);
  port.onDisconnect.addListener(() => keepalivePorts.delete(port));
});

// HEARTBEAT: alarm fires every 25 seconds (just under Chrome's 30s idle kill)
// to prevent service worker termination while WebSocket is alive
chrome.alarms.create('dp-heartbeat', { periodInMinutes: 0.42 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'dp-heartbeat') {
    // also send a ping over WS to keep proxy connections warm
    if (ws?.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: 'ping' })); } catch (_) {}
    }
  }
});

// ── MESSAGE ROUTING ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const senderTabId   = sender.tab?.id;
  const senderFrameId = sender.frameId ?? 0;

  switch (msg.type) {

    // popup → background
    case 'connect':
      activeTabId = msg.tabId ?? senderTabId;
      connectWS(msg.serverUrl, msg.action, msg.roomId, msg.username);
      sendResponse({ ok: true }); break;

    case 'disconnect':
      disconnectWS();
      sendResponse({ ok: true }); break;

    case 'get-state':
      sendResponse({
        connected: !!roomId && roomId !== 'CONNECTING',
        connecting: roomId === 'CONNECTING',
        roomId: roomId === 'CONNECTING' ? null : roomId,
        tabId: activeTabId,
      });
      break;

    case 'is-in-party':
      // called by content script after page navigation to check if it should restore overlay
      if (senderTabId === activeTabId && roomId && roomId !== 'CONNECTING') {
        sendResponse({ inParty: true, roomId, members: lastMembers, state: lastState, isHost });
      } else {
        sendResponse({ inParty: false });
      }
      break;

    // content script → background → WebSocket
    case 'ws-send':
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg.payload));
      }
      sendResponse({ ok: true }); break;

    // frame routing (iframe video detection)
    case 'register-video-frame':
      if (senderTabId !== undefined) {
        videoFrames[senderTabId] = senderFrameId;
        if (senderFrameId !== 0) {
          chrome.tabs.sendMessage(senderTabId, { type: 'video-in-iframe', frameId: senderFrameId }, { frameId: 0 }).catch(() => {});
        }
      }
      sendResponse({ ok: true }); break;

    case 'iframe-video-event':
      if (senderTabId !== undefined && ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'playback', action: msg.action, currentTime: msg.currentTime }));
      }
      sendResponse({ ok: true }); break;

    case 'apply-to-video-frame': {
      const vfid = videoFrames[senderTabId];
      if (vfid !== undefined && vfid !== 0) {
        chrome.tabs.sendMessage(senderTabId, { type: 'apply-playback', action: msg.action, currentTime: msg.currentTime }, { frameId: vfid }).catch(() => {});
      }
      sendResponse({ ok: true }); break;
    }

    // misc
    case 'focus-tab':
      if (msg.tabId) chrome.tabs.update(msg.tabId, { active: true }).catch(() => {});
      sendResponse({ ok: true }); break;
  }

  return true; // keep channel open for async sendResponse
});

// ── WEBSOCKET MANAGEMENT ─────────────────────────────────────────────────────

function connectWS(serverUrl, action, rid, uname, attempt = 1) {
  if (ws) { ws.onclose = null; ws.close(); }
  username = uname;
  roomId = 'CONNECTING';
  persistState();

  notifyTab({ type: 'ws-status', status: 'connecting', attempt });

  const wsUrl = serverUrl.replace(/^https/, 'wss').replace(/^http/, 'ws');

  try {
    ws = new WebSocket(wsUrl);
  } catch (e) {
    notifyTab({ type: 'ws-error', message: 'invalid server url' });
    notifyPopup({ type: 'ws-error', message: 'invalid server url' });
    roomId = null;
    return;
  }

  ws.onopen = () => {
    const payload = action === 'create'
      ? { type: 'create', username: uname }
      : { type: 'join',   username: uname, roomId: rid };
    ws.send(JSON.stringify(payload));
  };

  ws.onmessage = (e) => {
    let data;
    try { data = JSON.parse(e.data); } catch { return; }

    if (data.type === 'created' || data.type === 'joined') {
      roomId = data.roomId;
      isHost = (data.type === 'created');
      // remember initial state from server if joining
      if (data.type === 'joined' && data.state) {
        lastState = {
          action: data.state.playing ? 'play' : 'pause',
          currentTime: data.state.currentTime,
        };
      }
      persistState();
      notifyPopup({ type: 'connected', roomId: data.roomId });
    }
    if (data.type === 'members') {
      lastMembers = data.members;
      notifyPopup({ type: 'members', members: data.members });
    }
    if (data.type === 'playback') {
      lastState = { action: data.action, currentTime: data.currentTime };
    }

    // forward all server messages to the active tab's content script
    notifyTab({ type: 'ws-msg', data });
  };

  ws.onclose = () => {
    const wasConnected = roomId && roomId !== 'CONNECTING';
    roomId = null;
    persistState();
    if (wasConnected) {
      notifyTab({ type: 'ws-closed' });
      notifyPopup({ type: 'ws-closed' });
    }
    ws = null;
  };

  ws.onerror = () => {
    if (attempt < 3) {
      // auto-retry — Render free tier takes ~30s to wake
      notifyTab({ type: 'ws-status', status: 'retrying', attempt: attempt + 1 });
      setTimeout(() => connectWS(serverUrl, action, rid, uname, attempt + 1), 10000);
    } else {
      roomId = null;
      notifyTab({ type: 'ws-error', message: "couldn't connect after 3 tries 💀" });
      notifyPopup({ type: 'ws-error', message: "couldn't connect after 3 tries 💀" });
    }
  };
}

function disconnectWS() {
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  roomId = null;
  if (activeTabId) {
    chrome.tabs.sendMessage(activeTabId, { type: 'ws-disconnected-by-user' }).catch(() => {});
  }
  activeTabId = null;
  persistState();
}

function notifyTab(msg) {
  if (activeTabId) chrome.tabs.sendMessage(activeTabId, msg).catch(() => {});
}

function notifyPopup(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

// ── CLEANUP ──────────────────────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener(tabId => {
  delete videoFrames[tabId];
  if (activeTabId === tabId) {
    disconnectWS();
  }
});
