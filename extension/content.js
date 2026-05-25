// daddy's party 🎬 — content script
// Detects video, manages overlay UI, forwards everything via background service worker
// (background owns the WebSocket so YouTube's CSP can't block it)

// Guard against double-injection (extension reload + scripting.executeScript)
if (window.__daddysparty_v3__) {
  console.log("[daddy's party] already loaded, skipping");
} else {
  window.__daddysparty_v3__ = true;

const IS_TOP = window === window.top;
const TENOR_KEY = 'LIVDSRZULELA';

// Returns true if our extension context is still valid (not invalidated by reload)
function extContextValid() {
  try { return !!chrome?.runtime?.id; } catch { return false; }
}

// Safe runtime call wrappers — throw nothing even if context is dead
function safeSendMessage(msg, cb) {
  if (!extContextValid()) return;
  try {
    const p = chrome.runtime.sendMessage(msg, cb);
    if (p?.catch) p.catch(() => {});
  } catch { /* context dead — silently drop */ }
}

function safeConnect(opts) {
  if (!extContextValid()) return null;
  try { return chrome.runtime.connect(opts); } catch { return null; }
}

// Keep service worker alive while overlay is open
let keepalivePort = null;
function startKeepalive() {
  if (keepalivePort) return;
  keepalivePort = safeConnect({ name: 'dp-keepalive' });
  if (keepalivePort) keepalivePort.onDisconnect.addListener(() => { keepalivePort = null; });
}

// ── FUNNY MESSAGES ────────────────────────────────────────────────────────────

const PLAY_MSGS  = ['pressed play 🎬', 'came back 👀', 'ready bestie 🍿', "it's giving cinema 💅", 'back on the grind 🫡'];
const PAUSE_MSGS = ['said hold on 💀', 'paused it 🛑', 'went to pee prob 💀', 'touching grass rq 🌿', 'said wait wait ✋'];
const JOIN_MSGS  = ['finally showed up 💅', 'entered the cinema 🎬', 'is here 🫶', 'arrived 👑'];
const LEAVE_MSGS = ['ghosted 💀', 'said peace ✌️', 'left the building 🚪', 'logged off 😭'];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// ── VIDEO DETECTION ─────────────────────────────────────────────

let videoEl     = null;
let isSyncing   = false;
let videoMutObs = null;
let inRoom      = false;
let isHost      = false; // true if we created the room (we're the sync authority)
let pendingPlayback = null; // queued playback event waiting for videoEl
let videoFoundPending = false;
let videoPollInterval = null;
let videoInIframeId = null; // (top frame only) frameId of iframe holding the video
let shadow = null;
let attachedAt = 0; // timestamp when video was attached — for "settle window" after page nav
let lastVisibilityChange = 0; // timestamp of last visibilitychange — suppress pause events from tab-switching
let weJustSeeked = false; // flag — true briefly after WE programmatically set currentTime
const SCRIPT_LOAD_TIME = Date.now(); // for settle window (vs attachedAt which can reset)
let lastUserClickTime = 0; // timestamp of last real user gesture — required for outbound events
let lastUserActionAt = 0; // timestamp of last user action we EMITTED — suppress in-flight sync from yanking us back
let autoplayBlocked = false; // true if browser refused our last play() call
let userSeekInProgress = false; // user-initiated seek is buffering — allow the eventual 'seeked' through
// drift-check state: what we last know about the shared playback
let lastSharedAction = null;   // 'play' / 'pause' / null
let lastSharedTime = 0;        // currentTime at the moment of the last shared event
let lastSharedAt = 0;          // local Date.now() when we received/sent it

// Track real user interaction so we can distinguish user actions from player auto-events
document.addEventListener('click',    onUserGesture, true);
document.addEventListener('keydown',  onUserGesture, true);
document.addEventListener('touchend', onUserGesture, true);

function onUserGesture(e) {
  lastUserClickTime = Date.now();
  autoplayBlocked = false;
  if (e.type === 'click') detectServerButtonClick(e);
}

// Detect when host clicks a "server" button on shady streaming sites. Common labels:
// Server 1/2/3, VidPlay, FileMoon, StreamTape, DoodStream, UpCloud, MixDrop, VidCloud, VidSrc, etc.
// When detected, notify partner via chat — they can manually click the matching one.
const SERVER_RE = /^(server\s*\d+|vidplay|filemoon|streamtape|doodstream|upcloud|mixdrop|vidcloud|vidsrc|streamwish|streamhg|playerwish|netu|wolfstream|netulounge|cloudvideo|streamsb|filelions|gomo)/i;
function detectServerButtonClick(e) {
  if (!inRoom) return;
  const el = e.target.closest('button, a, li, span, div[onclick], [role="button"]');
  if (!el) return;
  const text = (el.textContent || '').trim().slice(0, 40);
  if (!text || text.length > 40) return;
  if (SERVER_RE.test(text)) {
    // broadcast a chat-level notification (not auto-clicked on partner side — too fragile)
    wsSend({ type: 'chat', text: `🎬 switched to: ${text}` });
  }
}

document.addEventListener('visibilitychange', () => {
  lastVisibilityChange = Date.now();
});

function findVideo() {
  // YouTube-specific: main player has class 'html5-main-video'
  const yt = document.querySelector('video.html5-main-video');
  if (yt) return yt;

  const all = [...document.querySelectorAll('video')];
  if (!all.length) return null;
  // currently playing video is the main one
  const playing = all.find(v => !v.paused);
  if (playing) return playing;
  // long-duration video is likely the movie, not a preview
  const withDuration = all.filter(v => v.duration > 30 && isFinite(v.duration));
  if (withDuration.length) return withDuration.sort((a, b) => b.duration - a.duration)[0];
  // largest visible video
  const sized = all.filter(v => v.videoWidth > 0 || v.offsetWidth > 100);
  if (sized.length) return sized.sort((a, b) => (b.videoWidth * b.videoHeight) - (a.videoWidth * a.videoHeight))[0];
  return all[0];
}

function attachVideo(video) {
  if (videoEl === video) {
    applyPendingPlayback();
    return;
  }
  detachVideo();
  videoEl = video;
  attachedAt = Date.now(); // start of "settle window" — suppress outbound seeks for 5s
  video.addEventListener('play',    onPlay);
  video.addEventListener('pause',   onPause);
  video.addEventListener('seeked',  onSeeked);
  video.addEventListener('seeking', onSeeking); // fires IMMEDIATELY on seek (before buffer arrives)
  // re-register if duration becomes known later (initial duration is often NaN/0)
  const onDurChange = () => {
    if (videoEl === video && isFinite(video.duration) && video.duration > 60) {
      safeSendMessage({ type: 'register-video-frame', duration: video.duration });
      video.removeEventListener('durationchange', onDurChange);
    }
  };
  video.addEventListener('durationchange', onDurChange);
  // initial register
  safeSendMessage({
    type: 'register-video-frame',
    duration: isFinite(video.duration) ? video.duration : 0,
  });
  if (IS_TOP) {
    if (shadow) appendSys('video found — sync ready 🎬');
    else videoFoundPending = true;
    // when host's video attaches, broadcast state immediately so joiner can sync
    if (inRoom && isHost) {
      setTimeout(() => {
        if (videoEl) wsSend({
          type: 'playback',
          action: videoEl.paused ? 'pause' : 'play',
          currentTime: videoEl.currentTime,
        });
      }, 300);
    }
  }
  applyPendingPlayback();
}

function applyPendingPlayback() {
  if (!pendingPlayback || !videoEl) return;
  const p = pendingPlayback;
  pendingPlayback = null;
  setTimeout(() => applyPlayback(p.action, p.currentTime), 200);
}

function detachVideo() {
  if (!videoEl) return;
  videoEl.removeEventListener('play',    onPlay);
  videoEl.removeEventListener('pause',   onPause);
  videoEl.removeEventListener('seeked',  onSeeked);
  videoEl.removeEventListener('seeking', onSeeking);
  videoEl = null;
  if (seekDebounceTimer) { clearTimeout(seekDebounceTimer); seekDebounceTimer = null; }
}

// fires the MOMENT a seek is initiated (before buffer arrives). Record user intent
// here so the eventual 'seeked' (possibly seconds later if buffering) can still pass
// the eventGate, AND so drift correction doesn't yank us back during the buffer wait.
function onSeeking() {
  if (Date.now() - lastUserClickTime < 800) {
    userSeekInProgress = true;
    lastUserActionAt = Date.now();
  }
}

// Top frame checks inRoom locally; iframes always emit and let background gate
function onPlay()   { if (eventGate('play'))  { lastUserActionAt = Date.now(); emitVideoEvent('play',  videoEl.currentTime); } }
function onPause()  { if (eventGate('pause')) { lastUserActionAt = Date.now(); emitVideoEvent('pause', videoEl.currentTime); } }

// debounce seeked — players fire 2-4 seeked events for one user scrub
let seekDebounceTimer = null;
function onSeeked() {
  if (!eventGate('seek')) return;
  // CRITICAL: set lastUserActionAt NOW (not when debounce fires), so partner's in-flight
  // events during the 400ms window are correctly suppressed
  lastUserActionAt = Date.now();
  clearTimeout(seekDebounceTimer);
  seekDebounceTimer = setTimeout(() => {
    seekDebounceTimer = null;
    if (videoEl) emitVideoEvent(videoEl.paused ? 'pause' : 'play', videoEl.currentTime);
  }, 400);
}

function eventGate(kind) {
  if (isSyncing) return false;
  if (kind === 'seek' && weJustSeeked) return false;

  if (IS_TOP && !inRoom) return false;
  // skip preview/thumbnail/ad videos (any frame) — duration too short to be the main movie
  if (videoEl && isFinite(videoEl.duration) && videoEl.duration > 0 && videoEl.duration < 60) return false;

  // If the user just started a seek (seeking event fired within click window) and the
  // eventual seeked is arriving (possibly seconds later due to buffering) — pass it through.
  if (kind === 'seek' && userSeekInProgress) {
    userSeekInProgress = false;
    return true;
  }

  // Tight 800ms user-gesture window. Player auto-events fire within seconds of a click
  // (player loads, resumes from last position, etc.) — those need to be filtered out.
  if (Date.now() - lastUserClickTime > 800) return false;

  // settle window from PAGE LOAD (handles shady site auto-resume)
  if (kind === 'seek' && Date.now() - SCRIPT_LOAD_TIME < 5000) return false;

  // tab-switch suppression (YouTube debounces visibility events, 2s window covers them)
  if (kind === 'pause' && lastVisibilityChange && Date.now() - lastVisibilityChange < 2000) return false;

  return true;
}

function emitVideoEvent(action, currentTime) {
  // record OUR action as the shared baseline (both sides will then compute drift from same anchor)
  // Note: lastUserActionAt is already set by the on{Play/Pause/Seeked} handlers at the moment
  // of the actual user event, not here — keeping this in-flight protection accurate.
  lastSharedAction = action;
  lastSharedTime = currentTime;
  lastSharedAt = Date.now();

  if (IS_TOP) {
    wsSend({ type: 'playback', action, currentTime });
    appendSys(`📤 you ${action === 'play' ? 'played' : 'paused'} @ ${currentTime.toFixed(0)}s`);
    setStatus('ok', `→sent: ${action} @ ${currentTime.toFixed(0)}s`);
  } else {
    safeSendMessage({ type: 'iframe-video-event', action, currentTime });
    safeSendMessage({ type: 'iframe-debug', text: `📤 you ${action === 'play' ? 'played' : 'paused'} @ ${currentTime.toFixed(0)}s` });
  }
}

function applyPlayback(action, currentTime) {
  // cancel any pending seek-debounce — otherwise it'll fire 400ms later with partner's
  // currentTime (since we just set it here) and echo their position back as ours
  if (seekDebounceTimer) { clearTimeout(seekDebounceTimer); seekDebounceTimer = null; }

  // record the shared timeline anchor whenever we receive a sync event
  lastSharedAction = action;
  lastSharedTime = currentTime;
  lastSharedAt = Date.now();

  if (!videoEl) {
    pendingPlayback = { action, currentTime };
    if (IS_TOP && !videoInIframeId && !window.__dp_queued_logged__) {
      window.__dp_queued_logged__ = true;
      appendSys('queued — waiting for video to load ⏳');
    }
    return;
  }
  isSyncing = true;
  const oldTime = videoEl.currentTime;
  const diff = Math.abs(oldTime - currentTime);
  if (diff > 1.5) {
    weJustSeeked = true;
    videoEl.currentTime = currentTime;
    setTimeout(() => { weJustSeeked = false; }, 2500);
    if (IS_TOP) appendSys(`🎯 seeked ${oldTime.toFixed(0)}s → ${currentTime.toFixed(0)}s`);
  }
  if (action === 'play') {
    // if autoplay was already blocked, don't keep trying — just show banner
    if (autoplayBlocked) {
      showAutoplayBanner();
    } else {
      videoEl.play().catch(() => {
        autoplayBlocked = true;
        showAutoplayBanner();
      });
    }
  } else {
    videoEl.pause(); // pause always works without user gesture
  }
  setTimeout(() => { isSyncing = false; }, 1500);
}

function showAutoplayBanner() {
  if (document.getElementById('__dp_autoplay_banner__')) return;
  const banner = document.createElement('div');
  banner.id = '__dp_autoplay_banner__';
  banner.style.cssText = [
    'position:fixed','top:50%','left:50%','transform:translate(-50%,-50%)',
    'z-index:2147483647','background:linear-gradient(135deg,#ff2d78,#a855f7)',
    'color:#fff','padding:24px 32px','border-radius:16px',
    'font-family:system-ui,sans-serif','font-size:1.2rem','font-weight:700',
    'box-shadow:0 8px 40px #000a','cursor:pointer','text-align:center',
    'max-width:80vw','animation:dp-pulse 1s ease-in-out infinite alternate',
  ].join(';');
  banner.innerHTML = '👆 click the video to start syncing<br><span style="font-size:.8rem;font-weight:400;opacity:.9">your browser is blocking auto-play</span>';
  const style = document.createElement('style');
  style.textContent = '@keyframes dp-pulse{from{transform:translate(-50%,-50%) scale(1)}to{transform:translate(-50%,-50%) scale(1.05)}}';
  document.head.appendChild(style);
  banner.onclick = () => {
    banner.remove();
    style.remove();
    autoplayBlocked = false;
    lastUserClickTime = Date.now();
    if (videoEl) videoEl.play().catch(() => { autoplayBlocked = true; });
  };
  (document.fullscreenElement || document.body || document.documentElement).appendChild(banner);
  // banner stays until user clicks (don't auto-remove — they need to interact for sync to work)
}

function pollForVideo() {
  if (videoMutObs || videoPollInterval) return;
  const stop = () => {
    if (videoMutObs) { videoMutObs.disconnect(); videoMutObs = null; }
    if (videoPollInterval) { clearInterval(videoPollInterval); videoPollInterval = null; }
  };
  videoMutObs = new MutationObserver(() => {
    const v = findVideo();
    if (v) { stop(); attachVideo(v); }
  });
  videoMutObs.observe(document.documentElement, { childList: true, subtree: true });
  // backup: periodic poll in case MutationObserver misses it (YouTube can be tricky)
  videoPollInterval = setInterval(() => {
    const v = findVideo();
    if (v) { stop(); attachVideo(v); }
  }, 500);
}

const _v0 = findVideo();
if (_v0) attachVideo(_v0); else pollForVideo();

// METASTREAM-STYLE EVENT CAPTURE
// Catch dynamically-created videos the moment they fire play / durationchange.
// Far more reliable than polling on shady sites that remount the video element.
function videoEventCapture(e) {
  const target = e.target;
  if (!(target instanceof HTMLMediaElement)) return;
  if (target.tagName !== 'VIDEO') return;
  // skip short videos (likely previews/thumbnails)
  if (isFinite(target.duration) && target.duration > 0 && target.duration < 60) return;
  // attach if this is a better candidate than current
  if (videoEl !== target) {
    const currentDur = videoEl?.duration || 0;
    const newDur = target.duration || 0;
    // prefer longer-duration videos (the actual movie, not previews)
    if (!videoEl || newDur > currentDur || !videoEl.isConnected) {
      attachVideo(target);
    }
  }
}
document.addEventListener('play',           videoEventCapture, true);
document.addEventListener('durationchange', videoEventCapture, true);
document.addEventListener('loadedmetadata', videoEventCapture, true);
document.addEventListener('canplay',        videoEventCapture, true);

// Sync heartbeat every 2s. Runs in any frame that has the videoEl.
// - Top frame with video: send directly to WS via wsSend
// - Iframe with video: send via 'iframe-heartbeat' to background, it'll relay
let heartbeatLoggedNoVideo = 0;
setInterval(() => {
  if (!extContextValid()) return; // silently skip on dead context, don't stop forever

  // top frame: warn if no video found locally AND no iframe has registered one
  if (IS_TOP && !videoEl && !videoInIframeId) {
    if (!inRoom) return;
    heartbeatLoggedNoVideo++;
    if (heartbeatLoggedNoVideo === 5) {
      const count = document.querySelectorAll('video').length;
      const iframes = document.querySelectorAll('iframe').length;
      appendSys(`⚠️ top frame: ${count} <video>, ${iframes} <iframe>`);
      pollForVideo();
    }
    return;
  }

  // non-top frame: report periodically so we can see what's inside the nested iframes
  if (!IS_TOP && !videoEl) {
    heartbeatLoggedNoVideo++;
    if (heartbeatLoggedNoVideo === 3) {
      // bubble up info about this frame to the top frame's overlay
      const count = document.querySelectorAll('video').length;
      const iframes = document.querySelectorAll('iframe').length;
      const url = location.href.slice(0, 60);
      safeSendMessage({
        type: 'iframe-debug',
        text: `iframe (${url}): ${count} <video>, ${iframes} <iframe>`,
      });
    }
    return;
  }

  // only the frame WITH videoEl broadcasts state
  if (!videoEl) return;

  // skip preview/thumbnail videos in ANY frame (not just iframes)
  if (isFinite(videoEl.duration) && videoEl.duration > 0 && videoEl.duration < 60) return;

  heartbeatLoggedNoVideo = 0;

  const action = videoEl.paused ? 'pause' : 'play';
  const currentTime = videoEl.currentTime;

  // SILENT state-ping (never broadcast — server stores for late joiners only)
  if (IS_TOP) {
    if (inRoom) wsSend({ type: 'state-ping', action, currentTime });
  } else {
    safeSendMessage({ type: 'iframe-heartbeat', action, currentTime });
  }

  // ── DRIFT CHECK — local computation, no network ──────────────────
  // Skip if tab is hidden (background-throttled timers vs video clock produce false drifts)
  if (document.hidden) return;
  // Skip if video is actively buffering or mid-seek — don't second-guess the player
  if (videoEl.seeking || videoEl.readyState < 3) return;
  if (lastSharedAction && Date.now() - lastUserActionAt > 5000 && !isSyncing && !autoplayBlocked) {
    let expected = lastSharedTime;
    if (lastSharedAction === 'play') {
      expected += (Date.now() - lastSharedAt) / 1000;
    }
    const drift = Math.abs(currentTime - expected);
    if (drift > 3) {
      weJustSeeked = true;
      videoEl.currentTime = expected;
      setTimeout(() => { weJustSeeked = false; }, 2500);
      if (IS_TOP) appendSys(`drift ${drift.toFixed(0)}s — corrected`);
      else safeSendMessage({ type: 'iframe-debug', text: `drift ${drift.toFixed(0)}s — corrected` });
    }
  }
}, 5000);

// ── URL CHANGE DETECTION ─────────────────────────────────────────────
// Top frame: broadcasts full page navigations
// Iframe: broadcasts embed URL changes (e.g. shady site server-switching)
{
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href === lastUrl) return;
    const oldUrl = lastUrl;
    lastUrl = location.href;
    if (IS_TOP) {
      if (inRoom) wsSend({ type: 'url-change', url: location.href });
    } else {
      // iframe URL changed — tell background, which forwards to room
      safeSendMessage({ type: 'iframe-url-change', url: location.href, oldUrl });
    }
  }).observe(document, { subtree: true, childList: true });
}

