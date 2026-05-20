// ── WEBSOCKET ──
const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(`${protocol}//${location.host}`);

function send(obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

ws.onmessage = (e) => handleMessage(JSON.parse(e.data));

// ── STATE ──
let username = '';
let roomId = '';
let ytPlayer = null;
let ytReady = false;
let mode = null; // 'yt' | 'local'
let isSyncing = false;
let seekBarDragging = false;

// ── ELEMENTS ──
const lobby         = document.getElementById('lobby');
const room          = document.getElementById('room');
const usernameInput = document.getElementById('username-input');
const createBtn     = document.getElementById('create-btn');
const joinBtn       = document.getElementById('join-btn');
const roomCodeInput = document.getElementById('room-code-input');
const lobbyError    = document.getElementById('lobby-error');

const roomCodeDisplay = document.getElementById('room-code-display');
const membersDisplay  = document.getElementById('members-display');
const changeVideoBtn  = document.getElementById('change-video-btn');

const sourcePicker  = document.getElementById('source-picker');
const ytUrlInput    = document.getElementById('yt-url-input');
const ytLoadBtn     = document.getElementById('yt-load-btn');
const ytError       = document.getElementById('yt-error');
const localFileBtn  = document.getElementById('local-file-btn');
const fileInput     = document.getElementById('file-input');

const ytWrapper     = document.getElementById('yt-wrapper');
const ytClickShield = document.getElementById('yt-click-shield');
const localWrapper  = document.getElementById('local-wrapper');
const localPlayer   = document.getElementById('local-player');

const controls     = document.getElementById('controls');
const reactionsBar = document.getElementById('reactions-bar');
const playPauseBtn = document.getElementById('play-pause-btn');
const seekBar      = document.getElementById('seek-bar');
const volumeBar    = document.getElementById('volume-bar');
const timeCurrent  = document.getElementById('time-current');
const timeTotal    = document.getElementById('time-total');

const chatMessages = document.getElementById('chat-messages');
const chatInput    = document.getElementById('chat-input');
const chatSendBtn  = document.getElementById('chat-send-btn');
const gifBtn       = document.getElementById('gif-btn');
const gifPanel     = document.getElementById('gif-panel');
const gifSearch    = document.getElementById('gif-search');
const gifGrid      = document.getElementById('gif-grid');
const scareBtn     = document.getElementById('scare-btn');

const TENOR_KEY = 'LIVDSRZULELA';

// ── YOUTUBE API ──
window.onYouTubeIframeAPIReady = () => { ytReady = true; };

function createYTPlayer(videoId) {
  if (ytPlayer) { ytPlayer.destroy(); ytPlayer = null; }
  ytPlayer = new YT.Player('yt-player', {
    videoId,
    playerVars: { autoplay: 0, controls: 0, modestbranding: 1, rel: 0, iv_load_policy: 3 },
    events: {
      onReady: () => { showControls(); startYTLoop(); },
      onStateChange: (e) => {
        if (isSyncing) return;
        if (e.data === YT.PlayerState.PLAYING) {
          playPauseBtn.innerHTML = '&#9646;&#9646;';
          send({ type: 'playback', action: 'play', currentTime: ytPlayer.getCurrentTime() });
        } else if (e.data === YT.PlayerState.PAUSED) {
          playPauseBtn.innerHTML = '&#9654;';
          send({ type: 'playback', action: 'pause', currentTime: ytPlayer.getCurrentTime() });
        }
      },
    },
  });
}

let ytLoop = null;
function startYTLoop() {
  clearInterval(ytLoop);
  ytLoop = setInterval(() => {
    if (!ytPlayer || seekBarDragging) return;
    try {
      const cur = ytPlayer.getCurrentTime() || 0;
      const dur = ytPlayer.getDuration() || 0;
      if (dur > 0) {
        seekBar.max = dur;
        seekBar.value = cur;
        timeCurrent.textContent = fmt(cur);
        timeTotal.textContent = fmt(dur);
      }
    } catch (_) {}
  }, 500);
}

function extractYTId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtu.be')) return u.pathname.slice(1).split('?')[0];
    return u.searchParams.get('v');
  } catch { return null; }
}

