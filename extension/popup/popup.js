const DEFAULT_SERVER = 'https://watchparty-ayjl.onrender.com';

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

let connectTimeout = null;

// restore saved prefs
chrome.storage.sync.get(['username', 'serverUrl'], (data) => {
  if (data.username)  usernameInput.value  = data.username;
  serverUrlInput.value = data.serverUrl || DEFAULT_SERVER;
});

// check if already connected in this tab
sendToContent({ type: 'status' }, (res) => {
  if (res?.connected && res?.roomId) showConnected(res.roomId);
});

// listen for updates from content script
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'connected')  { clearTimeout(connectTimeout); showConnected(msg.roomId); }
  if (msg.type === 'ws-closed')  { resetBtn(); showConnect(); }
  if (msg.type === 'error')      { resetBtn(); showError(msg.message); }
  if (msg.type === 'members')    { displayMembers.textContent = msg.members.join(' & '); }
});

// create
createBtn.addEventListener('click', () => {
  const { username, serverUrl } = getInputs();
  if (!username)  return showError('enter your name first');
  if (!serverUrl) return showError('enter the server url');
  savePrefs(username, serverUrl);
  setConnecting(createBtn, '🔄 connecting...');
  sendToContent({ type: 'connect', action: 'create', username, serverUrl });
  armTimeout();
});

// join
joinBtn.addEventListener('click', doJoin);
roomCodeInput.addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); });

function doJoin() {
  const { username, serverUrl } = getInputs();
  const roomId = roomCodeInput.value.trim().toUpperCase();
  if (!username)  return showError('enter your name first');
  if (!serverUrl) return showError('enter the server url');
  if (!roomId)    return showError('enter a room code');
  savePrefs(username, serverUrl);
  setConnecting(joinBtn, '🔄 joining...');
  sendToContent({ type: 'connect', action: 'join', username, serverUrl, roomId });
  armTimeout();
}

// leave
leaveBtn.addEventListener('click', () => {
  sendToContent({ type: 'disconnect' });
  showConnect();
});

// copy code
displayCode.addEventListener('click', () => {
  navigator.clipboard.writeText(displayCode.textContent).then(() => {
    const orig = displayCode.textContent;
    displayCode.textContent = 'copied!';
    setTimeout(() => { displayCode.textContent = orig; }, 1400);
  });
});

// ── helpers ──

function getInputs() {
  return {
    username:  usernameInput.value.trim(),
    serverUrl: serverUrlInput.value.trim().replace(/\/$/, ''),
  };
}

function savePrefs(username, serverUrl) {
  chrome.storage.sync.set({ username, serverUrl });
}

function setConnecting(btn, label) {
  btn.textContent = label;
  btn.disabled = true;
}

function resetBtn() {
  createBtn.textContent = '🎬 start the party';
  createBtn.disabled = false;
  joinBtn.textContent = 'join 🍿';
  joinBtn.disabled = false;
}

function armTimeout() {
  clearTimeout(connectTimeout);
  connectTimeout = setTimeout(() => {
    resetBtn();
    showError("server's waking up — try again in 10s 😴");
  }, 12000);
}

function showConnected(roomId) {
  clearTimeout(connectTimeout);
  screenConnect.classList.add('hidden');
  screenConnected.classList.remove('hidden');
  displayCode.textContent = roomId;
}

function showConnect() {
  resetBtn();
  screenConnected.classList.add('hidden');
  screenConnect.classList.remove('hidden');
}

function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.classList.remove('hidden');
  setTimeout(() => errorMsg.classList.add('hidden'), 4000);
}

function sendToContent(msg, cb) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]?.id) { cb?.(null); return; }
    chrome.tabs.sendMessage(tabs[0].id, msg, (res) => {
      if (chrome.runtime.lastError) { cb?.(null); return; }
      cb?.(res);
    });
  });
}
