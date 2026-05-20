const SERVER_URL = 'https://watchparty-ayjl.onrender.com';

const screenConnect   = document.getElementById('screen-connect');
const screenOtherTab  = document.getElementById('screen-other-tab');
const screenConnected = document.getElementById('screen-connected');

const usernameInput  = document.getElementById('username');
const roomCodeInput  = document.getElementById('room-code');
const createBtn      = document.getElementById('create-btn');
const joinBtn        = document.getElementById('join-btn');
const errorMsg       = document.getElementById('error-msg');

const gotoTabBtn     = document.getElementById('goto-tab-btn');
const leaveOtherBtn  = document.getElementById('leave-other-btn');

const displayCode    = document.getElementById('display-code');
const displayMembers = document.getElementById('display-members');
const leaveBtn       = document.getElementById('leave-btn');

let otherTabId = null;

// ── INIT ──────────────────────────────────────────────────────────────────────

chrome.storage.sync.get(['username'], d => {
  if (d.username) usernameInput.value = d.username;
});

chrome.runtime.sendMessage({ type: 'get-state' }, (state) => {
  if (!state) return;

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const thisTabId = tabs[0]?.id;

    if (state.connecting) {
      if (state.tabId === thisTabId) {
        createBtn.textContent = '🔄 connecting...';
        createBtn.disabled = true;
        joinBtn.disabled = true;
      } else {
        otherTabId = state.tabId;
        show(screenOtherTab);
      }
      return;
    }

    if (state.connected) {
      if (state.tabId === thisTabId) {
        showConnected(state.roomId);
      } else {
        otherTabId = state.tabId;
        show(screenOtherTab);
      }
    }
  });
});

// ── LISTENERS ─────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'connected')  showConnected(msg.roomId);
  if (msg.type === 'ws-closed')  { resetBtns(); show(screenConnect); }
  if (msg.type === 'ws-error')   { resetBtns(); showError(msg.message); }
  if (msg.type === 'members')    displayMembers.textContent = msg.members.join(' & ');
});

// ── ACTIONS ───────────────────────────────────────────────────────────────────

createBtn.addEventListener('click', () => {
  const username = usernameInput.value.trim();
  if (!username) return showError('enter your name first');
  chrome.storage.sync.set({ username });
  setBusy(createBtn, '🔄 connecting...');
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    chrome.runtime.sendMessage({
      type: 'connect', action: 'create', username,
      serverUrl: SERVER_URL, tabId: tabs[0]?.id,
    });
  });
});

joinBtn.addEventListener('click', doJoin);
roomCodeInput.addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); });

function doJoin() {
  const username = usernameInput.value.trim();
  const roomId   = roomCodeInput.value.trim().toUpperCase();
  if (!username) return showError('enter your name first');
  if (!roomId)   return showError('enter the room code');
  chrome.storage.sync.set({ username });
  setBusy(joinBtn, '🔄 joining...');
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    chrome.runtime.sendMessage({
      type: 'connect', action: 'join', username, roomId,
      serverUrl: SERVER_URL, tabId: tabs[0]?.id,
    });
  });
}

gotoTabBtn.addEventListener('click', () => {
  if (otherTabId) chrome.runtime.sendMessage({ type: 'focus-tab', tabId: otherTabId });
  window.close();
});

leaveOtherBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'disconnect' });
  otherTabId = null;
  show(screenConnect);
});

leaveBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'disconnect' });
  resetBtns();
  show(screenConnect);
});

displayCode.addEventListener('click', () => {
  navigator.clipboard.writeText(displayCode.textContent).then(() => {
    const orig = displayCode.textContent;
    displayCode.textContent = 'copied!';
    setTimeout(() => { displayCode.textContent = orig; }, 1400);
  });
});

// ── HELPERS ───────────────────────────────────────────────────────────────────

function show(el) {
  [screenConnect, screenOtherTab, screenConnected].forEach(s => s.classList.add('hidden'));
  el.classList.remove('hidden');
}

function showConnected(roomId) {
  displayCode.textContent = roomId;
  show(screenConnected);
}

function setBusy(btn, label) {
  btn.textContent = label;
  btn.disabled = true;
}

function resetBtns() {
  createBtn.textContent = '🎬 start the party';
  createBtn.disabled = false;
  joinBtn.textContent = 'join 🍿';
  joinBtn.disabled = false;
}

function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.classList.remove('hidden');
  setTimeout(() => errorMsg.classList.add('hidden'), 4000);
}
