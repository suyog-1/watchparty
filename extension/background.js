// Background service worker: owns the WebSocket connection (bypasses page CSP)
// Routes messages between popup ↔ content script ↔ WebSocket

let ws            = null;
let roomId        = null;
let username      = null;
let activeTabId   = null;     // tab where the party lives
let videoFrames   = {};       // tabId → frameId holding <video>
let keepalivePorts = new Set();

// Track open ports from content scripts to keep service worker alive
chrome.runtime.onConnect.addListener(port => {
  keepalivePorts.add(port);
  port.onDisconnect.addListener(() => keepalivePorts.delete(port));
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
      notifyPopup({ type: 'connected', roomId: data.roomId });
    }
    if (data.type === 'members') {
      notifyPopup({ type: 'members', members: data.members });
    }

    // forward all server messages to the active tab's content script
    notifyTab({ type: 'ws-msg', data });
  };

  ws.onclose = () => {
    const wasConnected = roomId && roomId !== 'CONNECTING';
    roomId = null;
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
