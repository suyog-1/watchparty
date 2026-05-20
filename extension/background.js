// Routes messages between frames within a tab.
// Content scripts can't talk to each other directly across frames,
// so they go through here.
//
// tabId → { videoFrameId }  — tracks which frame holds the <video> element

const tabState = {};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  if (tabId === undefined) { sendResponse({}); return true; }
  const senderFrame = sender.frameId ?? 0;

  switch (msg.type) {

    // A content script found a <video> — remember its frame.
    // If it's an iframe, alert the main frame so it routes sync there.
    case 'register-video-frame':
      tabState[tabId] = { videoFrameId: senderFrame };
      if (senderFrame !== 0) {
        chrome.tabs.sendMessage(tabId, { type: 'video-in-iframe', frameId: senderFrame }, { frameId: 0 }).catch(() => {});
      }
      sendResponse({ ok: true });
      break;

    // Video play/pause/seeked from inside an iframe — forward to main frame (which owns the WS)
    case 'iframe-video-event':
      chrome.tabs.sendMessage(tabId, { type: 'local-video-event', action: msg.action, currentTime: msg.currentTime }, { frameId: 0 }).catch(() => {});
      sendResponse({ ok: true });
      break;

    // Main frame wants to apply playback to a video that's in an iframe
    case 'apply-to-video-frame': {
      const vfid = tabState[tabId]?.videoFrameId;
      if (vfid !== undefined && vfid !== 0) {
        chrome.tabs.sendMessage(tabId, { type: 'apply-playback', action: msg.action, currentTime: msg.currentTime }, { frameId: vfid }).catch(() => {});
      }
      sendResponse({ ok: true });
      break;
    }
  }

  return true;
});

chrome.tabs.onRemoved.addListener(tabId => delete tabState[tabId]);
