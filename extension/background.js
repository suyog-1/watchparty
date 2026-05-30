// Background service worker: owns the WebSocket connection (bypasses page CSP)
// Routes messages between popup ↔ content script ↔ WebSocket

let ws            = null;
let roomId        = null;
let username      = null;
let activeTabId   = null;     // tab where the party lives
let lastMembers   = [];       // for restoring overlay after page navigation
let lastState     = null;     // last known playback state {action, currentTime} for restoration
let isHost        = false;    // were we the creator? need to preserve across nav
let videoFrames   = {};       // tabId → frameId holding <video> (the PRIMARY/active one)
let videoFrameDurations = {}; // tabId → duration of attached video (for picking best frame)
let allVideoFrames = {};      // tabId → Set<frameId> of ALL iframes that registered video
                              // (sync routes to ALL of them so multi-iframe sites work)
let keepalivePorts = new Set();
let lastServerUrl = null;     // remember for auto-reconnect
let intentionalDisconnect = false; // set true on user-initiated disconnect
let reconnectAttempts = 0;

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
// UPDATE CHECK: poll GitHub releases every 4 hours for a newer version
chrome.alarms.create('dp-update-check', { delayInMinutes: 1, periodInMinutes: 240 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'dp-heartbeat') {
    if (ws?.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: 'ping' })); } catch (_) {}
    }
  }
  if (alarm.name === 'dp-update-check') {
    checkForUpdates();
  }
});

// ── AUTO-UPDATE CHECKER ──────────────────────────────────────────────────────
// Chrome blocks true silent auto-update for sideloaded extensions (security policy).
// Best we can do without Chrome Web Store: poll GitHub releases, notify the user
// the moment a new version is out, make the install path as smooth as possible.

const RELEASES_API = 'https://api.github.com/repos/suyog-1/watchparty/releases/latest';
const RELEASES_PAGE = 'https://github.com/suyog-1/watchparty/releases/latest';