// ── LOBBY ──
createBtn.addEventListener('click', () => {
  const name = usernameInput.value.trim();
  if (!name) return showErr('enter your name first');
  username = name;
  send({ type: 'create', username });
});

joinBtn.addEventListener('click', doJoin);
roomCodeInput.addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); });
usernameInput.addEventListener('keydown', e => { if (e.key === 'Enter') createBtn.click(); });

function doJoin() {
  const name = usernameInput.value.trim();
  const code = roomCodeInput.value.trim().toUpperCase();
  if (!name) return showErr('enter your name first');
  if (!code) return showErr('enter a room code');
  username = name;
  send({ type: 'join', roomId: code, username });
}

function showErr(msg) {
  lobbyError.textContent = msg;
  lobbyError.classList.remove('hidden');
  setTimeout(() => lobbyError.classList.add('hidden'), 3000);
}

function enterRoom(id) {
  roomId = id;
  lobby.classList.add('hidden');
  room.classList.remove('hidden');
  roomCodeDisplay.textContent = id;
}

roomCodeDisplay.addEventListener('click', () => {
  navigator.clipboard.writeText(roomId).then(() => {
    roomCodeDisplay.textContent = 'copied!';
    setTimeout(() => roomCodeDisplay.textContent = roomId, 1500);
  });
});

// ── SERVER MESSAGES ──
function handleMessage(msg) {
  switch (msg.type) {
    case 'created': enterRoom(msg.roomId); break;
    case 'joined':
      enterRoom(msg.roomId);
      if (msg.video) applyVideo(msg.video);
      break;
    case 'error': showErr(msg.message); break;
    case 'members':
      membersDisplay.textContent = msg.members.join(' & ');
      break;
    case 'peer-joined': addSys(`${msg.username} joined ❤️`); break;
    case 'peer-left':   addSys(`${msg.username} left`); break;
    case 'set-video':   applyVideo(msg.video); break;
    case 'playback':    applyPlayback(msg); break;
    case 'chat':
      addChatMsg(msg.username, msg.text);
      break;
    case 'reaction':
      spawnReaction(msg.emoji);
      addSys(`${msg.username} ${msg.emoji}`);
      break;
    case 'gif':
      addGifMsg(msg.username, msg.url);
      break;
    case 'jumpscare':
      doJumpscare(msg.username);
      break;
  }
}

// ── GIF SEARCH ──
gifBtn.addEventListener('click', () => {
  gifPanel.classList.toggle('hidden');
  if (!gifPanel.classList.contains('hidden')) gifSearch.focus();
});

let gifTimer = null;
gifSearch.addEventListener('input', () => {
  clearTimeout(gifTimer);
  const q = gifSearch.value.trim();
  if (q) gifTimer = setTimeout(() => loadGifs(q), 500);
});

async function loadGifs(query) {
  gifGrid.innerHTML = '<p class="gif-hint">loading... 🔍</p>';
  try {
    const res = await fetch(`https://api.tenor.com/v1/search?q=${encodeURIComponent(query)}&key=${TENOR_KEY}&limit=12&media_filter=minimal&contentfilter=medium`);
    const data = await res.json();
    gifGrid.innerHTML = '';
    data.results.forEach(r => {
      const img = document.createElement('img');
      img.className = 'gif-thumb';
      img.src = r.media[0].tinygif?.url || r.media[0].gif.url;
      img.loading = 'lazy';
      img.onclick = () => {
        send({ type: 'gif', url: r.media[0].gif.url });
        gifPanel.classList.add('hidden');
        gifSearch.value = '';
        gifGrid.innerHTML = '<p class="gif-hint">type above to search 🔍</p>';
      };
      gifGrid.appendChild(img);
    });
  } catch (_) {
    gifGrid.innerHTML = '<p class="gif-hint">failed 😭</p>';
  }
}

