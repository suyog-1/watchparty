// daddy's party 🎬 — content script
// ALL FRAMES: video detection + playback control
// MAIN FRAME only: WebSocket + overlay UI

const IS_TOP = window === window.top;
const TENOR_KEY = 'LIVDSRZULELA';

// ── FUNNY MESSAGES ────────────────────────────────────────────────────────────

const PLAY_MSGS  = ['pressed play 🎬', 'came back 👀', 'ready bestie 🍿', "it's giving cinema 💅", 'back on the grind 🫡'];
const PAUSE_MSGS = ['said hold on 💀', 'paused it 🛑', 'went to pee prob 💀', 'touching grass rq 🌿', 'said wait wait ✋'];
const JOIN_MSGS  = ['finally showed up 💅', 'entered the cinema 🎬', 'is here 🫶', 'arrived 👑'];
const LEAVE_MSGS = ['ghosted 💀', 'said peace ✌️', 'left the building 🚪', 'logged off 😭'];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// ── VIDEO DETECTION (all frames) ─────────────────────────────────────────────

let videoEl      = null;
let isSyncing    = false;
let videoMutObs  = null;

function findVideo() {
  // readyState check removed — YouTube starts at 0
  return [...document.querySelectorAll('video')]
    .filter(v => v.offsetWidth > 0 && v.offsetHeight > 0)
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

const _v0 = findVideo();
if (_v0) attachVideo(_v0); else pollForVideo();

// ── MESSAGE LISTENER (all frames) ────────────────────────────────────────────

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

let ws              = null;
let roomId          = null;
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

  // show overlay immediately so user knows something is happening
  showOverlay();
  appendSys('connecting… give it a sec 🔄');

  const wsUrl = serverUrl.replace(/^https/, 'wss').replace(/^http/, 'ws');
  ws = new WebSocket(wsUrl);

  ws.onopen = () => wsSend(
    action === 'create'
      ? { type: 'create', username: uname }
      : { type: 'join',   username: uname, roomId: rid }
  );

  ws.onmessage = (e) => { try { handleServerMsg(JSON.parse(e.data)); } catch (_) {} };

  ws.onclose = () => {
    roomId = null;
    appendSys('disconnected 😭 reload n rejoin');
    chrome.runtime.sendMessage({ type: 'ws-closed' }).catch(() => {});
  };

  ws.onerror = () => {
    appendSys('connection failed 💀 check server url in popup');
    chrome.runtime.sendMessage({ type: 'error', message: 'connection failed 💀' }).catch(() => {});
  };
}

function wsSend(obj) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function handleServerMsg(msg) {
  switch (msg.type) {
    case 'created':
    case 'joined':
      roomId = msg.roomId;
      overlaySetRoom(msg.roomId);
      chrome.runtime.sendMessage({ type: 'connected', roomId: msg.roomId }).catch(() => {});
      appendSys("you're in! 🎉 open a movie n press play");
      const v = findVideo(); if (v) attachVideo(v); else pollForVideo();
      break;
    case 'error':
      appendSys(msg.message + ' 💀');
      chrome.runtime.sendMessage({ type: 'error', message: msg.message }).catch(() => {});
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
    case 'reaction':  popReaction(msg.emoji); appendSys(`${msg.username} ${msg.emoji}`); break;
    case 'jumpscare': doJumpscare(msg.username); break;
  }
}

// ── JUMPSCARE ─────────────────────────────────────────────────────────────────

function doJumpscare(from) {
  const s = document.createElement('style');
  s.textContent = `@keyframes __wp_scare{0%{opacity:1}100%{opacity:0}}`;
  document.head.appendChild(s);
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:#ff0000;display:flex;align-items:center;justify-content:center;font-size:20vw;animation:__wp_scare .7s ease-out forwards;pointer-events:none;';
  el.textContent = '😱';
  document.body.appendChild(el);
  el.addEventListener('animationend', () => { el.remove(); s.remove(); });
  appendSys(`${from} just jumpscared you 😱💀`);
}

