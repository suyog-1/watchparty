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
    // already attached — but maybe we have pending playback now
    applyPendingPlayback();
    return;
  }
  detachVideo();
  videoEl = video;
  video.addEventListener('play',   onPlay);
  video.addEventListener('pause',  onPause);
  video.addEventListener('seeked', onSeeked);
  safeSendMessage({ type: 'register-video-frame' });
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
  videoEl.removeEventListener('play',   onPlay);
  videoEl.removeEventListener('pause',  onPause);
  videoEl.removeEventListener('seeked', onSeeked);
  videoEl = null;
}

// Top frame checks inRoom locally; iframes always emit and let background gate
// (because iframes never receive ws-msg so inRoom would always be false there)
function onPlay()   { if (eventGate()) emitVideoEvent('play',  videoEl.currentTime); }
function onPause()  { if (eventGate()) emitVideoEvent('pause', videoEl.currentTime); }
function onSeeked() { if (eventGate()) emitVideoEvent(videoEl.paused ? 'pause' : 'play', videoEl.currentTime); }

function eventGate() {
  if (isSyncing) return false;
  if (IS_TOP) return inRoom; // top frame: only emit when actually in a room
  return true; // iframe: always emit, background will discard if not in room
}

function emitVideoEvent(action, currentTime) {
  if (IS_TOP) wsSend({ type: 'playback', action, currentTime });
  else safeSendMessage({ type: 'iframe-video-event', action, currentTime });
}

function applyPlayback(action, currentTime) {
  if (!videoEl) {
    pendingPlayback = { action, currentTime };
    // only log "queued" once per page, and only if we don't know about an iframe video
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
    videoEl.currentTime = currentTime;
    if (IS_TOP) appendSys(`🎯 seeked ${oldTime.toFixed(0)}s → ${currentTime.toFixed(0)}s`);
  }
  if (action === 'play') {
    videoEl.play().catch(() => {
      showAutoplayBanner();
    });
  } else {
    videoEl.pause();
  }
  setTimeout(() => { isSyncing = false; }, 500);
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
  banner.onclick = () => { banner.remove(); style.remove(); if (videoEl) videoEl.play().catch(()=>{}); };
  (document.fullscreenElement || document.body || document.documentElement).appendChild(banner);
  setTimeout(() => { banner.remove(); style.remove(); }, 8000);
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
  heartbeatLoggedNoVideo = 0;

  const action = videoEl.paused ? 'pause' : 'play';
  const currentTime = videoEl.currentTime;

  if (IS_TOP) {
    if (!inRoom) return;
    wsSend({
      type: isHost ? 'playback' : 'state-ping',
      action, currentTime,
    });
  } else {
    // iframe — background knows if we're in a room + isHost
    safeSendMessage({ type: 'iframe-heartbeat', action, currentTime });
  }
}, 2000);

