// daddy's party 🎬 — content script
// Detects video, manages overlay UI, forwards everything via background service worker
// (background owns the WebSocket so YouTube's CSP can't block it)

const IS_TOP = window === window.top;
const TENOR_KEY = 'LIVDSRZULELA';

// Keep service worker alive while overlay is open
let keepalivePort = null;
function startKeepalive() {
  if (keepalivePort) return;
  keepalivePort = chrome.runtime.connect({ name: 'dp-keepalive' });
  keepalivePort.onDisconnect.addListener(() => { keepalivePort = null; });
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

function findVideo() {
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

function onPlay()   { if (!isSyncing && inRoom) emitVideoEvent('play',  videoEl.currentTime); }
function onPause()  { if (!isSyncing && inRoom) emitVideoEvent('pause', videoEl.currentTime); }
function onSeeked() { if (!isSyncing && inRoom) emitVideoEvent(videoEl.paused ? 'pause' : 'play', videoEl.currentTime); }

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
    chrome.runtime.sendMessage({ type: 'is-in-party' }, (res) => {
      if (chrome.runtime.lastError || !res?.inParty) return;
      inRoom = true;
      startKeepalive();
      showOverlay();
      overlaySetRoom(res.roomId);
      if (res.members) overlaySetMembers(res.members);
      appendSys('reconnected after switching pages ↪️');
      const v = findVideo(); if (v) attachVideo(v); else pollForVideo();
    });
  }, 100);
}

// ── WS HELPER (sends through background) ─────────────────────────────────────

function wsSend(payload) {
  chrome.runtime.sendMessage({ type: 'ws-send', payload }).catch(() => {});
}

// ── MESSAGE LISTENER ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // popup checking if there's a video on this page (lenient — just any <video>)
  if (msg.type === 'check-video') {
    sendResponse({ hasVideo: !!document.querySelector('video') });
    return true;
  }

  // playback from background (top frame) → apply to local video
  if (msg.type === 'apply-playback') {
    applyPlayback(msg.action, msg.currentTime);
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
      // we have an iframe with the video — currently not used in top frame, just acknowledged
      break;

    case 'apply-to-video-frame':
      // route through background
      chrome.runtime.sendMessage(msg).catch(() => {});
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
      overlaySetRoom(msg.roomId);
      appendSys("you're in! 🎉 share the code w bae");
      // host broadcasts current URL so future joiners get it
      wsSend({ type: 'url-change', url: location.href });
      attachVideoOrPoll();
      break;

    case 'joined':
      inRoom = true;
      overlaySetRoom(msg.roomId);
      // if room already has a URL, auto-navigate there
      if (msg.lastUrl && msg.lastUrl !== location.href) {
        appendSys(`taking you to where they're watching… 🎬`);
        setTimeout(() => { location.href = msg.lastUrl; }, 800);
        break;
      }
      // no URL yet — sit tight, host will broadcast on peer-joined
      // (do NOT broadcast our own URL — we're the follower, not the leader)
      appendSys("you're in! 🎉 waiting for them to share a page…");
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
      // re-broadcast our URL so the new person gets pulled into our page
      if (inRoom) setTimeout(() => wsSend({ type: 'url-change', url: location.href }), 200);
      break;
    case 'peer-left':   appendSys(`${msg.username} ${pick(LEAVE_MSGS)}`); break;
    case 'playback':
      applyPlayback(msg.action, msg.currentTime);
      appendSys(`${msg.from} ${msg.action === 'play' ? pick(PLAY_MSGS) : pick(PAUSE_MSGS)}`);
      break;
    case 'chat':       appendChat(msg.username, msg.text); break;
    case 'gif':        appendGif(msg.username, msg.url);  break;
    case 'reaction':   popReaction(msg.emoji); appendSys(`${msg.username} ${msg.emoji}`); break;
    case 'jumpscare':  doJumpscare(msg.username); break;
    case 'url-change':
      // auto-navigate to follow partner — content script will re-init on new page
      if (msg.url !== location.href) {
        appendSys(`${msg.username} switched videos — following… 🎬`);
        setTimeout(() => { location.href = msg.url; }, 800);
      }
      break;
  }
}

// ── JUMPSCARE ─────────────────────────────────────────────────────────────────

function doJumpscare(from) {
  const s = document.createElement('style');
  s.textContent = `@keyframes __dp_scare{0%{opacity:1}100%{opacity:0}}`;
  document.head.appendChild(s);
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:#ff0000;display:flex;align-items:center;justify-content:center;font-size:20vw;animation:__dp_scare .7s ease-out forwards;pointer-events:none;';
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

  shadow.getElementById('scare').onclick = () => wsSend({ type: 'jumpscare' });

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
