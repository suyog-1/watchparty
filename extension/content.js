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
let videoMutObs = null;
let inRoom      = false;
let isHost      = false; // true if we created the room
let pendingPlayback = null; // queued playback event waiting for videoEl
let countdownUsed = false; // one-shot per party — host only, hides after use
let memberCount = 0; // current room member count (from server 'members' message)
let videoFoundPending = false;
let videoPollInterval = null;
let videoInIframeId = null; // (top frame only) frameId of iframe holding the video
let shadow = null;
let autoplayBlocked = false; // true if browser refused our last play() call

// ── SYNTHETIC EVENT SUPPRESSION (Synclify-style) ──────────────────────────────
// When WE programmatically apply a sync (play/pause/seek/volume/rate change),
// the browser fires a corresponding event. Without suppression, that event
// gets re-broadcast and the other side echoes it back → infinite ping-pong.
// Solution: set a counter before the action, the next N events of matching
// types are consumed without broadcasting. No timing windows, no races.
const syntheticEventQueue = []; // array of event types pending suppression

function suppressNext(eventType) {
  syntheticEventQueue.push(eventType);
  // safety: if no event arrives within 2s (e.g. play was a no-op), drop it
  setTimeout(() => {
    const idx = syntheticEventQueue.indexOf(eventType);
    if (idx >= 0) syntheticEventQueue.splice(idx, 1);
  }, 2000);
}

function shouldSuppressEvent(eventType) {
  const idx = syntheticEventQueue.indexOf(eventType);
  if (idx < 0) return false;
  syntheticEventQueue.splice(idx, 1);
  return true;
}

// Track clicks only to (a) reset autoplay-blocked flag and (b) detect server-button clicks
document.addEventListener('click',    onUserGesture, true);
document.addEventListener('keydown',  onUserGesture, true);
document.addEventListener('touchend', onUserGesture, true);

function onUserGesture(e) {
  autoplayBlocked = false;
  if (e.type === 'click') detectServerButtonClick(e);
}

// Detect when host clicks a "server" button on shady streaming sites.
const SERVER_RE = /^(server\s*\d+|vidplay|filemoon|streamtape|doodstream|upcloud|mixdrop|vidcloud|vidsrc|streamwish|streamhg|playerwish|netu|wolfstream|netulounge|cloudvideo|streamsb|filelions|gomo)/i;
function detectServerButtonClick(e) {
  if (!inRoom) return;
  const el = e.target.closest('button, a, li, span, div[onclick], [role="button"]');
  if (!el) return;
  const text = (el.textContent || '').trim().slice(0, 40);
  if (!text || text.length > 40) return;
  if (SERVER_RE.test(text)) {
    wsSend({ type: 'chat', text: `🎬 switched to: ${text}` });
  }
}

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

// All the HTMLVideoElement events we sync across the wire.
// Each maps directly to itself on the receiving side — no translation.
const SYNCED_VIDEO_EVENTS = ['play', 'pause', 'seeked', 'volumechange', 'ratechange'];

