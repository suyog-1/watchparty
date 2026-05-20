const SERVER_URL = 'https://watchparty-ayjl.onrender.com';

// Pre-warm Render the moment popup opens — server starts waking up
// while user types their name, so connection is instant when they click "create"
fetch(SERVER_URL + '/', { method: 'GET', mode: 'no-cors' }).catch(() => {});

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

createBtn.addEventListener('click', async () => {
  const username = usernameInput.value.trim();
  if (!username) return showError('enter your name first');

  const tab = await getActiveTab();
  if (!tab) return showError("can't read the active tab 💀");

  // make sure the latest content script is running on this tab
  const result = await ensureContentScript(tab.id);
  if (!result.ok) {
    if (result.reason?.includes('Cannot access') || result.reason?.includes('chrome:')) {
      return showError('open any normal website first — chrome:// pages are blocked');
    }
    if (result.reason?.includes('blocking')) {
      return showError('site is blocking extension. lower Brave shields/adblocker for this site 🛡️');
    }
    return showError('refresh tab (F5) — if still nothing, check Brave shields 🛡️');
  }

  chrome.storage.sync.set({ username });
  setBusy(createBtn, '🔄 connecting...');
  chrome.runtime.sendMessage({
    type: 'connect', action: 'create', username,
    serverUrl: SERVER_URL, tabId: tab.id,
  });
});

joinBtn.addEventListener('click', doJoin);
roomCodeInput.addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); });

async function doJoin() {
  const username = usernameInput.value.trim();
  const roomId   = roomCodeInput.value.trim().toUpperCase();
  if (!username) return showError('enter your name first');
  if (!roomId)   return showError('enter the room code');

  const tab = await getActiveTab();
  if (!tab) return showError("can't read the active tab 💀");

  const result = await ensureContentScript(tab.id);
  if (!result.ok) {
    if (result.reason?.includes('Cannot access') || result.reason?.includes('chrome:')) {
      return showError('open any normal website first — chrome:// pages are blocked');
    }
    if (result.reason?.includes('blocking')) {
      return showError('site is blocking extension. lower Brave shields/adblocker for this site 🛡️');
    }
    return showError('refresh tab (F5) — if still nothing, check Brave shields 🛡️');
  }

  chrome.storage.sync.set({ username });
  setBusy(joinBtn, '🔄 joining...');
  chrome.runtime.sendMessage({
    type: 'connect', action: 'join', username, roomId,
    serverUrl: SERVER_URL, tabId: tab.id,
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
  resetBtns();
  errorMsg.textContent = msg;
  errorMsg.classList.remove('hidden');
  setTimeout(() => errorMsg.classList.add('hidden'), 4000);
}

function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs[0] || null));
  });
}

function checkTabHasVideo(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'check-video' }, (res) => {
      if (chrome.runtime.lastError) return resolve(false);
      resolve(res?.hasVideo === true);
    });
  });
}

function pingContentScript(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'ping' }, (res) => {
      if (chrome.runtime.lastError) return resolve(false);
      resolve(res?.pong === true);
    });
  });
}

async function ensureContentScript(tabId) {
  // first try a ping — if the latest content script is loaded, we're done
  if (await pingContentScript(tabId)) return { ok: true };

  // not loaded (or old version w/o ping handler) — try to inject fresh
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
    // wait longer for listeners to register (some browsers slower)
    await new Promise(r => setTimeout(r, 500));
    if (await pingContentScript(tabId)) return { ok: true };
    return { ok: false, reason: 'injected but no response — site may be blocking extensions' };
  } catch (e) {
    console.error('[daddys party] inject failed:', e);
    return { ok: false, reason: e?.message || 'unknown error' };
  }
}
