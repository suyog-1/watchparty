// no skip zone 💀 — content script
// ALL FRAMES: video detection + playback control
// MAIN FRAME only: WebSocket + overlay UI

const IS_TOP = window === window.top;
const TENOR_KEY = 'LIVDSRZULELA'; // free Tenor demo key

// ── FUNNY MESSAGES ────────────────────────────────────────────────────────────

const PLAY_MSGS = [
  'pressed play bestie 🎬',
  'came back 👀',
  'ready to watch 🍿',
  "it's giving cinema 💅",
  'back on the grind 🫡',
  'said lets go 🔥',
  'no longer touching grass 🌿',
];
const PAUSE_MSGS = [
  'said hold on bestie 💀',
  'paused it rn 🛑',
  'went to pee prob 💀',
  'touching grass rq 🌿',
  'said wait wait wait ✋',
  'left us hanging 😭',
  'got distracted 🐿️',
];
const JOIN_MSGS = [
  'finally showed up 💅',
  'has entered the cinema 🎬',
  'is here bestie 🫶',
  'arrived (fashionably late) 👑',
];
const LEAVE_MSGS = [
  'ghosted us 💀',
  'said peace ✌️',
  'has left the building 🚪',
  'logged off 😭',
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// ── VIDEO DETECTION (ALL FRAMES) ─────────────────────────────────────────────

let videoEl = null;
let isSyncing = false;
let videoMutObs = null;

function findVideo() {
  return [...document.querySelectorAll('video')]
    .filter(v => v.offsetWidth > 0 && v.offsetHeight > 0 && v.readyState > 0)
    .sort((a, b) => b.videoWidth * b.videoHeight - a.videoWidth * a.videoHeight)[0] || null;
}

function attachVideo(video) {
  if (videoEl === video) return;
  detachVideo();
  videoEl = video;
  video.addEventListener('play',   onPlay);
  video.addEventListener('pause',  onPause);
  video.addEventListener('seeked', onSeeked);
  chrome.runtime.sendMessage({ type: 'register-video-frame' }).catch(() => {});
}

function detachVideo() {
  if (!videoEl) return;
  videoEl.removeEventListener('play',   onPlay);
  videoEl.removeEventListener('pause',  onPause);
  videoEl.removeEventListener('seeked', onSeeked);
  videoEl = null;
}

function onPlay()   { if (!isSyncing) emitVideoEvent('play',  videoEl.currentTime); }
function onPause()  { if (!isSyncing) emitVideoEvent('pause', videoEl.currentTime); }
function onSeeked() { if (!isSyncing) emitVideoEvent(videoEl.paused ? 'pause' : 'play', videoEl.currentTime); }

function emitVideoEvent(action, currentTime) {
  if (IS_TOP) wsSend({ type: 'playback', action, currentTime });
  else chrome.runtime.sendMessage({ type: 'iframe-video-event', action, currentTime }).catch(() => {});
}

function applyPlayback(action, currentTime) {
  if (!videoEl) return;
  isSyncing = true;
  if (Math.abs(videoEl.currentTime - currentTime) > 1.5) videoEl.currentTime = currentTime;
  action === 'play' ? videoEl.play().catch(() => {}) : videoEl.pause();
  setTimeout(() => { isSyncing = false; }, 500);
}

function pollForVideo() {
  if (videoMutObs) return;
  videoMutObs = new MutationObserver(() => {
    const v = findVideo();
    if (v) { videoMutObs.disconnect(); videoMutObs = null; attachVideo(v); }
  });
  videoMutObs.observe(document.documentElement, { childList: true, subtree: true });
}

const _initV = findVideo();
if (_initV) attachVideo(_initV); else pollForVideo();

// ── MESSAGE LISTENER (ALL FRAMES) ────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'apply-playback') {
    applyPlayback(msg.action, msg.currentTime);
    sendResponse({ ok: true });
    return true;
  }
  if (IS_TOP) handleTopMsg(msg, sendResponse);
  return true;
});

// ── MAIN FRAME: WEBSOCKET ─────────────────────────────────────────────────────

let ws = null;
let roomId = null;
let videoInIframeId = null;