if (IS_TOP) {

  // On page load: check if this tab is already in a party (e.g. after auto-nav)
  // and restore the overlay state
  setTimeout(() => {
    if (!extContextValid()) return;
    // (we used to auto-disconnect on manual nav, but that punished users for clicking
    // "next episode" on shady sites which is a full nav. Now we just restore the party
    // on any navigation — partner is independent and won't be affected.)
    sessionStorage.removeItem('dp-auto-nav');

    safeSendMessage({ type: 'is-in-party' }, (res) => {
      if (chrome.runtime?.lastError || !res?.inParty) return;

      // restore party state regardless of whether nav was auto or user-initiated
      inRoom = true;
      isHost = res.isHost === true;
      startKeepalive();
      showOverlay();
      overlaySetRoom(res.roomId);
      if (res.members) overlaySetMembers(res.members);
      if (res.state) {
        pendingPlayback = { action: res.state.action, currentTime: res.state.currentTime };
      }
      appendSys('reconnected — catching up 🎬');
      attachVideoOrPoll();
    });
  }, 100);
}

// ── WS HELPER (sends through background) ─────────────────────────────────────

function wsSend(payload) {
  safeSendMessage({ type: 'ws-send', payload });
}

// ── MESSAGE LISTENER ─────────────────────────────────────────────────────────