// ── URL CHANGE DETECTION (top frame only) ─────────────────────────────────────
if (IS_TOP) {
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      if (inRoom) wsSend({ type: 'url-change', url: location.href });
    }
  }).observe(document, { subtree: true, childList: true });

  // On page load: check if this tab is already in a party (e.g. after auto-nav)
  // and restore the overlay state
  setTimeout(() => {
    if (!extContextValid()) return;
    safeSendMessage({ type: 'is-in-party' }, (res) => {
      if (chrome.runtime?.lastError || !res?.inParty) return;
      inRoom = true;
      isHost = res.isHost === true; // restore role from background
      startKeepalive();
      showOverlay();
      overlaySetRoom(res.roomId);
      if (res.members) overlaySetMembers(res.members);
      if (res.state) {
        pendingPlayback = { action: res.state.action, currentTime: res.state.currentTime };
      }
      appendSys('reconnected — catching up 🎬');
      // host re-broadcasts URL after navigation so joiner can follow
      if (isHost) wsSend({ type: 'url-change', url: location.href });
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
    const hadVideo = !!videoEl;
    applyPlayback(msg.action, msg.currentTime);
    // tell top frame so user can see iframe is receiving sync events
    if (!IS_TOP) {
      safeSendMessage({
        type: 'iframe-debug',
        text: hadVideo
          ? `iframe synced → ${msg.action} @ ${msg.currentTime.toFixed(0)}s`
          : `iframe got msg but no video yet — re-scanning`,
      });
      if (!hadVideo) {
        // try to re-find video right now
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

  // these only matter in the top frame (overlay lives there)
  if (!IS_TOP) return true;

  switch (msg.type) {
    case 'ws-status':
      startKeepalive();
      showOverlay();
      if (msg.status === 'connecting') appendSys(msg.attempt > 1 ? `retrying… (${msg.attempt}/3) 🔄` : 'connecting… give it a sec 🔄');
      if (msg.status === 'retrying')   appendSys(`render is asleep, retrying… (${msg.attempt}/3) 💤`);
      break;

    case 'ws-msg':
      handleServerMsg(msg.data);
      break;

    case 'ws-error':
      appendSys(msg.message + ' 💀');
      break;

    case 'ws-closed':
      inRoom = false;
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
      overlaySetRoom(msg.roomId);
      appendSys("you're in! 🎉 you're the HOST — sync flows from your video");
      wsSend({ type: 'url-change', url: location.href });
      attachVideoOrPoll();
      break;

    case 'joined':
      inRoom = true;
      isHost = false; // we joined someone else's room — they're the authority
      overlaySetRoom(msg.roomId);
      // queue the room's current playback state so we sync to where host is
      if (msg.state) {
        pendingPlayback = { action: msg.state.playing ? 'play' : 'pause', currentTime: msg.state.currentTime };
      }
      // if room already has a URL, auto-navigate there
      if (msg.lastUrl && msg.lastUrl !== location.href) {
        appendSys(`taking you to where they're watching… 🎬`);
        setTimeout(() => { location.href = msg.lastUrl; }, 800);
        break;
      }
      appendSys("you're in! 🎉 you're the JOINER — follow the host's video");
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
    case 'playback': {
      // detect if this is a real change vs a heartbeat (no actual state change)
      const wasPlaying = videoEl ? !videoEl.paused : false;
      const wasTime = videoEl ? videoEl.currentTime : 0;
      const isStateChange = videoEl && (
        wasPlaying !== (msg.action === 'play') ||
        Math.abs(wasTime - msg.currentTime) > 2
      );
      applyPlayback(msg.action, msg.currentTime);
      if (isStateChange || !videoEl) {
        appendSys(`${msg.from} ${msg.action === 'play' ? pick(PLAY_MSGS) : pick(PAUSE_MSGS)}`);
      }
      break;
    }
    case 'chat':       appendChat(msg.username, msg.text); break;
    case 'gif':        appendGif(msg.username, msg.url);  break;
    case 'reaction':   popReaction(msg.emoji); appendSys(`${msg.username} ${msg.emoji}`); break;
    case 'jumpscare':  doJumpscare(msg.username); break;
    case 'url-change':
      // auto-navigate to follow partner — content script will re-init on new page
      if (msg.url !== location.href) {
        appendSys(`${msg.username} is at: ${msg.url.slice(0, 50)}…`);
        appendSys(`taking you there… 🎬`);
        setTimeout(() => { location.href = msg.url; }, 800);
      } else {
        appendSys(`✓ same page as ${msg.username} — ready to watch`);
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
          <span id="title">daddy's party 🎬</span>
          <span id="who">—</span>
        </div>
        <span id="code-chip">—</span>
        <button class="ib" id="minbtn">▾</button>
        <button class="ib" id="xbtn" title="hide (stays connected)">✕</button>
      </div>
      <div id="body">
        <div id="log"></div>
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

function appendChat(who, text) { if (shadow) append(false, who, text); }
function appendSys(text)       { if (shadow) append(true,  '•',  text); }

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