function compareVersions(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

async function checkForUpdates() {
  try {
    const res = await fetch(RELEASES_API, { cache: 'no-store' });
    if (!res.ok) {
      console.warn('[daddys party] update check: GitHub returned', res.status);
      return;
    }
    const data = await res.json();
    const tag = data.tag_name || data.name || '';
    // tag is 'latest' (a fixed tag) — pull version from the release name instead
    const versionMatch = (data.name || '').match(/v?(\d+\.\d+\.\d+)/);
    const latestVersion = versionMatch ? versionMatch[1] : null;
    if (!latestVersion) {
      console.warn('[daddys party] update check: could not parse version from release', data.name);
      return;
    }
    const currentVersion = chrome.runtime.getManifest().version;
    const cmp = compareVersions(latestVersion, currentVersion);
    console.log(`[daddys party] update check: latest=${latestVersion} current=${currentVersion} cmp=${cmp}`);

    if (cmp > 0) {
      // newer version exists — store flag, notify active tab, fire system notification
      await chrome.storage.local.set({
        updateAvailable: { version: latestVersion, currentVersion, checkedAt: Date.now() },
      });
      if (activeTabId) {
        chrome.tabs.sendMessage(activeTabId, {
          type: 'update-available',
          version: latestVersion,
          currentVersion,
          url: RELEASES_PAGE,
        }).catch(() => {});
      }
      // (system notification omitted — needs an icon file we don't bundle.
      // The in-extension banner in overlay + popup is the user-facing surface.)
    } else {
      // we're up to date — clear any stale flag
      await chrome.storage.local.remove('updateAvailable');
    }
  } catch (e) {
    console.warn('[daddys party] update check failed:', e.message);
  }
}

// fire one update check on service worker boot (covers the case where SW just started)
checkForUpdates();

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
        if (msg.payload?.type === 'playback') {
          console.log('[daddys party] →SEND playback', msg.payload.action, '@', msg.payload.currentTime?.toFixed(1));
        }
        ws.send(JSON.stringify(msg.payload));
      } else {
        console.warn('[daddys party] ws-send dropped — ws state:', ws?.readyState, 'payload:', msg.payload?.type);
      }
      sendResponse({ ok: true }); break;

    // frame routing (iframe video detection)
    case 'register-video-frame':
      if (senderTabId !== undefined) {
        const newDur = msg.duration || 0;
        const currentDur = videoFrameDurations[senderTabId] || 0;

        // Track this frame in the all-iframes set so sync routes to it
        if (!allVideoFrames[senderTabId]) allVideoFrames[senderTabId] = new Set();
        allVideoFrames[senderTabId].add(senderFrameId);

        // Primary frame is the one with longest duration (most likely the main movie)
        if (videoFrames[senderTabId] === undefined || newDur > currentDur) {
          videoFrames[senderTabId] = senderFrameId;
          videoFrameDurations[senderTabId] = newDur;
          if (senderFrameId !== 0) {
            chrome.tabs.sendMessage(senderTabId, { type: 'video-in-iframe', frameId: senderFrameId }, { frameId: 0 }).catch(() => {});
            if (lastState) {
              chrome.tabs.sendMessage(senderTabId, {
                type: 'apply-playback',
                action: lastState.action,
                currentTime: lastState.currentTime,
              }, { frameId: senderFrameId }).catch(() => {});
            }
          }
        }
      }
      sendResponse({ ok: true }); break;

    case 'iframe-video-event':
      // When an iframe emits a video event, it's a STRONG signal the user is
      // actively interacting with THAT iframe — make it the registered video frame
      // (override any previous registration). This solves the multi-iframe case
      // where multiple iframes have videos but only one is visible/active: whichever
      // one fires events from user actions becomes the sync target dynamically.
      if (senderTabId !== undefined && ws?.readyState === WebSocket.OPEN && roomId && roomId !== 'CONNECTING') {
        // Track in all-iframes set (sync will route here too)
        if (!allVideoFrames[senderTabId]) allVideoFrames[senderTabId] = new Set();
        allVideoFrames[senderTabId].add(senderFrameId);

        // Promote to primary iframe — this is the one the user is actively using
        if (videoFrames[senderTabId] !== senderFrameId) {
          const oldFrame = videoFrames[senderTabId];
          videoFrames[senderTabId] = senderFrameId;
          videoFrameDurations[senderTabId] = videoFrameDurations[senderTabId] || 1;
          if (senderFrameId !== 0) {
            chrome.tabs.sendMessage(senderTabId, { type: 'video-in-iframe', frameId: senderFrameId }, { frameId: 0 }).catch(() => {});
          }
          console.log(`[daddys party] active iframe → ${senderFrameId} (was ${oldFrame ?? 'none'})`);
          chrome.tabs.sendMessage(senderTabId, {
            type: 'iframe-debug',
            text: `🎯 active video iframe is now: frame#${senderFrameId}`,
          }, { frameId: 0 }).catch(() => {});
        }
        console.log('[daddys party] →SEND playback', msg.eventType, '@', msg.currentTime?.toFixed(1));
        ws.send(JSON.stringify({
          type: 'playback',
          eventType: msg.eventType,
          currentTime: msg.currentTime,
          volume: msg.volume,
          rate: msg.rate,
        }));
      }
      sendResponse({ ok: true }); break;

    case 'iframe-heartbeat':
      if (senderTabId !== undefined && ws?.readyState === WebSocket.OPEN && roomId && roomId !== 'CONNECTING') {
        if (videoFrames[senderTabId] === undefined) {
          videoFrames[senderTabId] = senderFrameId;
          videoFrameDurations[senderTabId] = 1;
          if (senderFrameId !== 0) {
            chrome.tabs.sendMessage(senderTabId, { type: 'video-in-iframe', frameId: senderFrameId }, { frameId: 0 }).catch(() => {});
          }
        }
        if (videoFrames[senderTabId] === senderFrameId) {
          ws.send(JSON.stringify({
            type: 'state-ping',
            action: msg.action,
            currentTime: msg.currentTime,
            volume: msg.volume,
            rate: msg.rate,
          }));
        }
      }
      sendResponse({ ok: true }); break;

    case 'iframe-buffering':
    case 'iframe-buffered':
      // forward iframe buffering state to server as top-level buffering/buffered event
      if (senderTabId !== undefined && ws?.readyState === WebSocket.OPEN && roomId && roomId !== 'CONNECTING') {
        const evtType = msg.type === 'iframe-buffering' ? 'buffering' : 'buffered';
        ws.send(JSON.stringify({ type: evtType }));
      }
      sendResponse({ ok: true }); break;

    case 'iframe-debug':
      // relay iframe debug message to the tab's top frame for display
      if (senderTabId !== undefined) {
        chrome.tabs.sendMessage(senderTabId, msg, { frameId: 0 }).catch(() => {});
      }
      sendResponse({ ok: true }); break;

    case 'iframe-url-change':
      // shady site server-switch: log to top frame chat
      // (don't auto-navigate joiner — they probably can't navigate their iframe directly)
      if (senderTabId !== undefined) {
        const short = msg.url.replace(/^https?:\/\//, '').slice(0, 60);
        chrome.tabs.sendMessage(senderTabId, {
          type: 'iframe-debug',
          text: `iframe switched source → ${short}…`,
        }, { frameId: 0 }).catch(() => {});
      }
      sendResponse({ ok: true }); break;

    case 'apply-to-video-frame': {
      const vfid = videoFrames[senderTabId];
      if (vfid !== undefined && vfid !== 0) {
        chrome.tabs.sendMessage(senderTabId, { type: 'apply-playback', action: msg.action, currentTime: msg.currentTime }, { frameId: vfid }).catch(() => {});
      }
      sendResponse({ ok: true }); break;
    }

    case 'request-iframe-push': {
      // Top frame's force-push button was clicked but top has no video — ask the
      // registered iframe to emit its current state instead
      const vfid = videoFrames[senderTabId];
      if (vfid !== undefined && vfid !== 0) {
        chrome.tabs.sendMessage(senderTabId, { type: 'force-emit-state' }, { frameId: vfid }).catch(() => {});
      }
      sendResponse({ ok: true }); break;
    }

    case 'broadcast-rescan': {
      // Tell EVERY frame in the active tab to immediately re-run findVideo()
      // and report back what they see. Used by the push and restart buttons when
      // the video may have loaded after our initial detection passed.
      if (senderTabId !== undefined) {
        chrome.webNavigation.getAllFrames({ tabId: senderTabId }, (frames) => {
          if (!frames) return;
          for (const f of frames) {
            chrome.tabs.sendMessage(senderTabId, { type: 'force-rescan' }, { frameId: f.frameId }).catch(() => {});
          }
        });
      }
      sendResponse({ ok: true }); break;
    }

    // misc
    case 'focus-tab':
      if (msg.tabId) chrome.tabs.update(msg.tabId, { active: true }).catch(() => {});
      sendResponse({ ok: true }); break;

    case 'check-update-now':
      // popup triggered a manual check
      checkForUpdates().then(() => {
        chrome.storage.local.get(['updateAvailable'], d => sendResponse({ updateAvailable: d.updateAvailable || null }));
      });
      return true; // async

    case 'get-update-status':
      chrome.storage.local.get(['updateAvailable'], d => sendResponse({ updateAvailable: d.updateAvailable || null }));
      return true; // async
  }

  return true; // keep channel open for async sendResponse
});