function attachVideo(video) {
  if (videoEl === video) {
    applyPendingPlayback();
    return;
  }
  detachVideo();
  videoEl = video;

  // Attach ONE handler to every synced event type. The handler is identical:
  // if syntheticEventQueue has this type queued, consume + suppress. Otherwise broadcast.
  for (const evt of SYNCED_VIDEO_EVENTS) {
    video.addEventListener(evt, onSyncedVideoEvent, true); // capture phase, run before site listeners
  }

  // Re-register if duration becomes known later (initial duration is often NaN/0)
  const onDurChange = () => {
    if (videoEl === video && isFinite(video.duration) && video.duration > 60) {
      safeSendMessage({ type: 'register-video-frame', duration: video.duration });
      video.removeEventListener('durationchange', onDurChange);
    }
  };
  video.addEventListener('durationchange', onDurChange);

  // Buffering signals (sub-feature Synclify doesn't have): tell partner when we stall
  video.addEventListener('waiting', onBuffering);
  video.addEventListener('playing', onBufferResolved);

  safeSendMessage({
    type: 'register-video-frame',
    duration: isFinite(video.duration) ? video.duration : 0,
  });
  if (IS_TOP) {
    if (shadow) appendSys('video found — sync ready 🎬');
    else videoFoundPending = true;
    if (inRoom && isHost) {
      setTimeout(() => {
        if (videoEl) wsSend({
          type: 'playback',
          eventType: videoEl.paused ? 'pause' : 'play',
          currentTime: videoEl.currentTime,
          volume: videoEl.volume,
          rate: videoEl.playbackRate,
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
  setTimeout(() => applyRemoteVideoEvent(p), 200);
}

function detachVideo() {
  if (!videoEl) return;
  for (const evt of SYNCED_VIDEO_EVENTS) {
    videoEl.removeEventListener(evt, onSyncedVideoEvent, true);
  }
  videoEl.removeEventListener('waiting', onBuffering);
  videoEl.removeEventListener('playing', onBufferResolved);
  videoEl = null;
  syntheticEventQueue.length = 0;
}

// THE CORE: one handler for all video events. Synclify-style suppression via
// per-event-type queue instead of timer-based windows. Bulletproof.
function onSyncedVideoEvent(e) {
  // Skip preview/ad videos in any frame
  if (videoEl && isFinite(videoEl.duration) && videoEl.duration > 0 && videoEl.duration < 60) return;

  if (shouldSuppressEvent(e.type)) {
    e.stopImmediatePropagation();
    return;
  }
  if (IS_TOP && !inRoom) return;

  emitVideoEvent(e.type, videoEl.currentTime, videoEl.volume, videoEl.playbackRate);
}

function emitVideoEvent(eventType, currentTime, volume, rate) {
  const payload = { eventType, currentTime, volume, rate };
  if (IS_TOP) {
    wsSend({ type: 'playback', ...payload });
    setStatus('ok', `→${eventType} @ ${currentTime.toFixed(0)}s`);
    // Don't spam chat log for volume/rate (too frequent). Only meaningful events.
    if (eventType === 'play' || eventType === 'pause' || eventType === 'seeked') {
      appendSys(`📤 you ${eventType === 'play' ? 'played' : eventType === 'pause' ? 'paused' : 'seeked to'} @ ${currentTime.toFixed(0)}s`);
    }
  } else {
    safeSendMessage({ type: 'iframe-video-event', ...payload });
  }
}

// Apply a remote sync event to our video. ALWAYS queues the corresponding
// synthetic event for suppression first, so we don't echo back.
function applyRemoteVideoEvent(p) {
  if (!videoEl) {
    pendingPlayback = p;
    if (IS_TOP && !videoInIframeId && !window.__dp_queued_logged__) {
      window.__dp_queued_logged__ = true;
      appendSys('queued — waiting for video to load ⏳');
    }
    return;
  }

  switch (p.eventType) {
    case 'play':
      suppressNext('play');
      if (autoplayBlocked) {
        showAutoplayBanner();
      } else {
        videoEl.play().catch(() => { autoplayBlocked = true; showAutoplayBanner(); });
      }
      break;
    case 'pause':
      suppressNext('pause');
      videoEl.pause();
      break;
    case 'seeked':
      // Only seek if meaningfully different (avoid syncing micro-drift)
      if (Math.abs(videoEl.currentTime - p.currentTime) > 0.5) {
        suppressNext('seeked');
        videoEl.currentTime = p.currentTime;
        if (IS_TOP) appendSys(`🎯 synced to ${p.currentTime.toFixed(0)}s`);
      }
      break;
    case 'volumechange':
      if (p.volume !== undefined && Math.abs(videoEl.volume - p.volume) > 0.01) {
        suppressNext('volumechange');
        videoEl.volume = p.volume;
      }
      break;
    case 'ratechange':
      if (p.rate !== undefined && Math.abs(videoEl.playbackRate - p.rate) > 0.01) {
        suppressNext('ratechange');
        videoEl.playbackRate = p.rate;
        if (IS_TOP) appendSys(`⏩ playback speed: ${p.rate}x`);
      }
      break;
  }
}

// ── BUFFERING-AWARE SYNC ────────────────────────────────────────────────────
// When YOU stall (buffer underrun), tell partner so they can wait for you.
// When you recover, tell them you're ready to resume.
// This is a feature Synclify doesn't have — huge for shady sites that buffer constantly.
let isBuffering = false;
function onBuffering() {
  if (!inRoom || isBuffering) return;
  isBuffering = true;
  if (IS_TOP) wsSend({ type: 'buffering' });
  else safeSendMessage({ type: 'iframe-buffering' });
}
function onBufferResolved() {
  if (!inRoom || !isBuffering) return;
  isBuffering = false;
  if (IS_TOP) wsSend({ type: 'buffered' });
  else safeSendMessage({ type: 'iframe-buffered' });
}

// Big floating banner shown when a newer extension version exists on GitHub.
// Click → opens releases page with full install instructions.
function showUpdateBanner(newVersion, currentVersion, url) {
  if (document.getElementById('__dp_update_banner__')) return;
  const banner = document.createElement('div');
  banner.id = '__dp_update_banner__';
  banner.style.cssText = [
    'position:fixed','top:16px','left:50%','transform:translateX(-50%)',
    'z-index:2147483647','background:linear-gradient(135deg,#ff2d78,#a855f7)',
    'color:#fff','padding:14px 22px','border-radius:14px',
    'font-family:system-ui,sans-serif','font-size:.95rem','font-weight:700',
    'box-shadow:0 8px 30px #000a','cursor:pointer','text-align:center',
    'max-width:90vw','display:flex','flex-direction:column','gap:6px','align-items:center',
  ].join(';');
  banner.innerHTML =
    `🎁 new version <strong>v${newVersion}</strong> available (you're on v${currentVersion})` +
    `<span style="font-size:.78rem;font-weight:400;opacity:.95">click to download → extract → hit 🔄 in chrome://extensions</span>` +
    `<span style="font-size:.65rem;opacity:.7;margin-top:2px">(or click ✕ to dismiss until next check)</span>`;
  const closeBtn = document.createElement('span');
  closeBtn.textContent = '✕';
  closeBtn.style.cssText = 'position:absolute;top:6px;right:10px;font-size:1rem;font-weight:700;opacity:.7';
  closeBtn.onclick = (e) => { e.stopPropagation(); banner.remove(); };
  banner.appendChild(closeBtn);
  banner.onclick = () => {
    window.open(url, '_blank');
    banner.remove();
  };
  (document.fullscreenElement || document.body || document.documentElement).appendChild(banner);
}

// Pre-roll countdown — both sides see a synchronized "3... 2... 1... GO" overlay
// and both videos start playing at the same instant. Feature Synclify doesn't have.
function showCountdown(triggeredBy) {
  if (document.getElementById('__dp_countdown__')) return;
  const overlay = document.createElement('div');
  overlay.id = '__dp_countdown__';
  overlay.style.cssText = [
    'position:fixed','inset:0','z-index:2147483647',
    'background:rgba(0,0,0,0.7)','color:#fff',
    'display:flex','flex-direction:column','align-items:center','justify-content:center',
    'font-family:system-ui,sans-serif','pointer-events:none',
  ].join(';');
  const num = document.createElement('div');
  num.style.cssText = 'font-size:30vw;font-weight:900;background:linear-gradient(135deg,#ff2d78,#bf5af2);-webkit-background-clip:text;-webkit-text-fill-color:transparent;';
  const label = document.createElement('div');
  label.style.cssText = 'font-size:1.2rem;color:#bf5af2;margin-top:20px;opacity:.8';
  label.textContent = triggeredBy ? `${triggeredBy} started a countdown` : 'starting together…';
  overlay.appendChild(num);
  overlay.appendChild(label);
  (document.fullscreenElement || document.body || document.documentElement).appendChild(overlay);

  let n = 3;
  num.textContent = n;
  const tick = setInterval(() => {
    n--;
    if (n <= 0) {
      clearInterval(tick);
      num.textContent = 'GO! 🎬';
      // Play the video on both sides simultaneously
      if (videoEl) {
        suppressNext('play');
        videoEl.play().catch(() => { autoplayBlocked = true; showAutoplayBanner(); });
      }
      setTimeout(() => overlay.remove(), 800);
    } else {
      num.textContent = n;
    }
  }, 1000);
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
    if (videoEl) videoEl.play().catch(() => { autoplayBlocked = true; });
  };
  (document.fullscreenElement || document.body || document.documentElement).appendChild(banner);
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

// Lightweight heartbeat — only used for:
//   1. Telling server about state for late-joiners (silent state-ping)
//   2. Diagnosing "where's the video?" when not found
// NO drift correction — Synclify proved each side can play independently after
// initial sync. Drift correction caused more bugs than it solved.
let heartbeatLoggedNoVideo = 0;
setInterval(() => {
  if (!extContextValid()) return;

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

  if (!IS_TOP && !videoEl) {
    heartbeatLoggedNoVideo++;
    if (heartbeatLoggedNoVideo === 3) {
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

  if (!videoEl) return;
  if (isFinite(videoEl.duration) && videoEl.duration > 0 && videoEl.duration < 60) return;
  heartbeatLoggedNoVideo = 0;

  // Silent state-ping for late-joiner catchup. Server stores, never broadcasts.
  const action = videoEl.paused ? 'pause' : 'play';
  const currentTime = videoEl.currentTime;
  if (IS_TOP) {
    if (inRoom) wsSend({ type: 'state-ping', action, currentTime, volume: videoEl.volume, rate: videoEl.playbackRate });
  } else {
    safeSendMessage({ type: 'iframe-heartbeat', action, currentTime, volume: videoEl.volume, rate: videoEl.playbackRate });
  }
}, 5000);

// ── PING/PONG LATENCY MEASUREMENT ────────────────────────────────────────────
// Synclify doesn't have this. Show partner's round-trip latency in the overlay.
let pingSentAt = 0;
let lastLatencyMs = null;
if (IS_TOP) {
  setInterval(() => {
    if (!inRoom || !extContextValid()) return;
    pingSentAt = Date.now();
    wsSend({ type: 'sync-ping', t: pingSentAt });
  }, 10000);
}

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
  // No time-based suppression needed — the syntheticEventQueue handles echoes precisely.
  if (msg.type === 'apply-playback') {
    const hadVideo = !!videoEl;
    applyRemoteVideoEvent({
      eventType: msg.eventType || msg.action, // tolerate old field name
      currentTime: msg.currentTime,
      volume: msg.volume,
      rate: msg.rate,
    });
    if (!IS_TOP) {
      safeSendMessage({
        type: 'iframe-debug',
        text: hadVideo
          ? `iframe synced → ${msg.eventType || msg.action} @ ${(msg.currentTime || 0).toFixed(0)}s`
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

  // background detected a new release on GitHub
  if (msg.type === 'update-available' && IS_TOP) {
    showUpdateBanner(msg.version, msg.currentVersion, msg.url);
    sendResponse({ ok: true });
    return true;
  }

  // top frame asked iframe to push its current playback state (force-resync button)
  if (msg.type === 'force-emit-state' && !IS_TOP) {
    if (videoEl) {
      safeSendMessage({
        type: 'iframe-video-event',
        eventType: videoEl.paused ? 'pause' : 'play',
        currentTime: videoEl.currentTime,
        volume: videoEl.volume,
        rate: videoEl.playbackRate,
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
      countdownUsed = false; // fresh party, one countdown available again
      memberCount = 1; // just us so far
      clearChatLog(); // fresh party = fresh chat
      overlaySetRoom(msg.roomId);
      setStatus('ok', 'connected — host');
      appendSys("you're in! 🎉 you're the HOST");
      updateCountdownButtonVisibility();
      wsSend({ type: 'url-change', url: location.href });
      attachVideoOrPoll();
      break;

    case 'joined':
      inRoom = true;
      isHost = false;
      countdownUsed = false; // tracked even though joiners can't trigger it
      memberCount = (msg.members?.length) || 2; // we joined so at least 2
      clearChatLog(); // fresh party = fresh chat
      overlaySetRoom(msg.roomId);
      setStatus('ok', 'connected — joiner');
      updateCountdownButtonVisibility(); // joiner: never visible (not host)
      if (msg.state && !msg.recreated) {
        pendingPlayback = {
          eventType: msg.state.playing ? 'play' : 'pause',
          currentTime: msg.state.currentTime,
          volume: msg.state.volume,
          rate: msg.state.rate,
        };
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
      memberCount = msg.members?.length || 0;
      updateCountdownButtonVisibility(); // becomes visible the moment partner joins
      break;
    case 'peer-joined':
      appendSys(`${msg.username} ${pick(JOIN_MSGS)}`);
      if (inRoom) {
        setTimeout(() => {
          wsSend({ type: 'url-change', url: location.href });
          if (videoEl) {
            wsSend({
              type: 'playback',
              eventType: videoEl.paused ? 'pause' : 'play',
              currentTime: videoEl.currentTime,
              volume: videoEl.volume,
              rate: videoEl.playbackRate,
            });
          }
        }, 500);
      }
      break;
    case 'peer-left':   appendSys(`${msg.username} ${pick(LEAVE_MSGS)}`); break;
    case 'version-mismatch':
      appendSys(`⚠️ VERSION MISMATCH — ${msg.versions}`);
      appendSys(`⚠️ older side won't have latest sync fixes! update at:`);
      appendSys(`github.com/suyog-1/watchparty/releases/latest`);
      setStatus('bad', '⚠ version mismatch — sync may break');
      break;

    case 'playback': {
      // No timing-based suppression — the syntheticEventQueue handles echo prevention precisely.
      const eventType = msg.eventType || msg.action; // tolerate old field name for backwards compat
      setStatus('ok', `←${msg.from}: ${eventType} @ ${(msg.currentTime || 0).toFixed(0)}s`);
      applyRemoteVideoEvent({
        eventType, currentTime: msg.currentTime, volume: msg.volume, rate: msg.rate,
      });
      // Only show chat for the "interesting" events, not every volumechange
      if (eventType === 'play') appendSys(`${msg.from} ${pick(PLAY_MSGS)}`);
      else if (eventType === 'pause') appendSys(`${msg.from} ${pick(PAUSE_MSGS)}`);
      else if (eventType === 'seeked') appendSys(`${msg.from} jumped to ${(msg.currentTime || 0).toFixed(0)}s 🎯`);
      break;
    }

    case 'buffering':
      // Partner stalled — auto-pause our video so we wait together
      if (videoEl && !videoEl.paused) {
        suppressNext('pause');
        videoEl.pause();
      }
      setStatus('bad', `⏳ ${msg.from} is buffering…`);
      appendSys(`⏳ ${msg.from} is buffering — paused so you can wait together`);
      break;

    case 'buffered':
      // Partner recovered — auto-resume
      if (videoEl && videoEl.paused) {
        suppressNext('play');
        videoEl.play().catch(() => { autoplayBlocked = true; showAutoplayBanner(); });
      }
      setStatus('ok', `▶ ${msg.from} ready — resumed`);
      appendSys(`✓ ${msg.from} recovered — playing again`);
      break;

    case 'sync-pong': {
      // Partner echoed back our ping — measure round-trip
      if (msg.t && msg.t === pingSentAt) {
        lastLatencyMs = Date.now() - msg.t;
        if (shadow) {
          const el = shadow.getElementById('latency');
          if (el) el.textContent = `${lastLatencyMs}ms`;
        }
      }
      break;
    }

    case 'countdown': {
      // Pre-roll countdown — synchronized start ("3... 2... 1... GO")
      showCountdown(msg.from);
      break;
    }
    case 'chat':       appendChat(msg.username, msg.text); break;
    case 'gif':        appendGif(msg.username, msg.url);  break;
    case 'reaction':   popReaction(msg.emoji); appendSys(`${msg.username} ${msg.emoji}`); break;
    case 'jumpscare':  doJumpscare(msg.username, msg.imageUrl); break;
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

// pool of default scare effects — used when user has no custom images uploaded
const SCARE_EFFECTS = [
  { color: '#ff0000', emoji: '😱', anim: 'flash' },
  { color: '#000000', emoji: '👻', anim: 'flash' },
  { color: '#ff6600', emoji: '🎃', anim: 'shake' },
  { color: '#8b0000', emoji: '💀', anim: 'flash' },
  { color: '#2c003e', emoji: '🦇', anim: 'shake' },
  { color: '#ffffff', emoji: '😈', anim: 'flash' },
];

// Anti-spam cooldown (per local user) — 30s between scares
const SCARE_COOLDOWN_MS = 30000;
let lastScareAt = 0;

// User's custom scare images, loaded from chrome.storage.local on overlay init.
// Each item is a small (max 400px, JPEG q70) data URL — ~10-40KB each.
let customScareImages = [];

function loadCustomScareImages() {
  try {
    chrome.storage.local.get(['scareImages'], (d) => {
      customScareImages = Array.isArray(d.scareImages) ? d.scareImages : [];
      updateScareButtonLabel();
    });
  } catch (_) {}
}

function saveCustomScareImages() {
  try { chrome.storage.local.set({ scareImages: customScareImages }); } catch (_) {}
}

// Resize an uploaded image to a small data URL so it's WebSocket-friendly (~30KB)
function resizeImageToDataUrl(file, maxSize = 400, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(maxSize / img.width, maxSize / img.height, 1);
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function doJumpscare(from, imageUrl) {
  const e = SCARE_EFFECTS[Math.floor(Math.random() * SCARE_EFFECTS.length)];
  const s = document.createElement('style');
  s.textContent = `
    @keyframes __dp_flash{0%{opacity:1}100%{opacity:0}}
    @keyframes __dp_shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-30px)}75%{transform:translateX(30px)}}
  `;
  document.head.appendChild(s);
  const el = document.createElement('div');
  const animName = e.anim === 'shake' ? '__dp_shake' : '__dp_flash';
  el.style.cssText = `position:fixed;inset:0;z-index:2147483646;background:${e.color};display:flex;align-items:center;justify-content:center;animation:${animName} .7s ease-out forwards;pointer-events:none;`;
  if (imageUrl) {
    const img = document.createElement('img');
    img.src = imageUrl;
    img.style.cssText = 'max-width:80vw;max-height:80vh;object-fit:contain;';
    el.appendChild(img);
  } else {
    el.style.fontSize = '20vw';
    el.textContent = e.emoji;
  }
  document.body.appendChild(el);
  el.addEventListener('animationend', () => { el.remove(); s.remove(); });
}

// Get the most recent scare cooldown remaining (in ms). 0 if ready.
function scareCooldownRemaining() {
  return Math.max(0, SCARE_COOLDOWN_MS - (Date.now() - lastScareAt));
}

// Update the scare button label to reflect cooldown + custom image count
let scareCooldownTimer = null;
function updateScareButtonLabel() {
  if (!shadow) return;
  const btn = shadow.getElementById('scare');
  if (!btn) return;
  const remaining = scareCooldownRemaining();
  if (remaining > 0) {
    btn.disabled = true;
    btn.textContent = `⏳ ${Math.ceil(remaining / 1000)}s`;
    btn.style.opacity = '0.5';
    if (!scareCooldownTimer) {
      scareCooldownTimer = setInterval(() => {
        if (scareCooldownRemaining() <= 0) {
          clearInterval(scareCooldownTimer);
          scareCooldownTimer = null;
        }
        updateScareButtonLabel();
      }, 500);
    }
  } else {
    btn.disabled = false;
    btn.style.opacity = '1';
    const count = customScareImages.length;
    btn.textContent = count > 0 ? `😈 scare (${count})` : '😈 scare';
  }
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

  #status-row{display:flex;align-items:center;gap:6px;padding:6px 12px;border-top:1px solid #ffffff08;flex-shrink:0;font-size:.68rem;color:#9969cc;flex-wrap:wrap}
  #status-row .dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:#888}
  #status-row.ok .dot{background:#4ade80}
  #status-row.bad .dot{background:#ef4444}
  #latency{font-size:.62rem;color:#664488;margin-left:4px}
  #resync-btn, #countdown-btn{
    background:#2d0060;border:1px solid #bf5af240;border-radius:6px;
    color:#bf5af2;font-size:.68rem;font-weight:700;padding:3px 8px;cursor:pointer;
  }
  #resync-btn{margin-left:auto}
  #resync-btn:hover, #countdown-btn:hover{background:#3d0080}

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
  #scare:hover:not(:disabled){transform:scale(1.06)}
  #scare:disabled{cursor:not-allowed}
  #scare-upload{
    background:#2d0060;border:1px solid #bf5af240;border-radius:6px;
    color:#bf5af2;font-size:.7rem;font-weight:700;padding:4px 7px;
    cursor:pointer;transition:background .12s;white-space:nowrap;
  }
  #scare-upload:hover{background:#3d0080}

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
          <span id="latency"></span>
          <button id="countdown-btn" title="3-2-1 countdown so you both start at the same instant">🎬 3-2-1</button>
          <button id="resync-btn" title="push your current playback position to your partner">🔧 push</button>
        </div>
        <div id="rxns">
          <button class="rb" data-e="❤️">❤️</button>
          <button class="rb" data-e="😂">😂</button>
          <button class="rb" data-e="😱">😱</button>
          <button class="rb" data-e="👏">👏</button>
          <button class="rb" data-e="🍿">🍿</button>
          <button class="rb" data-e="💀">💀</button>
          <button id="scare">😈 scare</button>
          <button id="scare-upload" title="upload custom scare images (jpg/png)">📷+</button>
          <input id="scare-file-input" type="file" accept="image/*" multiple style="display:none" />
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

  // ask background if there's a pending update we should banner about
  safeSendMessage({ type: 'get-update-status' }, (res) => {
    if (res?.updateAvailable) {
      const u = res.updateAvailable;
      showUpdateBanner(u.version, u.currentVersion, 'https://github.com/suyog-1/watchparty/releases/latest');
    }
  });
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

  // FORCE PUSH SYNC — emits current playback state immediately. Escape hatch.
  shadow.getElementById('resync-btn').onclick = () => {
    if (!videoEl) {
      const v = findVideo();
      if (v) attachVideo(v);
    }
    if (videoEl) {
      const payload = {
        type: 'playback',
        eventType: videoEl.paused ? 'pause' : 'play',
        currentTime: videoEl.currentTime,
        volume: videoEl.volume,
        rate: videoEl.playbackRate,
      };
      if (IS_TOP) wsSend(payload);
      else safeSendMessage({ type: 'iframe-video-event', ...payload });
      appendSys(`🔧 forced push: ${payload.eventType} @ ${payload.currentTime.toFixed(0)}s`);
    } else {
      appendSys('🔧 push requested — checking iframes…');
      safeSendMessage({ type: 'request-iframe-push' });
    }
  };

  // COUNTDOWN — host-only, one-shot per party. Hides after click to prevent spam.
  shadow.getElementById('countdown-btn').onclick = () => {
    if (!isHost || countdownUsed || memberCount < 2) return; // belt + braces
    countdownUsed = true;
    wsSend({ type: 'countdown' });
    showCountdown(); // also fire locally
    updateCountdownButtonVisibility(); // hides the button
  };

  // Initial visibility check (handles case where overlay built mid-party after restore)
  updateCountdownButtonVisibility();

  shadow.querySelectorAll('.rb').forEach(b => {
    b.onclick = () => wsSend({ type: 'reaction', emoji: b.dataset.e });
  });

  // SCARE — 30s cooldown + optional custom image broadcast
  shadow.getElementById('scare').onclick = () => {
    if (scareCooldownRemaining() > 0) return; // gate (also button is disabled visually)
    lastScareAt = Date.now();
    // pick a random custom image if user has any uploaded; otherwise undefined → receiver uses default emoji
    const imageUrl = customScareImages.length > 0
      ? customScareImages[Math.floor(Math.random() * customScareImages.length)]
      : undefined;
    wsSend({ type: 'jumpscare', imageUrl });
    updateScareButtonLabel(); // immediately reflect cooldown in the UI
  };

  // SCARE IMAGE UPLOAD
  const fileInput = shadow.getElementById('scare-file-input');
  shadow.getElementById('scare-upload').onclick = () => fileInput.click();
  fileInput.addEventListener('change', async (e) => {
    const files = [...(e.target.files || [])];
    if (!files.length) return;
    appendSys(`📷 processing ${files.length} image${files.length > 1 ? 's' : ''}…`);
    for (const f of files) {
      try {
        const dataUrl = await resizeImageToDataUrl(f, 400, 0.72);
        // safety cap: ~150KB per image (data URLs are ~33% bigger than raw bytes)
        if (dataUrl.length > 200_000) {
          appendSys(`⚠️ ${f.name} too big after resize — skipped`);
          continue;
        }
        customScareImages.push(dataUrl);
      } catch (err) {
        appendSys(`⚠️ couldn't read ${f.name}`);
      }
    }
    // cap total images at 20 so chrome.storage.local doesn't bloat
    if (customScareImages.length > 20) customScareImages = customScareImages.slice(-20);
    saveCustomScareImages();
    updateScareButtonLabel();
    appendSys(`✓ ${customScareImages.length} scare image${customScareImages.length === 1 ? '' : 's'} ready`);
    fileInput.value = ''; // allow re-uploading the same file
  });
  // right-click on upload button to clear all custom images
  shadow.getElementById('scare-upload').oncontextmenu = (e) => {
    e.preventDefault();
    if (!customScareImages.length) return;
    if (confirm(`clear all ${customScareImages.length} custom scare images?`)) {
      customScareImages = [];
      saveCustomScareImages();
      updateScareButtonLabel();
      appendSys('cleared custom scares — back to default emoji');
    }
  };

  loadCustomScareImages(); // populates customScareImages, updates label

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

// Countdown button visibility: only host, only once, only when partner has joined.
// Hides forever after first use (per party — resets on new created/joined).
function updateCountdownButtonVisibility() {
  if (!shadow) return;
  const btn = shadow.getElementById('countdown-btn');
  if (!btn) return;
  const visible = isHost && !countdownUsed && memberCount >= 2;
  btn.style.display = visible ? '' : 'none';
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
