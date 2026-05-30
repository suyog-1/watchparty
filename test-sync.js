// Integration test for the watchparty WebSocket protocol.
// Spins up the server, opens fake clients, verifies sync flow end-to-end.
// Run with: node test-sync.js [server-url]
//   default server: ws://localhost:3000
//   to test deployed: node test-sync.js wss://watchparty-ayjl.onrender.com

const WebSocket = require('ws');

const SERVER = process.argv[2] || 'ws://localhost:3000';
const VERSION = '2.1.7';

let passed = 0, failed = 0;
const results = [];

function pass(name) { passed++; results.push(`  ✓ ${name}`); console.log(`  ✓ ${name}`); }
function fail(name, err) { failed++; results.push(`  ✗ ${name} — ${err}`); console.log(`  ✗ ${name} — ${err}`); }

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(SERVER);
    const timer = setTimeout(() => reject(new Error('connect timeout')), 30000);
    // Buffer ALL messages from the moment the socket opens, so waitFor can
    // retroactively consume messages that arrived before it started listening.
    ws._queue = [];
    ws._consumers = [];
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      // try consumers first, in registration order
      for (let i = 0; i < ws._consumers.length; i++) {
        if (ws._consumers[i](msg)) {
          ws._consumers.splice(i, 1);
          return;
        }
      }
      // no consumer wanted it — queue it for later waitFor calls
      ws._queue.push(msg);
    });
    ws.on('open', () => { clearTimeout(timer); resolve(ws); });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

function waitFor(ws, predicate, timeoutMs = 5000, label = 'message') {
  // first check the queue for a match — handles the race where the message
  // arrived between operations
  for (let i = 0; i < ws._queue.length; i++) {
    if (predicate(ws._queue[i])) {
      return Promise.resolve(ws._queue.splice(i, 1)[0]);
    }
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = ws._consumers.indexOf(consumer);
      if (idx >= 0) ws._consumers.splice(idx, 1);
      reject(new Error(`timeout waiting for ${label}`));
    }, timeoutMs);
    function consumer(msg) {
      if (predicate(msg)) {
        clearTimeout(timer);
        resolve(msg);
        return true; // consumed
      }
      return false;
    }
    ws._consumers.push(consumer);
  });
}

// Helper that listens to ALL messages of a type for a window — used to check
// that something does NOT arrive (e.g. echo check, state-ping silent check)
function collectFor(ws, predicate, durationMs) {
  return new Promise((resolve) => {
    const collected = [];
    const consumer = (msg) => {
      if (predicate(msg)) { collected.push(msg); return true; }
      return false;
    };
    ws._consumers.push(consumer);
    setTimeout(() => {
      const idx = ws._consumers.indexOf(consumer);
      if (idx >= 0) ws._consumers.splice(idx, 1);
      resolve(collected);
    }, durationMs);
  });
}