// log so we can verify content script loaded
console.log("[daddy's party 🎬] content script loaded on", location.href);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // ping handler — popup uses this to verify content script is loaded
  if (msg.type === 'ping') {
    sendResponse({ pong: true, version: 3 });
    return true;
  }

  // popup checking if there's a video on this page (lenient — just any <video>)
  if (msg.type === 'check-video') {
    sendResponse({ hasVideo: !!document.querySelector('video') });
    return true;
  }

  // playback from background → apply to local video (iframe or main)
  if (msg.type === 'apply-playback') {
    // ignore incoming syncs for 1.5s after WE took an action — in-flight partner events
    // would otherwise yank us back. 1.5s is a compromise: long enough to cover the round-trip
    // back from server, short enough that a real subsequent partner action isn't suppressed.
    if (Date.now() - lastUserActionAt < 1500) {
      console.log('[daddys party] iframe apply-playback SUPPRESSED — recent user action');
      sendResponse({ ok: true });
      return true;
    }
    console.log('[daddys party] iframe apply-playback', msg.action, '@', msg.currentTime?.toFixed(1));
    const hadVideo = !!videoEl;
    applyPlayback(msg.action, msg.currentTime);
    if (!IS_TOP) {
      safeSendMessage({
        type: 'iframe-debug',
        text: hadVideo
          ? `iframe synced → ${msg.action} @ ${msg.currentTime.toFixed(0)}s`
          : `iframe got msg but no video yet — re-scanning`,
      });
      if (!hadVideo) {
        const v = findVideo();
        if (v) attachVideo(v);
      }
    }
    sendResponse({ ok: true });
    return true;
  }

  // iframe debug message — relayed to top frame for display
  if (msg.type === 'iframe-debug') {
    if (IS_TOP) appendSys(msg.text);
    sendResponse({ ok: true });
    return true;
  }

  // top frame asked iframe to push its current playback state (force-resync button)
  if (msg.type === 'force-emit-state' && !IS_TOP) {
    if (videoEl) {
      lastUserActionAt = Date.now();
      safeSendMessage({
        type: 'iframe-video-event',
        action: videoEl.paused ? 'pause' : 'play',
        currentTime: videoEl.currentTime,
      });
      safeSendMessage({
        type: 'iframe-debug',
        text: `🔧 forced push from iframe: ${videoEl.paused ? 'pause' : 'play'} @ ${videoEl.currentTime.toFixed(0)}s`,
      });
    }
    sendResponse({ ok: true });
    return true;
  }

  // these only matter in the top frame (overlay lives there)
  if (!IS_TOP) return true;

  switch (msg.type) {
    case 'ws-status':
      startKeepalive();
      showOverlay();
      if (msg.status === 'connecting')   appendSys(msg.attempt > 1 ? `retrying… (${msg.attempt}/3) 🔄` : 'connecting… give it a sec 🔄');
      if (msg.status === 'retrying')     appendSys(`render is asleep, retrying… (${msg.attempt}/3) 💤`);
      if (msg.status === 'reconnecting') appendSys(`connection dropped, reconnecting… (${msg.attempt}/6) 🔄`);
      break;

    case 'ws-msg':
      handleServerMsg(msg.data);
      break;

    case 'ws-error':
      appendSys(msg.message + ' 💀');
      break;

    case 'ws-closed':
      inRoom = false;
      setStatus('bad', 'disconnected — reopen extension');
      appendSys('disconnected 😭 open the extension to rejoin');
      break;

    case 'ws-disconnected-by-user':
      inRoom = false;
      hideOverlay();
      removePill();
      break;

    case 'video-in-iframe':
      // an iframe registered itself as the video source
      if (msg.frameId && msg.frameId !== 0) {
        videoInIframeId = msg.frameId;
        appendSys(`✓ video found inside iframe — sync ready 🎬`);
      }
      break;

    case 'apply-to-video-frame':
      // route through background
      safeSendMessage(msg);
      break;
  }
  return true;
});