function handleTopMsg(msg, sendResponse) {
  switch (msg.type) {
    case 'connect':
      connectWS(msg.serverUrl, msg.action, msg.roomId, msg.username);
      sendResponse({ ok: true }); break;
    case 'disconnect':
      if (ws) { ws.onclose = null; ws.close(); ws = null; }
      roomId = null; hideOverlay();
      sendResponse({ ok: true }); break;
    case 'status':
      sendResponse({ connected: ws?.readyState === WebSocket.OPEN, roomId }); break;
    case 'video-in-iframe':
      videoInIframeId = msg.frameId; break;
    case 'local-video-event':
      wsSend({ type: 'playback', action: msg.action, currentTime: msg.currentTime }); break;
  }
}

function connectWS(serverUrl, action, rid, uname) {
  if (ws) { ws.onclose = null; ws.close(); }
  const wsUrl = serverUrl.replace(/^https/, 'wss').replace(/^http/, 'ws');
  ws = new WebSocket(wsUrl);
  ws.onopen = () => wsSend(
    action === 'create'
      ? { type: 'create', username: uname }
      : { type: 'join',   username: uname, roomId: rid }
  );
  ws.onmessage = (e) => { try { handleServerMsg(JSON.parse(e.data)); } catch (_) {} };
  ws.onclose = () => { roomId = null; toast('disconnected 😭 reload n rejoin'); chrome.runtime.sendMessage({ type: 'ws-closed' }).catch(() => {}); };
  ws.onerror = () => toast('connection failed 💀 check the server url');
}

function wsSend(obj) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function handleServerMsg(msg) {
  switch (msg.type) {
    case 'created':
    case 'joined':
      roomId = msg.roomId;
      showOverlay();
      overlaySetRoom(msg.roomId);
      chrome.runtime.sendMessage({ type: 'connected', roomId: msg.roomId }).catch(() => {});
      const v = findVideo(); if (v) attachVideo(v); else pollForVideo();
      break;
    case 'error':
      chrome.runtime.sendMessage({ type: 'error', message: msg.message }).catch(() => {});
      toast(msg.message + ' 💀');
      break;
    case 'members':
      overlaySetMembers(msg.members);
      chrome.runtime.sendMessage({ type: 'members', members: msg.members }).catch(() => {});
      break;
    case 'peer-joined': appendSys(`${msg.username} ${pick(JOIN_MSGS)}`); break;
    case 'peer-left':   appendSys(`${msg.username} ${pick(LEAVE_MSGS)}`); break;
    case 'playback':
      if (videoInIframeId) {
        chrome.runtime.sendMessage({ type: 'apply-to-video-frame', action: msg.action, currentTime: msg.currentTime }).catch(() => {});
      } else {
        applyPlayback(msg.action, msg.currentTime);
      }
      appendSys(`${msg.from} ${msg.action === 'play' ? pick(PLAY_MSGS) : pick(PAUSE_MSGS)}`);
      break;
    case 'chat':      appendChat(msg.username, msg.text); break;
    case 'gif':       appendGif(msg.username, msg.url);  break;
    case 'reaction':  popReaction(msg.emoji); appendSys(`${msg.username} sent ${msg.emoji}`); break;
    case 'jumpscare': doJumpscare(msg.username); break;
  }
}

// ── JUMPSCARE ─────────────────────────────────────────────────────────────────

function doJumpscare(from) {
  const el = document.createElement('div');
  el.style.cssText = `
    position:fixed;inset:0;z-index:2147483646;
    background:#ff0000;display:flex;align-items:center;justify-content:center;
    font-size:20vw;animation:js-flash .6s ease-out forwards;
    pointer-events:none;
  `;
  el.textContent = '😱';

  const style = document.createElement('style');
  style.textContent = `@keyframes js-flash{0%{opacity:1}100%{opacity:0}}`;
  document.head.appendChild(style);
  document.body.appendChild(el);
  el.addEventListener('animationend', () => { el.remove(); style.remove(); });
  appendSys(`${from} just jumpscared you 😱💀`);
}

// ── TENOR GIF SEARCH ──────────────────────────────────────────────────────────

async function searchGifs(query) {
  const url = `https://api.tenor.com/v1/search?q=${encodeURIComponent(query)}&key=${TENOR_KEY}&limit=12&media_filter=minimal&contentfilter=medium`;
  const res = await fetch(url);
  const data = await res.json();
  return data.results.map(r => ({
    preview: r.media[0].tinygif?.url || r.media[0].gif.url,
    full:    r.media[0].gif.url,
  }));
}

// ── OVERLAY UI ────────────────────────────────────────────────────────────────