function send(ws, obj) { ws.send(JSON.stringify(obj)); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runTests() {
  console.log(`\n━━━ Testing against ${SERVER} ━━━\n`);

  // ── TEST 1: create + join handshake ────────────────────────────────────
  console.log('TEST 1: create + join handshake');
  let host, joiner, roomId;
  try {
    host = await connect();
    send(host, { type: 'create', username: 'host', version: VERSION });
    const created = await waitFor(host, m => m.type === 'created', 5000, 'created');
    roomId = created.roomId;
    if (!roomId || roomId.length !== 6) throw new Error(`bad roomId: ${roomId}`);
    pass(`host created room ${roomId}`);

    joiner = await connect();
    send(joiner, { type: 'join', roomId, username: 'joiner', version: VERSION });
    const joined = await waitFor(joiner, m => m.type === 'joined', 5000, 'joined');
    if (joined.roomId !== roomId) throw new Error(`wrong roomId: ${joined.roomId}`);
    if (joined.recreated) throw new Error(`fresh join should not be recreated`);
    pass(`joiner joined room ${roomId}`);

    // host should receive peer-joined
    const peer = await waitFor(host, m => m.type === 'peer-joined', 3000, 'peer-joined');
    if (peer.username !== 'joiner') throw new Error(`wrong peer username: ${peer.username}`);
    pass('host got peer-joined event');

    // both should receive members
    const members = await waitFor(joiner, m => m.type === 'members', 3000, 'members');
    if (members.members.length !== 2) throw new Error(`expected 2 members, got ${members.members.length}`);
    pass(`members list updated: [${members.members.join(', ')}]`);
  } catch (e) { fail('handshake', e.message); }

  // ── TEST 2: v2.0 playback propagation with new eventType field ─────────
  console.log('\nTEST 2: v2.0 playback propagation (eventType + volume + rate)');
  try {
    send(host, { type: 'playback', eventType: 'seeked', currentTime: 33.5, volume: 0.75, rate: 1.0 });
    const recv = await waitFor(joiner, m => m.type === 'playback', 3000, 'playback');
    if (recv.eventType !== 'seeked') throw new Error(`wrong eventType: ${recv.eventType}`);
    if (recv.action !== 'seeked') throw new Error(`backwards-compat action field missing: ${recv.action}`);
    if (Math.abs(recv.currentTime - 33.5) > 0.01) throw new Error(`wrong time: ${recv.currentTime}`);
    if (Math.abs(recv.volume - 0.75) > 0.01) throw new Error(`wrong volume: ${recv.volume}`);
    if (recv.rate !== 1.0) throw new Error(`wrong rate: ${recv.rate}`);
    if (recv.from !== 'host') throw new Error(`wrong sender: ${recv.from}`);
    pass(`v2 fields all propagated: eventType=${recv.eventType} time=${recv.currentTime} vol=${recv.volume} rate=${recv.rate}`);

    // backwards compat: old client sending `action` instead of `eventType`
    send(joiner, { type: 'playback', action: 'play', currentTime: 42 });
    const recv2 = await waitFor(host, m => m.type === 'playback', 3000, 'reverse playback');
    if (recv2.eventType !== 'play') throw new Error(`old action field not normalized to eventType: ${recv2.eventType}`);
    pass(`backwards compat: old "action" field accepted, normalized to eventType=${recv2.eventType}`);

    // volume-only change should propagate too
    send(host, { type: 'playback', eventType: 'volumechange', currentTime: 50, volume: 0.3 });
    const recv3 = await waitFor(joiner, m => m.type === 'playback' && m.eventType === 'volumechange', 3000, 'volume change');
    if (Math.abs(recv3.volume - 0.3) > 0.01) throw new Error(`wrong volume: ${recv3.volume}`);
    pass(`volumechange event propagates with volume=${recv3.volume}`);

    // rate change
    send(joiner, { type: 'playback', eventType: 'ratechange', currentTime: 50, rate: 1.5 });
    const recv4 = await waitFor(host, m => m.type === 'playback' && m.eventType === 'ratechange', 3000, 'rate change');
    if (recv4.rate !== 1.5) throw new Error(`wrong rate: ${recv4.rate}`);
    pass(`ratechange event propagates with rate=${recv4.rate}x`);
  } catch (e) { fail('playback propagation', e.message); }

  // ── TEST 2b: buffering events (new in v2) ─────────────────────────────
  console.log('\nTEST 2b: buffering events (v2 feature — auto-pause partner on stall)');
  try {
    send(host, { type: 'buffering' });
    const recv = await waitFor(joiner, m => m.type === 'buffering', 3000, 'buffering');
    if (recv.from !== 'host') throw new Error(`wrong sender: ${recv.from}`);
    pass(`buffering event propagated — partner can auto-pause`);

    send(host, { type: 'buffered' });
    const recv2 = await waitFor(joiner, m => m.type === 'buffered', 3000, 'buffered');
    if (recv2.from !== 'host') throw new Error(`wrong sender: ${recv2.from}`);
    pass(`buffered event propagated — partner can auto-resume`);
  } catch (e) { fail('buffering events', e.message); }

  // ── TEST 2c: countdown events (new in v2) ─────────────────────────────
  console.log('\nTEST 2c: countdown (v2 feature — synchronized start)');
  try {
    send(host, { type: 'countdown' });
    const recv = await waitFor(joiner, m => m.type === 'countdown', 3000, 'countdown');
    if (recv.from !== 'host') throw new Error(`wrong sender: ${recv.from}`);
    pass(`countdown event propagated — both sides see 3-2-1`);
  } catch (e) { fail('countdown', e.message); }

  // ── TEST 2d: sync-ping latency probe (new in v2) ──────────────────────
  console.log('\nTEST 2d: sync-ping latency probe (v2 feature — RTT measurement)');
  try {
    const sentAt = Date.now();
    send(host, { type: 'sync-ping', t: sentAt });
    const pong = await waitFor(host, m => m.type === 'sync-pong', 3000, 'sync-pong');
    if (pong.t !== sentAt) throw new Error(`pong t mismatch: ${pong.t} vs ${sentAt}`);
    pass(`sync-ping echoed back as sync-pong with original timestamp (RTT measurable)`);
  } catch (e) { fail('sync-ping', e.message); }

  // ── TEST 2f: action broadcast (v2.1.7 — button-press notifications) ───
  console.log('\nTEST 2f: action message (v2.1.7 — broadcastAll like chat)');
  try {
    send(host, { type: 'action', text: '🔧 pushed sync' });
    // joiner should receive it
    const j = await waitFor(joiner, m => m.type === 'action', 3000, 'action on joiner');
    if (j.username !== 'host') throw new Error(`wrong sender: ${j.username}`);
    if (j.text !== '🔧 pushed sync') throw new Error(`wrong text: ${j.text}`);
    pass(`joiner received action from ${j.username}: "${j.text}"`);
    // host should also receive it (broadcastAll, like chat)
    const h = await waitFor(host, m => m.type === 'action', 3000, 'action loopback');
    if (h.text !== '🔧 pushed sync') throw new Error(`loopback text mismatch`);
    pass(`host received their own action back (broadcastAll loopback works)`);

    // size cap: huge text gets truncated to 200 chars
    const huge = 'x'.repeat(500);
    send(host, { type: 'action', text: huge });
    const capped = await waitFor(joiner, m => m.type === 'action' && m.text.startsWith('x'), 3000, 'huge action');
    if (capped.text.length > 200) throw new Error(`oversized action not capped: ${capped.text.length} chars`);
    pass(`oversized action text correctly capped at 200 chars`);
  } catch (e) { fail('action broadcast', e.message); }

  // ── TEST 2g: remote-rescan (v2.1.7 — restart can trigger partner's rescan) ───
  console.log('\nTEST 2g: remote-rescan (v2.1.7 — broadcast except sender)');
  try {
    send(host, { type: 'remote-rescan' });
    const r = await waitFor(joiner, m => m.type === 'remote-rescan', 3000, 'remote-rescan');
    pass(`joiner received remote-rescan from host`);
    // sender should NOT receive their own remote-rescan back
    const echoed = await collectFor(host, m => m.type === 'remote-rescan', 500);
    if (echoed.length > 0) throw new Error(`remote-rescan echoed to sender ${echoed.length} times`);
    pass(`remote-rescan does NOT echo back to sender (broadcast-except-sender)`);
  } catch (e) { fail('remote-rescan', e.message); }

  // ── TEST 2e: jumpscare imageUrl forwarding (v2.1 feature) ─────────────
  console.log('\nTEST 2e: jumpscare with custom imageUrl (v2.1 feature)');
  try {
    const fakeDataUrl = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAS' + 'A'.repeat(100);
    send(host, { type: 'jumpscare', imageUrl: fakeDataUrl });
    const scare = await waitFor(joiner, m => m.type === 'jumpscare', 3000, 'jumpscare');
    if (scare.imageUrl !== fakeDataUrl) throw new Error('imageUrl not forwarded');
    if (scare.username !== 'host') throw new Error(`wrong sender: ${scare.username}`);
    pass(`jumpscare imageUrl forwarded (${scare.imageUrl.length} chars)`);

    // size cap: huge imageUrl should be stripped
    const tooBig = 'data:image/jpeg;base64,' + 'A'.repeat(300_000);
    send(host, { type: 'jumpscare', imageUrl: tooBig });
    const scareCapped = await waitFor(joiner, m => m.type === 'jumpscare', 3000, 'jumpscare capped');
    if (scareCapped.imageUrl !== undefined) throw new Error(`oversized imageUrl was forwarded (size: ${scareCapped.imageUrl?.length})`);
    pass(`oversized imageUrl correctly stripped at server (250KB cap)`);

    // no imageUrl: backwards-compat (emoji fallback path)
    send(host, { type: 'jumpscare' });
    const scareNoImg = await waitFor(joiner, m => m.type === 'jumpscare' && !m.imageUrl, 3000, 'jumpscare no image');
    pass(`jumpscare without imageUrl still works (default emoji fallback)`);
  } catch (e) { fail('jumpscare imageUrl', e.message); }

  // ── TEST 3: sender should NOT receive own playback (broadcast except sender) ───
  console.log('\nTEST 3: playback does not echo back to sender');
  try {
    send(host, { type: 'playback', action: 'pause', currentTime: 99 });
    const echoed = await collectFor(host, m => m.type === 'playback', 500);
    if (echoed.length > 0) throw new Error(`playback echoed to sender ${echoed.length} times`);
    pass('no echo to sender — broadcast properly excludes ws');
  } catch (e) { fail('echo check', e.message); }

  // drain the joiner's queue of the playback from test 3
  await collectFor(joiner, m => m.type === 'playback', 200);

  // ── TEST 4: state-ping is silent (server stores but doesn't broadcast) ─────────
  console.log('\nTEST 4: state-ping is silent');
  try {
    send(host, { type: 'state-ping', action: 'play', currentTime: 77 });
    const leaked = await collectFor(joiner, m => m.type === 'state-ping', 500);
    if (leaked.length > 0) throw new Error(`state-ping leaked ${leaked.length} times`);
    pass('state-ping is silent — not broadcast to other members');
  } catch (e) { fail('state-ping silent', e.message); }

  // ── TEST 5: chat is broadcastAll (sender also receives) ────────────────────────
  console.log('\nTEST 5: chat broadcast includes sender (broadcastAll)');
  try {
    send(host, { type: 'chat', text: 'test-chat-msg' });
    const senderEcho = await waitFor(host, m => m.type === 'chat' && m.text === 'test-chat-msg', 2000, 'sender chat echo');
    pass(`chat loops back to sender — broadcastAll working ("${senderEcho.text}")`);

    // and joiner should also receive
    send(joiner, { type: 'chat', text: 'from-joiner' });
    const recv = await waitFor(host, m => m.type === 'chat' && m.text === 'from-joiner', 2000, 'chat from joiner');
    pass(`cross-client chat works: "${recv.text}" from ${recv.username}`);
  } catch (e) { fail('chat broadcast', e.message); }

  // ── TEST 6: version-mismatch detection (the new feature) ───────────────────────
  console.log('\nTEST 6: version-mismatch detection');
  try {
    const oldHost = await connect();
    send(oldHost, { type: 'create', username: 'old_host', version: '1.0.0' });
    const r = await waitFor(oldHost, m => m.type === 'created', 5000, 'created');

    const newJoiner = await connect();
    send(newJoiner, { type: 'join', roomId: r.roomId, username: 'new_joiner', version: '1.2.0' });

    const mismatch = await waitFor(newJoiner, m => m.type === 'version-mismatch', 3000, 'version-mismatch');
    if (!mismatch.versions.includes('1.0.0') || !mismatch.versions.includes('1.2.0')) {
      throw new Error(`mismatch payload missing version: ${mismatch.versions}`);
    }
    pass(`version-mismatch fired: "${mismatch.versions}"`);

    oldHost.close();
    newJoiner.close();
  } catch (e) { fail('version-mismatch', e.message); }

  // ── TEST 7: joining nonexistent room rejects unless isReconnect ────────────────
  console.log('\nTEST 7: nonexistent room handling');
  try {
    const ws = await connect();
    send(ws, { type: 'join', roomId: 'XXXXXX', username: 'ghost', version: VERSION });
    const err = await waitFor(ws, m => m.type === 'error', 3000, 'error');
    if (!err.message.includes('not found')) throw new Error(`unexpected error: ${err.message}`);
    pass(`fresh join to missing room rejected: "${err.message}"`);
    ws.close();

    // reconnect should auto-create
    const ws2 = await connect();
    send(ws2, { type: 'join', roomId: 'YYYYYY', username: 'reconnector', isReconnect: true, version: VERSION });
    const joined = await waitFor(ws2, m => m.type === 'joined', 3000, 'reconnect joined');
    if (!joined.recreated) throw new Error('recreated flag missing on isReconnect join');
    pass(`isReconnect auto-creates room with recreated:true flag`);
    ws2.close();
  } catch (e) { fail('nonexistent room', e.message); }

  // ── TEST 8: peer-left fires when a member disconnects ──────────────────────────
  console.log('\nTEST 8: peer-left on disconnect');
  try {
    const promise = waitFor(host, m => m.type === 'peer-left', 3000, 'peer-left');
    joiner.close();
    const left = await promise;
    if (left.username !== 'joiner') throw new Error(`wrong leaver: ${left.username}`);
    pass(`host got peer-left for ${left.username}`);
  } catch (e) { fail('peer-left', e.message); }

  // cleanup
  try { host?.close(); } catch (_) {}

  // ── REPORT ─────────────────────────────────────────────────────────────────────
  console.log(`\n━━━ Results: ${passed} passed, ${failed} failed ━━━`);
  return failed === 0;
}

runTests()
  .then(ok => process.exit(ok ? 0 : 1))
  .catch(err => { console.error('FATAL:', err); process.exit(2); });