function addGifMsg(sender, url) {
  const el = document.createElement('div');
  el.className = 'chat-msg';
  el.innerHTML = `<span class="sender">${esc(sender)}</span>`;
  const img = document.createElement('img');
  img.className = 'chat-gif';
  img.src = url;
  el.appendChild(img);
  chatMessages.appendChild(el);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ── JUMPSCARE ──
scareBtn.addEventListener('click', () => send({ type: 'jumpscare' }));

// ── CHAT TOGGLE ──
const toggleChatBtn = document.getElementById('toggle-chat-btn');
const chatPanel = document.querySelector('.chat-panel');
toggleChatBtn.addEventListener('click', () => {
  chatPanel.classList.toggle('hidden');
});

function doJumpscare(from) {
  const el = document.createElement('div');
  el.className = 'scare-overlay';
  el.textContent = '😱';
  document.body.appendChild(el);
  el.addEventListener('animationend', () => el.remove());
  addSys(`${from} just jumpscared you 😱💀`);
}

// ── VIDEO SOURCE ──
ytLoadBtn.addEventListener('click', loadYT);
ytUrlInput.addEventListener('keydown', e => { if (e.key === 'Enter') loadYT(); });

function loadYT() {
  const id = extractYTId(ytUrlInput.value.trim());
  if (!id) { ytError.textContent = 'paste a valid YouTube link'; ytError.classList.remove('hidden'); return; }
  ytError.classList.add('hidden');
  const video = { videoType: 'yt', videoId: id };
  send({ type: 'set-video', ...video });
  applyVideo(video);
}

localFileBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { if (fileInput.files[0]) loadLocalFile(fileInput.files[0]); });

function applyVideo(video) {
  sourcePicker.classList.add('hidden');
  if (video.videoType === 'yt') {
    mode = 'yt';
    ytWrapper.classList.remove('hidden');
    localWrapper.classList.add('hidden');
    const init = () => createYTPlayer(video.videoId);
    ytReady ? init() : waitFor(() => ytReady, init);
  }
}

function loadLocalFile(file) {
  mode = 'local';
  sourcePicker.classList.add('hidden');
  ytWrapper.classList.add('hidden');
  localWrapper.classList.remove('hidden');
  localPlayer.src = URL.createObjectURL(file);
  localPlayer.load();
  showControls();
}

function showControls() {
  controls.classList.remove('hidden');
  reactionsBar.classList.remove('hidden');
}

changeVideoBtn.addEventListener('click', () => {
  mode = null;
  ytWrapper.classList.add('hidden');
  localWrapper.classList.add('hidden');
  controls.classList.add('hidden');
  reactionsBar.classList.add('hidden');
  sourcePicker.classList.remove('hidden');
  ytUrlInput.value = '';
  clearInterval(ytLoop);
  if (ytPlayer) { ytPlayer.destroy(); ytPlayer = null; }
  localPlayer.src = '';
});

// ── PLAYBACK CONTROLS ──
ytClickShield.addEventListener('click', () => {
  if (!ytPlayer) return;
  ytPlayer.getPlayerState() === YT.PlayerState.PLAYING ? ytPlayer.pauseVideo() : ytPlayer.playVideo();
});

playPauseBtn.addEventListener('click', () => {
  if (mode === 'yt' && ytPlayer) {
    ytPlayer.getPlayerState() === YT.PlayerState.PLAYING ? ytPlayer.pauseVideo() : ytPlayer.playVideo();
  } else if (mode === 'local') {
    localPlayer.paused ? localPlayer.play() : localPlayer.pause();
  }
});

localPlayer.addEventListener('play',  () => { if (!isSyncing) { playPauseBtn.innerHTML = '&#9646;&#9646;'; send({ type: 'playback', action: 'play',  currentTime: localPlayer.currentTime }); } });
localPlayer.addEventListener('pause', () => { if (!isSyncing) { playPauseBtn.innerHTML = '&#9654;';       send({ type: 'playback', action: 'pause', currentTime: localPlayer.currentTime }); } });
localPlayer.addEventListener('timeupdate', () => {
  if (seekBarDragging) return;
  seekBar.value = localPlayer.currentTime;
  timeCurrent.textContent = fmt(localPlayer.currentTime);
});
localPlayer.addEventListener('loadedmetadata', () => {
  seekBar.max = localPlayer.duration;
  timeTotal.textContent = fmt(localPlayer.duration);
  showControls();
});