// ── TENOR GIF SEARCH ──────────────────────────────────────────────────────────

async function searchGifs(query) {
  const res = await fetch(`https://api.tenor.com/v1/search?q=${encodeURIComponent(query)}&key=${TENOR_KEY}&limit=12&media_filter=minimal&contentfilter=medium`);
  const data = await res.json();
  return data.results.map(r => ({
    preview: r.media[0].tinygif?.url || r.media[0].gif.url,
    full:    r.media[0].gif.url,
  }));
}

// ── OVERLAY UI ────────────────────────────────────────────────────────────────

let shadow = null;

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

  /* topbar */
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

  /* collapsible body */
  #body{
    display:flex;flex-direction:column;
    overflow:hidden;
    max-height:400px;
    transition:max-height .25s cubic-bezier(.4,0,.2,1);
  }
  #body.mini{max-height:0}

  /* chat log */
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

  /* reactions */
  #rxns{
    display:flex;align-items:center;gap:4px;
    padding:7px 12px;border-top:1px solid #ffffff08;flex-shrink:0;
  }
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

  /* gif panel */
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

  /* chat input */
  #cin-row{
    display:flex;gap:6px;padding:8px 10px;
    border-top:1px solid #ffffff08;align-items:center;flex-shrink:0;
  }
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

  /* floaty reactions */
  #rxnlayer{position:fixed;bottom:90px;right:24px;pointer-events:none;z-index:2147483647}
  .rb2{position:absolute;font-size:2rem;bottom:0;animation:fup 2.4s ease-out forwards}
  @keyframes fup{0%{opacity:1;transform:translateY(0) scale(.7)}100%{opacity:0;transform:translateY(-170px) scale(1.3)}}
`;

function buildOverlay() {
  const host = document.createElement('div');
  host.id = '__daddysparty__';
  host.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:2147483647;';
  document.documentElement.appendChild(host);
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
        <button class="ib" id="xbtn">✕</button>
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
}

function wireOverlay() {
  // minimize — uses CSS max-height transition, no layout glitch
  const body = shadow.getElementById('body');
  shadow.getElementById('minbtn').onclick = () => {
    const mini = body.classList.toggle('mini');
    shadow.getElementById('minbtn').textContent = mini ? '▴' : '▾';
  };

  // leave
  shadow.getElementById('xbtn').onclick = () => {
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
    roomId = null;
    hideOverlay();
  };

  // copy code
  shadow.getElementById('code-chip').onclick = () => {
    if (!roomId) return;
    navigator.clipboard.writeText(roomId).then(() => {
      const el = shadow.getElementById('code-chip');
      el.textContent = 'copied 📋';
      setTimeout(() => { el.textContent = roomId; }, 1400);
    });
  };

  // emoji reactions
  shadow.querySelectorAll('.rb').forEach(b => {
    b.onclick = () => wsSend({ type: 'reaction', emoji: b.dataset.e });
  });

  // jumpscare
  shadow.getElementById('scare').onclick = () => wsSend({ type: 'jumpscare' });

  // gif panel
  const gifPanel = shadow.getElementById('gifpanel');
  shadow.getElementById('gbtn').onclick = () => {
    gifPanel.classList.toggle('open');
    if (gifPanel.classList.contains('open')) shadow.getElementById('gifsearch').focus();
  };

  let gifTimer = null;
  shadow.getElementById('gifsearch').addEventListener('input', e => {
    clearTimeout(gifTimer);
    const q = e.target.value.trim();
    if (q) gifTimer = setTimeout(() => loadGifs(q), 500);
  });
  stopProp(shadow.getElementById('gifsearch'));

  // chat
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

function showOverlay()  { if (!shadow) buildOverlay(); shadow.host.style.display = 'block'; }
function hideOverlay()  { if (shadow) shadow.host.style.display = 'none'; }

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

function append(sys, who, text) {
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