// ── WEBSOCKET MANAGEMENT ─────────────────────────────────────────────────────

function connectWS(serverUrl, action, rid, uname, attempt = 1) {
  if (ws) { ws.onclose = null; ws.close(); }
  username = uname;
  lastServerUrl = serverUrl;
  intentionalDisconnect = false;
  if (roomId !== 'CONNECTING') roomId = 'CONNECTING';
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
    const myVersion = chrome.runtime.getManifest().version;
    let payload;
    if (action === 'create') {
      payload = { type: 'create', username: uname, version: myVersion };
    } else {
      payload = { type: 'join', username: uname, roomId: rid, version: myVersion };
      if (action === 'reconnect') payload.isReconnect = true;
    }
    ws.send(JSON.stringify(payload));
  };

  ws.onmessage = (e) => {
    let data;
    try { data = JSON.parse(e.data); } catch { return; }

    // Log all incoming server messages (except heartbeats) for easy debugging
    if (data.type === 'playback') {
      console.log('[daddys party] ←RECV playback from', data.from, data.action, '@', data.currentTime?.toFixed(1));
    } else if (data.type !== 'state-ping' && data.type !== 'ping') {
      console.log('[daddys party] ←RECV', data.type, data.from || data.username || '');
    }

    if (data.type === 'created' || data.type === 'joined') {
      roomId = data.roomId;
      reconnectAttempts = 0; // success — reset reconnect counter
      // only change isHost on FRESH connection (action === 'create' for host, 'join' for joiner)
      // on reconnect we preserve whatever role we already had
      if (action === 'create' || action === 'join') {
        isHost = (data.type === 'created');
      }
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

    // forward all server messages to the active tab's main frame (for overlay)
    notifyTab({ type: 'ws-msg', data });

    // For playback events: route to ALL registered video iframes in the tab,
    // not just the "primary" one. Solves the multi-iframe case where the user
    // might be watching a different iframe than the one that registered first.
    // Each frame's syntheticEventQueue suppresses its own echoes.
    if (data.type === 'playback' && activeTabId !== null) {
      const frames = allVideoFrames[activeTabId];
      const payload = {
        type: 'apply-playback',
        eventType: data.eventType || data.action,
        currentTime: data.currentTime,
        volume: data.volume,
        rate: data.rate,
      };
      if (frames && frames.size > 0) {
        for (const fid of frames) {
          if (fid === 0) continue; // top frame already got it via notifyTab
          chrome.tabs.sendMessage(activeTabId, payload, { frameId: fid }).catch(() => {});
        }
      }
    }
  };

  ws.onclose = (event) => {
    console.log('[daddys party] ws closed', { code: event?.code, reason: event?.reason, wasClean: event?.wasClean });
    const wasConnected = roomId && roomId !== 'CONNECTING';
    const prevRoomId = roomId;
    ws = null;

    if (intentionalDisconnect) {
      roomId = null;
      persistState();
      if (wasConnected) {
        notifyTab({ type: 'ws-closed' });
        notifyPopup({ type: 'ws-closed' });
      }
      return;
    }

    if (wasConnected && prevRoomId && lastServerUrl) {
      // unexpected disconnect — auto-reconnect with exponential backoff (max 6 tries)
      reconnectAttempts++;
      if (reconnectAttempts <= 6) {
        const delay = Math.min(2000 * reconnectAttempts, 10000);
        notifyTab({ type: 'ws-status', status: 'reconnecting', attempt: reconnectAttempts });
        setTimeout(() => {
          if (!intentionalDisconnect) {
            connectWS(lastServerUrl, 'reconnect', prevRoomId, username, 1);
          }
        }, delay);
        return;
      }
    }

    roomId = null;
    persistState();
    if (wasConnected) {
      notifyTab({ type: 'ws-closed' });
      notifyPopup({ type: 'ws-closed' });
    }
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
  intentionalDisconnect = true;
  reconnectAttempts = 0;
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
  delete videoFrameDurations[tabId];
  delete allVideoFrames[tabId];
  if (activeTabId === tabId) {
    disconnectWS();
  }
});