let shadow = null;

const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Bangers&display=swap');
  *{box-sizing:border-box;margin:0;padding:0}

  #panel{
    background:linear-gradient(160deg,#1a0a2e 0%,#0d0d1a 100%);
    border:2px solid #ff2d78;
    border-radius:20px;
    width:300px;
    display:flex;flex-direction:column;overflow:hidden;
    box-shadow:0 0 30px #ff2d7840, 0 8px 32px #0009;
    font-family:'Segoe UI',system-ui,sans-serif;
    color:#f0f0f5;
  }

  /* ── top bar ── */
  #bar{
    display:flex;align-items:center;justify-content:space-between;
    padding:10px 14px;gap:8px;cursor:default;
    background:linear-gradient(90deg,#ff2d7820,#a855f720);
    border-bottom:1px solid #ff2d7840;
  }
  #title{
    font-family:'Bangers',Impact,sans-serif;
    font-size:1.1rem;letter-spacing:1px;
    background:linear-gradient(90deg,#ff2d78,#a855f7);
    -webkit-background-clip:text;-webkit-text-fill-color:transparent;
  }
  #bar-right{display:flex;align-items:center;gap:6px}
  #code{
    font-size:.75rem;font-weight:700;color:#ff2d78;
    letter-spacing:2px;cursor:pointer;user-select:none;
    background:#ff2d7818;border-radius:6px;padding:3px 7px;
  }
  #code::before{content:'🎬 ';letter-spacing:0}
  #who{font-size:.7rem;color:#a855f7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:120px}
  .ib{background:none;border:none;cursor:pointer;color:#888899;font-size:.9rem;padding:2px 5px;border-radius:4px;transition:color .15s}
  .ib:hover{color:#f0f0f5}

  /* ── toast ── */
  #toast{
    font-size:.75rem;color:#ff2d78;padding:6px 14px;
    background:#ff2d7812;display:none;text-align:center;
    border-bottom:1px solid #ff2d7830;
  }

  /* ── chat log ── */
  #log{
    height:180px;overflow-y:auto;padding:10px 12px;
    display:flex;flex-direction:column;gap:8px;
    scrollbar-width:thin;scrollbar-color:#ff2d7830 transparent;
  }
  .m{display:flex;flex-direction:column;gap:2px;animation:fi .15s}
  @keyframes fi{from{opacity:0;transform:translateY(4px)}to{opacity:1}}
  .m .who{font-size:.68rem;font-weight:700;color:#ff2d78}
  .m.sys .who{color:#a855f7}
  .m .txt{font-size:.83rem;color:#f0f0f5;line-height:1.4;word-break:break-word}
  .m.sys .txt{color:#888899;font-style:italic}
  .m .gif-img{max-width:100%;border-radius:8px;margin-top:3px;cursor:pointer}

  /* ── reactions bar ── */
  #rxns{display:flex;flex-wrap:wrap;gap:5px;padding:8px 12px;border-top:1px solid #ffffff10}
  .rb{
    background:none;border:1px solid #ffffff18;border-radius:8px;
    font-size:1.1rem;padding:3px 8px;cursor:pointer;transition:transform .15s,background .15s;
  }
  .rb:hover{transform:scale(1.25);background:#ffffff10}
  #jumpscare-btn{
    margin-left:auto;
    background:linear-gradient(135deg,#ff0000,#ff6b00);
    border:none;border-radius:8px;
    font-size:.72rem;font-weight:700;color:#fff;
    padding:4px 9px;cursor:pointer;transition:transform .15s;
    white-space:nowrap;
  }
  #jumpscare-btn:hover{transform:scale(1.08)}
  #jumpscare-btn:active{transform:scale(.96)}

  /* ── gif search panel ── */
  #gif-panel{
    border-top:1px solid #ffffff10;
    display:none;flex-direction:column;gap:8px;padding:10px 12px;
  }
  #gif-panel.open{display:flex}
  #gif-search{
    background:#22222f;border:1px solid #ff2d7840;border-radius:9px;
    color:#f0f0f5;font-size:.83rem;padding:7px 11px;outline:none;width:100%;
  }
  #gif-search:focus{border-color:#ff2d78}
  #gif-search::placeholder{color:#888899}
  #gif-grid{
    display:grid;grid-template-columns:repeat(3,1fr);gap:5px;
    max-height:150px;overflow-y:auto;scrollbar-width:thin;scrollbar-color:#ff2d7830 transparent;
  }
  .gif-thumb{width:100%;aspect-ratio:1;object-fit:cover;border-radius:7px;cursor:pointer;transition:transform .15s}
  .gif-thumb:hover{transform:scale(1.05)}
  #gif-loading{font-size:.78rem;color:#888899;text-align:center;padding:10px}

  /* ── chat input ── */
  #cin-row{display:flex;gap:6px;padding:8px 10px;border-top:1px solid #ffffff10;align-items:center}
  #cin{
    flex:1;background:#22222f;border:1px solid #ffffff18;border-radius:10px;
    color:#f0f0f5;font-size:.83rem;padding:8px 11px;outline:none;min-width:0;
  }
  #cin:focus{border-color:#ff2d78}
  #cin::placeholder{color:#888899}
  #gif-btn{
    background:linear-gradient(135deg,#a855f7,#6366f1);
    border:none;border-radius:9px;color:#fff;font-size:.72rem;
    font-weight:700;padding:8px 10px;cursor:pointer;white-space:nowrap;
    transition:transform .15s;letter-spacing:.5px;
  }
  #gif-btn:hover{transform:scale(1.06)}
  #send-btn{
    background:linear-gradient(135deg,#ff2d78,#a855f7);
    border:none;border-radius:9px;color:#fff;font-size:.85rem;
    font-weight:700;padding:8px 13px;cursor:pointer;transition:transform .15s;
  }
  #send-btn:hover{transform:scale(1.06)}

  /* ── reaction floaties ── */
  #rxnlayer{position:fixed;bottom:90px;right:24px;pointer-events:none;z-index:2147483647}
  .rxn-bubble{
    position:absolute;font-size:2.2rem;bottom:0;
    animation:float-up 2.4s ease-out forwards;
  }
  @keyframes float-up{
    0%{opacity:1;transform:translateY(0) scale(.7)}
    100%{opacity:0;transform:translateY(-180px) scale(1.4)}
  }
`;

function buildOverlay() {
  const host = document.createElement('div');
  host.id = '__noskipzone__';
  host.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:2147483647;';
  document.documentElement.appendChild(host);
  shadow = host.attachShadow({ mode: 'open' });

  shadow.innerHTML = `
    <style>${CSS}</style>
    <div id="rxnlayer"></div>
    <div id="panel">
      <div id="bar">
        <div style="display:flex;flex-direction:column;gap:2px;min-width:0">
          <span id="title">no skip zone 💀</span>
          <span id="who">—</span>
        </div>
        <div id="bar-right">
          <span id="code">—</span>
          <button class="ib" id="min-btn" title="minimise">▾</button>
          <button class="ib" id="x-btn" title="leave">✕</button>
        </div>
      </div>
      <div id="body">
        <p id="toast"></p>
        <div id="log"></div>
        <div id="rxns">
          <button class="rb" data-e="❤️">❤️</button>
          <button class="rb" data-e="😂">😂</button>
          <button class="rb" data-e="😱">😱</button>
          <button class="rb" data-e="👏">👏</button>
          <button class="rb" data-e="🍿">🍿</button>
          <button class="rb" data-e="💀">💀</button>
          <button id="jumpscare-btn" title="prank your partner 😈">😈 SCARE</button>
        </div>
        <div id="gif-panel">
          <input id="gif-search" placeholder="search gifs… (press enter)" autocomplete="off" />
          <div id="gif-grid"><p id="gif-loading">type something above 🔍</p></div>
        </div>
        <div id="cin-row">
          <input id="cin" placeholder="say something bestie…" maxlength="300" />
          <button id="gif-btn">GIF</button>
          <button id="send-btn">→</button>
        </div>
      </div>
    </div>
  `;

  wireOverlay();
}

function wireOverlay() {
  // minimise
  let mini = false;
  const body = shadow.getElementById('body');
  shadow.getElementById('min-btn').onclick = () => {
    mini = !mini;
    body.style.display = mini ? 'none' : 'flex';
    shadow.getElementById('min-btn').textContent = mini ? '▴' : '▾';
  };

  // leave
  shadow.getElementById('x-btn').onclick = () => {
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
    roomId = null;
    hideOverlay();
  };

  // copy code
  shadow.getElementById('code').onclick = () => {
    if (!roomId) return;
    navigator.clipboard.writeText(roomId).then(() => {
      const el = shadow.getElementById('code');
      const orig = el.textContent;
      el.textContent = 'copied! 📋';
      setTimeout(() => { el.textContent = orig; }, 1400);
    });
  };

  // emoji reactions
  shadow.querySelectorAll('.rb').forEach(b => {
    b.onclick = () => wsSend({ type: 'reaction', emoji: b.dataset.e });
  });

  // jumpscare
  shadow.getElementById('jumpscare-btn').onclick = () => wsSend({ type: 'jumpscare' });

  // gif panel toggle
  const gifPanel = shadow.getElementById('gif-panel');
  shadow.getElementById('gif-btn').onclick = () => {
    gifPanel.classList.toggle('open');
    if (gifPanel.classList.contains('open')) shadow.getElementById('gif-search').focus();
  };

  // gif search
  let gifDebounce = null;
  shadow.getElementById('gif-search').addEventListener('input', (e) => {
    clearTimeout(gifDebounce);
    const q = e.target.value.trim();
    if (!q) return;
    gifDebounce = setTimeout(() => loadGifs(q), 500);
  });
  shadow.getElementById('gif-search').addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') loadGifs(e.target.value.trim());
  });
  ['keyup','keypress'].forEach(ev =>
    shadow.getElementById('gif-search').addEventListener(ev, e => e.stopPropagation())
  );

  // chat send
  const cin = shadow.getElementById('cin');
  shadow.getElementById('send-btn').onclick = doChat;
  cin.addEventListener('keydown', e => { if (e.key === 'Enter') doChat(); e.stopPropagation(); });
  ['keyup','keypress'].forEach(ev => cin.addEventListener(ev, e => e.stopPropagation()));
}

async function loadGifs(query) {
  const grid = shadow.getElementById('gif-grid');
  grid.innerHTML = '<p id="gif-loading">loading… 🔍</p>';
  try {
    const gifs = await searchGifs(query);
    grid.innerHTML = '';
    gifs.forEach(g => {
      const img = document.createElement('img');
      img.className = 'gif-thumb';
      img.src = g.preview;
      img.loading = 'lazy';
      img.onclick = () => {
        wsSend({ type: 'gif', url: g.full });
        shadow.getElementById('gif-panel').classList.remove('open');
        shadow.getElementById('gif-search').value = '';
        grid.innerHTML = '<p id="gif-loading">type something above 🔍</p>';
      };
      grid.appendChild(img);
    });
  } catch (_) {
    grid.innerHTML = '<p id="gif-loading">failed to load gifs 😭</p>';
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

function showOverlay()  { if (!shadow) buildOverlay(); shadow.host.style.display = 'block'; }
function hideOverlay()  { if (shadow) shadow.host.style.display = 'none'; }

function overlaySetRoom(id) {
  if (!shadow) return;
  shadow.getElementById('code').textContent = id;
}
function overlaySetMembers(m) {
  if (!shadow) return;
  shadow.getElementById('who').textContent = m.join(' & ') + ' 🎬';
}

function toast(msg) {
  if (!shadow) return;
  const el = shadow.getElementById('toast');
  el.textContent = msg;
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 3500);
}

function appendChat(who, text) {
  if (!shadow) return;
  append(false, who, text);
}

function appendGif(who, url) {
  if (!shadow) return;
  const log = shadow.getElementById('log');
  const el = document.createElement('div');
  el.className = 'm';
  el.innerHTML = `<span class="who">${esc(who)}</span>`;
  const img = document.createElement('img');
  img.className = 'gif-img';
  img.src = url;
  img.alt = 'gif';
  el.appendChild(img);
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
}

function appendSys(text) {
  if (!shadow) return;
  append(true, '•', text);
}

function append(sys, who, text) {
  const log = shadow.getElementById('log');
  const el = document.createElement('div');
  el.className = sys ? 'm sys' : 'm';
  el.innerHTML = `<span class="who">${esc(who)}</span><span class="txt">${esc(text)}</span>`;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
}

function popReaction(emoji) {
  if (!shadow) return;
  const layer = shadow.getElementById('rxnlayer');
  const el = document.createElement('div');
  el.className = 'rxn-bubble';
  el.textContent = emoji;
  el.style.right = (Math.random() * 70) + 'px';
  layer.appendChild(el);
  el.addEventListener('animationend', () => el.remove());
}

function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
