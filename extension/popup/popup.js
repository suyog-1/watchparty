const DEFAULT_SERVER = 'http://localhost:3000';

const screenConnect   = document.getElementById('screen-connect');
const screenConnected = document.getElementById('screen-connected');
const usernameInput   = document.getElementById('username');
const serverUrlInput  = document.getElementById('server-url');
const roomCodeInput   = document.getElementById('room-code');
const createBtn       = document.getElementById('create-btn');
const joinBtn         = document.getElementById('join-btn');
const errorMsg        = document.getElementById('error-msg');
const displayCode     = document.getElementById('display-code');
const displayMembers  = document.getElementById('display-members');
const leaveBtn        = document.getElementById('leave-btn');

// ── RESTORE SAVED PREFS ──
chrome.storage.sync.get(['username', 'serverUrl'], (data) => {
  if (data.username)  usernameInput.value  = data.username;
  if (data.serverUrl) serverUrlInput.value = data.serverUrl;
  else serverUrlInput.value = DEFAULT_SERVER;
});

// ── CHECK IF ALREADY CONNECTED ──
sendToContent({ type: 'status' }, (res) => {
  if (res?.connected && res?.roomId) showConnected(res.roomId);
});

// ── LISTEN FOR UPDATES FROM CONTENT SCRIPT ──
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'connected')  showConnected(msg.roomId);
  if (msg.type === 'ws-closed')  showConnect();
  if (msg.type === 'error')      showError(msg.message);
  if (msg.type === 'members')    displayMembers.textContent = msg.members.join(' & ');
});

// ── CREATE ──
createBtn.addEventListener('click', () => {
  const { username, serverUrl } = getInputs();
  if (!username)  return showError('enter your name');
  if (!serverUrl) return showError('enter the server URL');
  savePrefs(username, serverUrl);
  sendToContent({ type: 'connect', action: 'create', username, serverUrl });
});

// ── JOIN ──
joinBtn.addEventListener('click', doJoin);
roomCodeInput.addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); });

function doJoin() {
  const { username, serverUrl } = getInputs();
  const roomId = roomCodeInput.value.trim().toUpperCase();
  if (!username)  return showError('enter your name');
  if (!serverUrl) return showError('enter the server URL');
  if (!roomId)    return showError('enter a room code');
  savePrefs(username, serverUrl);
  sendToContent({ type: 'connect', action: 'join', username, serverUrl, roomId });
}

// ── LEAVE ──
leaveBtn.addEventListener('click', () => {
  sendToContent({ type: 'disconnect' });
  showConnect();
});

// ── COPY CODE ──
displayCode.addEventListener('click', () => {
  navigator.clipboard.writeText(displayCode.textContent).then(() => {
    const orig = displayCode.textContent;
    displayCode.textContent = 'copied!';
    setTimeout(() => { displayCode.textContent = orig; }, 1400);
  });
});

// ── HELPERS ──
function getInputs() {
  return {
    username:  usernameInput.value.trim(),
    serverUrl: serverUrlInput.value.trim().replace(/\/$/, ''),
  };
}

function savePrefs(username, serverUrl) {
  chrome.storage.sync.set({ username, serverUrl });
}

function showConnected(roomId) {
  screenConnect.classList.add('hidden');
  screenConnected.classList.remove('hidden');
  displayCode.textContent = roomId;
}

function showConnect() {
  screenConnected.classList.add('hidden');
  screenConnect.classList.remove('hidden');
}

function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.classList.remove('hidden');
  setTimeout(() => errorMsg.classList.add('hidden'), 3000);
}

function sendToContent(msg, cb) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]?.id) return;
    chrome.tabs.sendMessage(tabs[0].id, msg, (res) => {
      if (chrome.runtime.lastError) return; // content script not injected yet
      cb?.(res);
    });
  });
}