seekBar.addEventListener('mousedown',  () => { seekBarDragging = true; });
seekBar.addEventListener('touchstart', () => { seekBarDragging = true; });
seekBar.addEventListener('input', () => {
  const t = parseFloat(seekBar.value);
  timeCurrent.textContent = fmt(t);
  if (mode === 'local') localPlayer.currentTime = t;
});
seekBar.addEventListener('change', () => {
  seekBarDragging = false;
  const t = parseFloat(seekBar.value);
  const playing = mode === 'yt' ? (ytPlayer?.getPlayerState() === YT.PlayerState.PLAYING) : !localPlayer.paused;
  if (mode === 'yt' && ytPlayer) ytPlayer.seekTo(t, true);
  send({ type: 'playback', action: playing ? 'play' : 'pause', currentTime: t });
});

volumeBar.addEventListener('input', () => {
  const v = parseInt(volumeBar.value);
  if (mode === 'yt' && ytPlayer) ytPlayer.setVolume(v);
  else if (mode === 'local') localPlayer.volume = v / 100;
});

function applyPlayback({ action, currentTime, from }) {
  isSyncing = true;
  if (mode === 'yt' && ytPlayer) {
    try {
      if (Math.abs((ytPlayer.getCurrentTime() || 0) - currentTime) > 1.5) ytPlayer.seekTo(currentTime, true);
      action === 'play' ? ytPlayer.playVideo() : ytPlayer.pauseVideo();
    } catch (_) {}
  } else if (mode === 'local') {
    if (Math.abs(localPlayer.currentTime - currentTime) > 1.5) localPlayer.currentTime = currentTime;
    action === 'play' ? localPlayer.play().catch(() => {}) : localPlayer.pause();
  }
  playPauseBtn.innerHTML = action === 'play' ? '&#9646;&#9646;' : '&#9654;';
  setTimeout(() => { isSyncing = false; }, 400);
  addSys(`${from} ${action === 'play' ? '▶ played' : '⏸ paused'}`);
}

function fmt(s) {
  if (!isFinite(s) || s < 0) return '0:00';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60).toString().padStart(2, '0');
  return h > 0 ? `${h}:${m.toString().padStart(2,'0')}:${sec}` : `${m}:${sec}`;
}

// ── CHAT ──
chatSendBtn.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

function sendChat() {
  const text = chatInput.value.trim();
  if (!text) return;
  send({ type: 'chat', text });
  chatInput.value = '';
}

function addChatMsg(sender, text) {
  const el = document.createElement('div');
  el.className = 'chat-msg';
  el.innerHTML = `<span class="sender">${esc(sender)}</span><span class="body">${esc(text)}</span>`;
  chatMessages.appendChild(el);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function addSys(text) {
  const el = document.createElement('div');
  el.className = 'chat-msg system';
  el.innerHTML = `<span class="sender">•</span><span class="body">${esc(text)}</span>`;
  chatMessages.appendChild(el);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ── REACTIONS ──
document.querySelectorAll('.react-btn').forEach(btn => {
  btn.addEventListener('click', () => send({ type: 'reaction', emoji: btn.dataset.emoji }));
});

function spawnReaction(emoji) {
  ['reaction-overlay','reaction-overlay-local'].forEach(id => {
    const overlay = document.getElementById(id);
    if (!overlay || overlay.closest('.hidden')) return;
    const el = document.createElement('div');
    el.className = 'reaction-bubble';
    el.textContent = emoji;
    el.style.left = (10 + Math.random() * 75) + '%';
    overlay.appendChild(el);
    el.addEventListener('animationend', () => el.remove());
  });
}

// ── UTILS ──
function waitFor(cond, fn) {
  const t = setInterval(() => { if (cond()) { clearInterval(t); fn(); } }, 100);
}
