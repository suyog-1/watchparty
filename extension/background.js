// Routes messages between frames + tracks active connection globally

const videoFrames = {}; // tabId → frameId of frame holding <video>
let activeConn    = null; // { tabId, roomId } — only one party at a time

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId       = sender.tab?.id;
  const senderFrame = sender.frameId ?? 0;

  switch (msg.type) {

    // ── frame routing ──────────────────────────────────────────────────────
    case 'register-video-frame':
      if (tabId !== undefined) {
        videoFrames[tabId] = senderFrame;
        if (senderFrame !== 0) {
          chrome.tabs.sendMessage(tabId, { type: 'video-in-iframe', frameId: senderFrame }, { frameId: 0 }).catch(() => {});
        }
      }
      sendResponse({ ok: true }); break;

    case 'iframe-video-event':
      if (tabId !== undefined) {
        chrome.tabs.sendMessage(tabId, { type: 'local-video-event', action: msg.action, currentTime: msg.currentTime }, { frameId: 0 }).catch(() => {});
      }
      sendResponse({ ok: true }); break;

    case 'apply-to-video-frame': {
      const vfid = videoFrames[tabId]?.frameId ?? videoFrames[tabId];
      if (vfid !== undefined && vfid !== 0) {
        chrome.tabs.sendMessage(tabId, { type: 'apply-playback', action: msg.action, currentTime: msg.currentTime }, { frameId: vfid }).catch(() => {});
      }
      sendResponse({ ok: true }); break;
    }

    // ── connection tracking (one party at a time) ──────────────────────────
    case 'get-connection':
      sendResponse({ conn: activeConn }); break;

    case 'set-connection':
      // roomId can be an actual id, 'CONNECTING', or null
      activeConn = msg.roomId ? { tabId: msg.tabId ?? tabId, roomId: msg.roomId } : null;
      sendResponse({ ok: true }); break;

    case 'focus-tab':
      if (msg.tabId) chrome.tabs.update(msg.tabId, { active: true }).catch(() => {});
      sendResponse({ ok: true }); break;
  }

  return true;
});

chrome.tabs.onRemoved.addListener(tabId => {
  delete videoFrames[tabId];
  if (activeConn?.tabId === tabId) activeConn = null;
});