// ── SERVER MESSAGE HANDLER ───────────────────────────────────────────────────

function attachVideoOrPoll() {
  const v = findVideo();
  if (v) attachVideo(v); else pollForVideo();
}

function handleServerMsg(msg) {
  switch (msg.type) {
    case 'created':
      inRoom = true;
      isHost = true; // we created the room — we're the sync authority
      clearChatLog(); // fresh party = fresh chat
      overlaySetRoom(msg.roomId);
      setStatus('ok', 'connected — host');
      appendSys("you're in! 🎉 you're the HOST");
      wsSend({ type: 'url-change', url: location.href });
      attachVideoOrPoll();
      break;

    case 'joined':
      inRoom = true;
      isHost = false;
      clearChatLog(); // fresh party = fresh chat
      overlaySetRoom(msg.roomId);
      setStatus('ok', 'connected — joiner');
      // skip applying state if server JUST recreated the room (Render restart) — its
      // default {pause, 0} would wipe both sides back to start. Wait for other side's state-ping.
      if (msg.state && !msg.recreated) {
        pendingPlayback = { action: msg.state.playing ? 'play' : 'pause', currentTime: msg.state.currentTime };
        lastSharedAction = msg.state.playing ? 'play' : 'pause';
        lastSharedTime = msg.state.currentTime;
        lastSharedAt = Date.now();
      } else if (msg.recreated) {
        appendSys('server restarted — keeping current position');
      }
      if (msg.lastUrl && msg.lastUrl !== location.href) {
        sessionStorage.setItem('dp-auto-nav', '1'); // flag: WE initiated this nav, not the user
        appendSys(`taking you to where they're watching… 🎬`);
        setTimeout(() => { location.href = msg.lastUrl; }, 800);
        break;
      }
      appendSys("you're in! 🎉 you're the JOINER");
      attachVideoOrPoll();
      break;
    case 'error':
      appendSys(msg.message + ' 💀');
      break;
    case 'members':
      overlaySetMembers(msg.members);
      break;
    case 'peer-joined':
      appendSys(`${msg.username} ${pick(JOIN_MSGS)}`);
      // re-broadcast our URL AND current playback state so the joiner syncs to us
      if (inRoom) {
        setTimeout(() => {
          wsSend({ type: 'url-change', url: location.href });
          if (videoEl) {
            wsSend({
              type: 'playback',
              action: videoEl.paused ? 'pause' : 'play',
              currentTime: videoEl.currentTime,
            });
          }
        }, 500);
      }
      break;
    case 'peer-left':   appendSys(`${msg.username} ${pick(LEAVE_MSGS)}`); break;
    case 'version-mismatch':
      // big visible warning — outdated client = broken sync
      appendSys(`⚠️ VERSION MISMATCH — ${msg.versions}`);
      appendSys(`⚠️ older side won't have latest sync fixes! update at:`);
      appendSys(`github.com/suyog-1/watchparty/releases/latest`);
      setStatus('bad', '⚠ version mismatch — sync may break');
      break;
    case 'playback': {
      // suppress in-flight partner sync for 1.5s after our own user action (was 2.5s, too aggressive)
      if (Date.now() - lastUserActionAt < 1500) {
        console.log('[daddys party] playback from', msg.from, 'SUPPRESSED — recent user action');
        appendSys(`(skipped ${msg.from}'s sync — your action wins)`);
        break;
      }

      console.log('[daddys party] applying playback from', msg.from, msg.action, '@', msg.currentTime?.toFixed(1));
      setStatus('ok', `←sync from ${msg.from}: ${msg.action} @ ${msg.currentTime.toFixed(0)}s`);
      const wasPlaying = videoEl ? !videoEl.paused : false;
      const wasTime = videoEl ? videoEl.currentTime : 0;
      const isStateChange = videoEl && (
        wasPlaying !== (msg.action === 'play') ||
        Math.abs(wasTime - msg.currentTime) > 2
      );
      applyPlayback(msg.action, msg.currentTime);
      if (isStateChange || !videoEl) {
        appendSys(`${msg.from} ${msg.action === 'play' ? pick(PLAY_MSGS) : pick(PAUSE_MSGS)}`);
      } else {
        appendSys(`✓ in sync with ${msg.from} @ ${msg.currentTime.toFixed(0)}s`);
      }
      break;
    }
    case 'chat':       appendChat(msg.username, msg.text); break;
    case 'gif':        appendGif(msg.username, msg.url);  break;
    case 'reaction':   popReaction(msg.emoji); appendSys(`${msg.username} ${msg.emoji}`); break;
    case 'jumpscare':  doJumpscare(msg.username); break;
    case 'url-change':
      // just notify — don't auto-navigate. If user wants to follow, they navigate manually.
      // (manual nav will trigger the "user left party" flow which is what we want)
      if (msg.url !== location.href) {
        const short = msg.url.replace(/^https?:\/\//, '').slice(0, 60);
        appendSys(`${msg.username} moved to ${short}`);
      }
      break;
  }
}

// ── JUMPSCARE ─────────────────────────────────────────────────────────────────

// pool of scare effects — each one different
const SCARE_EFFECTS = [
  { color: '#ff0000', emoji: '😱', anim: 'flash' },
  { color: '#000000', emoji: '👻', anim: 'flash' },
  { color: '#ff6600', emoji: '🎃', anim: 'shake' },
  { color: '#8b0000', emoji: '💀', anim: 'flash' },
  { color: '#2c003e', emoji: '🦇', anim: 'shake' },
  { color: '#ffffff', emoji: '😈', anim: 'flash' },
];

function doJumpscare(from) {
  const e = SCARE_EFFECTS[Math.floor(Math.random() * SCARE_EFFECTS.length)];
  const s = document.createElement('style');
  s.textContent = `
    @keyframes __dp_flash{0%{opacity:1}100%{opacity:0}}
    @keyframes __dp_shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-30px)}75%{transform:translateX(30px)}}
  `;
  document.head.appendChild(s);
  const el = document.createElement('div');
  const animName = e.anim === 'shake' ? '__dp_shake' : '__dp_flash';
  el.style.cssText = `position:fixed;inset:0;z-index:2147483646;background:${e.color};display:flex;align-items:center;justify-content:center;font-size:20vw;animation:${animName} .7s ease-out forwards;pointer-events:none;`;
  el.textContent = e.emoji;
  document.body.appendChild(el);
  el.addEventListener('animationend', () => { el.remove(); s.remove(); });
}

// ── TENOR GIF SEARCH ──────────────────────────────────────────────────────────

function getMovieContext() {
  // pull what's likely the movie/video title from the page
  // e.g. "John Wick - YouTube" → "John Wick reaction"
  let title = document.title || '';
  title = title.split(/[-—|·]/)[0].trim();
  title = title.replace(/\(.*?\)/g, '').replace(/\[.*?\]/g, '').trim();
  if (!title || title.length < 3) {
    const fallbacks = ['movie reaction', 'popcorn', 'cinema', 'watching tv', 'movie night'];
    return fallbacks[Math.floor(Math.random() * fallbacks.length)];
  }
  return title + ' reaction';
}

async function searchGifs(query) {
  const res = await fetch(`https://api.tenor.com/v1/search?q=${encodeURIComponent(query)}&key=${TENOR_KEY}&limit=12&media_filter=minimal&contentfilter=medium`);
  const data = await res.json();
  return data.results.map(r => ({
    preview: r.media[0].tinygif?.url || r.media[0].gif.url,
    full:    r.media[0].gif.url,
  }));
}

// ── OVERLAY UI ────────────────────────────────────────────────────────────────

const OVERLAY_CSS = `
  *{box-sizing:border-box;margin:0;padding:0}

  #panel{
    width:290px;
    background:#12001f;
    border:1.5px solid #d63af940;
    border-radius:18px;
    overflow:hidden;
    box-shadow:0 0 0 1px #ffffff08, 0 20px 50px #00000090;
    font-family:'Segoe UI',system-ui,sans-serif;
    color:#f0f0f5;
    display:flex;
    flex-direction:column;
  }

  #bar{
    display:flex;align-items:center;gap:8px;
    padding:11px 14px;
    background:linear-gradient(90deg,#1e0035,#0d0020);
    border-bottom:1px solid #ffffff0e;
    flex-shrink:0;
  }
  #bar-left{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
  #title{
    font-weight:800;font-size:.78rem;letter-spacing:.5px;
    background:linear-gradient(90deg,#ff2d78,#bf5af2);
    -webkit-background-clip:text;-webkit-text-fill-color:transparent;
  }
  #who{font-size:.68rem;color:#9969cc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #code-chip{
    font-size:.72rem;font-weight:700;letter-spacing:2px;
    background:#ff2d7820;color:#ff2d78;
    border:1px solid #ff2d7840;border-radius:6px;
    padding:3px 8px;cursor:pointer;user-select:none;flex-shrink:0;
    transition:background .15s;
  }
  #code-chip:hover{background:#ff2d7835}
  .ib{
    background:none;border:none;cursor:pointer;
    color:#6644aa;font-size:.85rem;padding:3px 5px;
    border-radius:5px;transition:color .15s;flex-shrink:0;
  }
  .ib:hover{color:#f0f0f5}

  #body{display:flex;flex-direction:column;overflow:hidden;max-height:400px;transition:max-height .25s cubic-bezier(.4,0,.2,1)}
  #body.mini{max-height:0}

  #log{
    flex:1;height:170px;overflow-y:auto;
    padding:10px 12px;display:flex;flex-direction:column;gap:7px;
    scrollbar-width:thin;scrollbar-color:#ffffff15 transparent;
  }
  .m{display:flex;flex-direction:column;gap:1px;animation:fi .18s ease}
  @keyframes fi{from{opacity:0;transform:translateY(3px)}to{opacity:1}}
  .m .who{font-size:.66rem;font-weight:700;color:#ff2d78}
  .m.s  .who{color:#bf5af2}
  .m .txt{font-size:.82rem;color:#e8e8f0;line-height:1.4;word-break:break-word}
  .m.s  .txt{color:#7755aa;font-style:italic}
  .m .gimg{max-width:100%;border-radius:8px;margin-top:3px}

  #status-row{display:flex;align-items:center;gap:6px;padding:6px 12px;border-top:1px solid #ffffff08;flex-shrink:0;font-size:.68rem;color:#9969cc}
  #status-row .dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:#888}
  #status-row.ok .dot{background:#4ade80}
  #status-row.bad .dot{background:#ef4444}
  #resync-btn{
    margin-left:auto;background:#2d0060;border:1px solid #bf5af240;border-radius:6px;
    color:#bf5af2;font-size:.68rem;font-weight:700;padding:3px 8px;cursor:pointer;
  }
  #resync-btn:hover{background:#3d0080}

  #rxns{display:flex;align-items:center;gap:4px;padding:7px 12px;border-top:1px solid #ffffff08;flex-shrink:0}
  .rb{
    background:none;border:1px solid #ffffff15;border-radius:7px;
    font-size:1rem;padding:3px 7px;cursor:pointer;
    transition:transform .12s,background .12s;
  }
  .rb:hover{transform:scale(1.2);background:#ffffff0e}
  #scare{
    margin-left:auto;
    background:linear-gradient(135deg,#c0392b,#e74c3c);
    border:none;border-radius:7px;color:#fff;
    font-size:.68rem;font-weight:700;padding:4px 9px;
    cursor:pointer;transition:transform .12s;white-space:nowrap;
  }
  #scare:hover{transform:scale(1.06)}

  #gifpanel{display:none;flex-direction:column;gap:7px;padding:9px 12px;border-top:1px solid #ffffff08}
  #gifpanel.open{display:flex}
  #gifsearch{
    background:#1e0035;border:1px solid #ff2d7840;border-radius:8px;
    color:#f0f0f5;font-size:.8rem;padding:7px 10px;outline:none;width:100%;
  }
  #gifsearch:focus{border-color:#ff2d78}
  #gifsearch::placeholder{color:#664488}
  #gifgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;max-height:130px;overflow-y:auto;scrollbar-width:thin;scrollbar-color:#ffffff15 transparent}
  .gt{width:100%;aspect-ratio:1;object-fit:cover;border-radius:6px;cursor:pointer;transition:opacity .12s}
  .gt:hover{opacity:.8}
  #gifhint{font-size:.75rem;color:#664488;text-align:center;padding:8px}

  #cin-row{display:flex;gap:6px;padding:8px 10px;border-top:1px solid #ffffff08;align-items:center;flex-shrink:0}
  #cin{
    flex:1;background:#1e0035;border:1px solid #ffffff12;border-radius:9px;
    color:#f0f0f5;font-size:.82rem;padding:8px 11px;outline:none;min-width:0;
  }
  #cin:focus{border-color:#ff2d7860}
  #cin::placeholder{color:#664488}
  #gbtn{
    background:#2d0060;border:1px solid #bf5af240;border-radius:8px;
    color:#bf5af2;font-size:.7rem;font-weight:700;
    padding:8px 9px;cursor:pointer;transition:background .12s;
  }
  #gbtn:hover{background:#3d0080}
  #sbtn{
    background:linear-gradient(135deg,#ff2d78,#bf5af2);
    border:none;border-radius:8px;color:#fff;
    font-size:.82rem;padding:8px 13px;cursor:pointer;transition:transform .12s;
  }
  #sbtn:hover{transform:scale(1.05)}

  #rxnlayer{position:fixed;bottom:90px;right:24px;pointer-events:none;z-index:2147483647}
  .rb2{position:absolute;font-size:2rem;bottom:0;animation:fup 2.4s ease-out forwards}
  @keyframes fup{0%{opacity:1;transform:translateY(0) scale(.7)}100%{opacity:0;transform:translateY(-170px) scale(1.3)}}
`;

function buildOverlay() {
  const host = document.createElement('div');
  host.id = '__daddysparty__';
  host.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:2147483647;';
  (document.fullscreenElement || document.documentElement).appendChild(host);
  shadow = host.attachShadow({ mode: 'open' });

  shadow.innerHTML = `
    <style>${OVERLAY_CSS}</style>
    <div id="rxnlayer"></div>
    <div id="panel">
      <div id="bar">
        <div id="bar-left">
          <span id="title">daddy's party 🎬 <span style="font-size:.6rem;color:#664488;font-weight:400">v${(chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '?'}</span></span>
          <span id="who">—</span>
        </div>
        <span id="code-chip">—</span>
        <button class="ib" id="minbtn">▾</button>
        <button class="ib" id="xbtn" title="hide (stays connected)">✕</button>
      </div>
      <div id="body">
        <div id="log"></div>
        <div id="status-row">
          <span class="dot"></span>
          <span id="status-text">checking…</span>
          <button id="resync-btn" title="push your current playback position to your partner">🔧 push sync</button>
        </div>
        <div id="rxns">
          <button class="rb" data-e="❤️">❤️</button>
          <button class="rb" data-e="😂">😂</button>
          <button class="rb" data-e="😱">😱</button>
          <button class="rb" data-e="👏">👏</button>
          <button class="rb" data-e="🍿">🍿</button>
          <button class="rb" data-e="💀">💀</button>
          <button id="scare">😈 scare</button>
        </div>
        <div id="gifpanel">
          <input id="gifsearch" placeholder="search gifs…" autocomplete="off" />
          <div id="gifgrid"><p id="gifhint">type above to search 🔍</p></div>
        </div>
        <div id="cin-row">
          <input id="cin" placeholder="say something…" maxlength="300" />
          <button id="gbtn">GIF</button>
          <button id="sbtn">→</button>
        </div>
      </div>
    </div>
  `;

  wireOverlay();

  // if video was attached before overlay was built, log it now
  if (videoFoundPending || videoEl) {
    videoFoundPending = false;
    appendSys('video found — sync ready 🎬');
  } else {
    appendSys('no video on this page yet — waiting…');
  }
}

function wireOverlay() {
  const body = shadow.getElementById('body');
  shadow.getElementById('minbtn').onclick = () => {
    const mini = body.classList.toggle('mini');
    shadow.getElementById('minbtn').textContent = mini ? '▴' : '▾';
  };

  // X = hide overlay only, stay connected; pill brings it back
  shadow.getElementById('xbtn').onclick = () => hideOverlay();

  shadow.getElementById('code-chip').onclick = () => {
    const code = shadow.getElementById('code-chip').textContent;
    if (code === '—') return;
    navigator.clipboard.writeText(code).then(() => {
      const el = shadow.getElementById('code-chip');
      el.textContent = 'copied 📋';
      setTimeout(() => { el.textContent = code; }, 1400);
    });
  };

  // FORCE PUSH SYNC — emits current playback state immediately, bypassing the gesture gate.
  // Use when sync is stuck/glitchy and you want to force your partner to your current position.
  shadow.getElementById('resync-btn').onclick = () => {
    if (!videoEl) {
      // try to find one in the iframe via background routing
      const v = findVideo();
      if (v) attachVideo(v);
    }
    if (videoEl) {
      lastUserActionAt = Date.now(); // protect against partner echo for 1.5s
      const payload = {
        type: 'playback',
        action: videoEl.paused ? 'pause' : 'play',
        currentTime: videoEl.currentTime,
      };
      if (IS_TOP) wsSend(payload);
      else safeSendMessage({ type: 'iframe-video-event', action: payload.action, currentTime: payload.currentTime });
      appendSys(`🔧 forced push: ${payload.action} @ ${payload.currentTime.toFixed(0)}s`);
    } else {
      // top frame has no videoEl — ask any iframe with video to push
      appendSys('🔧 push requested — checking iframes…');
      // background can route to the registered video frame
      safeSendMessage({ type: 'request-iframe-push' });
    }
  };

  shadow.querySelectorAll('.rb').forEach(b => {
    b.onclick = () => wsSend({ type: 'reaction', emoji: b.dataset.e });
  });

  // cycle scare button text on each click
  const SCARE_LABELS = ['😈 scare', '👻 boo', '🎃 spook', '💀 doom', '🦇 freak', '😱 jump'];
  let scareIdx = 0;
  shadow.getElementById('scare').onclick = () => {
    wsSend({ type: 'jumpscare' });
    scareIdx = (scareIdx + 1) % SCARE_LABELS.length;
    shadow.getElementById('scare').textContent = SCARE_LABELS[scareIdx];
  };

  const gifPanel = shadow.getElementById('gifpanel');
  shadow.getElementById('gbtn').onclick = () => {
    gifPanel.classList.toggle('open');
    if (gifPanel.classList.contains('open')) {
      shadow.getElementById('gifsearch').focus();
      // load default gifs based on what they're watching
      const grid = shadow.getElementById('gifgrid');
      if (!grid.querySelector('.gt')) {
        loadGifs(getMovieContext());
      }
    }
  };

  let gifTimer = null;
  shadow.getElementById('gifsearch').addEventListener('input', e => {
    clearTimeout(gifTimer);
    const q = e.target.value.trim();
    if (q) gifTimer = setTimeout(() => loadGifs(q), 500);
  });
  stopProp(shadow.getElementById('gifsearch'));

  const cin = shadow.getElementById('cin');
  shadow.getElementById('sbtn').onclick = doChat;
  cin.addEventListener('keydown', e => { if (e.key === 'Enter') doChat(); e.stopPropagation(); });
  stopProp(cin);
}

function stopProp(el) {
  ['keyup','keypress'].forEach(ev => el.addEventListener(ev, e => e.stopPropagation()));
}

async function loadGifs(query) {
  const grid = shadow.getElementById('gifgrid');
  grid.innerHTML = '<p id="gifhint">loading… 🔍</p>';
  try {
    const gifs = await searchGifs(query);
    grid.innerHTML = '';
    gifs.forEach(g => {
      const img = document.createElement('img');
      img.className = 'gt';
      img.src = g.preview;
      img.loading = 'lazy';
      img.onclick = () => {
        wsSend({ type: 'gif', url: g.full });
        shadow.getElementById('gifpanel').classList.remove('open');
        shadow.getElementById('gifsearch').value = '';
        grid.innerHTML = '<p id="gifhint">type above to search 🔍</p>';
      };
      grid.appendChild(img);
    });
  } catch (_) {
    grid.innerHTML = '<p id="gifhint">failed 😭 check connection</p>';
  }
}

function doChat() {
  const cin = shadow.getElementById('cin');
  const text = cin.value.trim();
  if (!text) return;
  wsSend({ type: 'chat', text });
  cin.value = '';
}

// ── OVERLAY HELPERS ───────────────────────────────────────────────────────────

function showOverlay() {
  if (!shadow) buildOverlay();
  shadow.host.style.display = 'block';
  removePill();
}

function hideOverlay() {
  if (shadow) shadow.host.style.display = 'none';
  if (inRoom) showPill();
}

function showPill() {
  if (document.getElementById('__dp_pill__')) return;
  const pill = document.createElement('div');
  pill.id = '__dp_pill__';
  pill.style.cssText = [
    'position:fixed','bottom:20px','right:20px','z-index:2147483647',
    'background:linear-gradient(135deg,#ff2d78,#a855f7)',
    'color:#fff','border-radius:20px','padding:8px 14px',
    'font-family:system-ui,sans-serif','font-size:.78rem','font-weight:700',
    'cursor:pointer','box-shadow:0 4px 16px #ff2d7850',
    'user-select:none',
  ].join(';');
  pill.textContent = "🎬 daddy's party";
  pill.onclick = () => { showOverlay(); };
  (document.fullscreenElement || document.documentElement).appendChild(pill);
}

// When fullscreen state changes, move the overlay/pill to the fullscreen element
// so it stays visible over fullscreen video (YouTube, Netflix, etc.)
if (IS_TOP) {
  document.addEventListener('fullscreenchange', () => {
    const fsEl = document.fullscreenElement;
    const target = fsEl || document.documentElement;
    const host = document.getElementById('__daddysparty__');
    if (host && host.parentElement !== target) target.appendChild(host);
    const pill = document.getElementById('__dp_pill__');
    if (pill && pill.parentElement !== target) target.appendChild(pill);
  });
}

function removePill() {
  const pill = document.getElementById('__dp_pill__');
  if (pill) pill.remove();
}

function overlaySetRoom(id) {
  if (!shadow) return;
  shadow.getElementById('code-chip').textContent = id;
}
function overlaySetMembers(m) {
  if (!shadow) return;
  shadow.getElementById('who').textContent = m.join(' & ');
}

// Update the connection-status indicator at the bottom of the overlay.
// Called on ws-status, ws-msg arrivals, etc.
function setStatus(state, text) {
  if (!shadow) return;
  const row = shadow.getElementById('status-row');
  const txt = shadow.getElementById('status-text');
  if (!row || !txt) return;
  row.classList.remove('ok', 'bad');
  if (state === 'ok')  row.classList.add('ok');
  if (state === 'bad') row.classList.add('bad');
  txt.textContent = text;
}

function appendChat(who, text) { if (shadow) append(false, who, text); }
function appendSys(text)       { if (shadow) append(true,  '•',  text); }

function clearChatLog() {
  if (!shadow) return;
  const log = shadow.getElementById('log');
  if (log) log.innerHTML = '';
}

function appendGif(who, url) {
  if (!shadow) return;
  if (shadow.host.style.display === 'none') showOverlay();
  const log = shadow.getElementById('log');
  const el  = document.createElement('div');
  el.className = 'm';
  el.innerHTML = `<span class="who">${esc(who)}</span>`;
  const img = document.createElement('img');
  img.className = 'gimg'; img.src = url; img.alt = 'gif';
  el.appendChild(img);
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
}

function appendUrlNotif(who, url) {
  if (!shadow) return;
  if (shadow.host.style.display === 'none') showOverlay();
  const log = shadow.getElementById('log');
  const el  = document.createElement('div');
  el.className = 'm s';
  const whoEl = document.createElement('span');
  whoEl.className = 'who';
  whoEl.textContent = '•';
  const txtEl = document.createElement('span');
  txtEl.className = 'txt';
  txtEl.textContent = `${who} opened something — `;
  const a = document.createElement('a');
  a.textContent = 'open it too →';
  a.href = '#';
  a.style.cssText = 'color:#ff2d78;font-weight:700;text-decoration:none;';
  a.onclick = (e) => { e.preventDefault(); location.href = url; };
  txtEl.appendChild(a);
  el.appendChild(whoEl);
  el.appendChild(txtEl);
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
}

function append(sys, who, text) {
  if (shadow?.host.style.display === 'none') showOverlay();
  const log = shadow.getElementById('log');
  const el  = document.createElement('div');
  el.className = sys ? 'm s' : 'm';
  el.innerHTML = `<span class="who">${esc(who)}</span><span class="txt">${esc(text)}</span>`;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
}

function popReaction(emoji) {
  if (!shadow) return;
  const layer = shadow.getElementById('rxnlayer');
  const el = document.createElement('div');
  el.className = 'rb2';
  el.textContent = emoji;
  el.style.right = (Math.random() * 60) + 'px';
  layer.appendChild(el);
  el.addEventListener('animationend', () => el.remove());
}

function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

} // end of double-injection guard
