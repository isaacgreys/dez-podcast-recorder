/* =========================================================
   DEZ — app.js
   Room-code based PeerJS connection + WebRTC voice call
   Web Audio API VU meter
   Real PCM WAV recording (via ScriptProcessor tap),
   synced + acknowledged over the data channel, with
   IndexedDB crash recovery.
   ========================================================= */

(() => {
  'use strict';

  // ---------- DOM refs ----------
  const $ = (id) => document.getElementById(id);

  const roomCodeField   = $('roomCodeField');
  const shareLinkBtn    = $('shareLinkBtn');
  const connectBtn      = $('connectBtn');
  const recordBtn       = $('recordBtn');
  const stopBtn         = $('stopBtn');
  const timeDisplay     = $('timeDisplay');
  const lcdStatus       = $('lcdStatus');
  const lcdMyId         = $('lcdMyId');
  const statusLed       = $('statusLed');
  const statusLedCaption= $('statusLedCaption');
  const vuNeedle        = $('vuNeedle');
  const reelLeft        = $('reelLeft');
  const reelRight       = $('reelRight');
  const footerMsg       = $('footerMsg');

  // ---------- State ----------
  let peer = null;
  let dataConn = null;
  let mediaCall = null;
  let localStream = null;
  let roomCode = '';
  let isHost = false;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let ackTimeout = null;
  let hostUnavailableRetryUsed = false;
  let remoteAudioToggleBtn = null;
  let remoteAudioWarningEl = null;

  let isRecording = false;
  let recordStartTime = 0;
  let timerInterval = null;
  let recSessionId = null;

  let audioCtx = null;
  let analyser = null;
  let processorNode = null;
  let sourceNode = null;
  let pcmChunks = [];
  let sampleRate = 48000;

  const NEEDLE_MIN_DEG = -80;
  const NEEDLE_MAX_DEG = 80;

  const DB_NAME = 'dez-recorder';
  const DB_STORE = 'chunks';

  // Default ICE servers to ensure reliable WebRTC traversal
  const PEER_CONFIG = {
    debug: 0,
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' }
      ]
    }
  };

  // =========================================================
  // Small helpers
  // =========================================================

  function setStatus(state, caption) {
    if (statusLed) statusLed.dataset.state = state;
    if (statusLedCaption) statusLedCaption.textContent = caption;
  }
  function setLcdStatus(text) { if (lcdStatus) lcdStatus.textContent = text; }
  function setFooter(text) { if (footerMsg) footerMsg.textContent = text; }

  function formatTime(ms) {
    const totalSec = Math.floor(ms / 1000);
    const mm = String(Math.floor(totalSec / 60)).padStart(2, '0');
    const ss = String(totalSec % 60).padStart(2, '0');
    return mm + ':' + ss;
  }

  function spinReels(spin) {
    if (reelLeft) reelLeft.classList.toggle('is-spinning', spin);
    if (reelRight) reelRight.classList.toggle('is-spinning', spin);
  }

  function showLoadFailure() {
    const banner = document.getElementById('loadFailBanner');
    if (banner) banner.hidden = false;
    setLcdStatus('LOAD ERROR');
    setFooter('Connection library failed to load — reload the page once you’re back online.');
    if (connectBtn) connectBtn.disabled = true;
  }

  function slugifyRoomCode(raw) {
    return raw.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  }

  // =========================================================
  // 1. Microphone capture
  // =========================================================

  async function getMicStream() {
    if (localStream) return localStream;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1
        },
        video: false
      });
      setFooter('Mic ready. Type a room code to connect.');
      setupAudioGraph(localStream);
      return localStream;
    } catch (err) {
      console.error('getUserMedia failed', err);
      setFooter('Mic access denied — allow the microphone and reload.');
      throw err;
    }
  }

  // =========================================================
  // 2. Audio graph — AnalyserNode (VU) + ScriptProcessor tap
  // =========================================================

  function setupAudioGraph(stream) {
    if (audioCtx) return;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    sampleRate = audioCtx.sampleRate;
    sourceNode = audioCtx.createMediaStreamSource(stream);

    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.6;
    sourceNode.connect(analyser);
    runVuLoop();

    const bufferSize = 4096;
    processorNode = audioCtx.createScriptProcessor(bufferSize, 1, 1);
    processorNode.onaudioprocess = (e) => {
      if (!isRecording) return;
      const channelData = e.inputBuffer.getChannelData(0);
      pcmChunks.push(new Float32Array(channelData));
      if (pcmChunks.length % 10 === 0) persistChunksToIndexedDB();
    };
    sourceNode.connect(processorNode);
    const silentGain = audioCtx.createGain();
    silentGain.gain.value = 0;
    processorNode.connect(silentGain);
    silentGain.connect(audioCtx.destination);
  }

  function runVuLoop() {
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    function tick() {
      analyser.getByteTimeDomainData(dataArray);
      let sumSquares = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const norm = (dataArray[i] - 128) / 128;
        sumSquares += norm * norm;
      }
      const rms = Math.sqrt(sumSquares / dataArray.length);
      const level = Math.min(1, rms * 3.2);
      const deg = NEEDLE_MIN_DEG + level * (NEEDLE_MAX_DEG - NEEDLE_MIN_DEG);
      if (vuNeedle) vuNeedle.style.transform = 'rotate(' + deg + 'deg)';
      requestAnimationFrame(tick);
    }
    tick();
  }

  // =========================================================
  // 3. IndexedDB crash recovery
  // =========================================================

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(DB_STORE, { keyPath: 'id', autoIncrement: true });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  let dbPromise = null;
  let lastPersistedIndex = 0;

  async function persistChunksToIndexedDB() {
    try {
      if (!dbPromise) dbPromise = openDb();
      const db = await dbPromise;
      const tx = db.transaction(DB_STORE, 'readwrite');
      const store = tx.objectStore(DB_STORE);
      for (let i = lastPersistedIndex; i < pcmChunks.length; i++) {
        store.add({ session: recSessionId, chunk: pcmChunks[i], sampleRate: sampleRate });
      }
      lastPersistedIndex = pcmChunks.length;
    } catch (err) {
      console.warn('IndexedDB persist failed', err);
    }
  }

  async function clearIndexedDbSession() {
    try {
      if (!dbPromise) dbPromise = openDb();
      const db = await dbPromise;
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).clear();
    } catch (err) {
      console.warn('IndexedDB clear failed', err);
    }
    lastPersistedIndex = 0;
  }

  async function checkForRecoverableSession() {
    try {
      if (!dbPromise) dbPromise = openDb();
      const db = await dbPromise;
      const tx = db.transaction(DB_STORE, 'readonly');
      const store = tx.objectStore(DB_STORE);
      const countReq = store.count();
      countReq.onsuccess = () => {
        if (countReq.result > 0) {
          setFooter('Found an unsaved take from last session — recovering it now…');
          recoverIndexedDbSession();
        }
      };
    } catch (err) {
      console.warn('IndexedDB check failed', err);
    }
  }

  async function recoverIndexedDbSession() {
    try {
      const db = await dbPromise;
      const tx = db.transaction(DB_STORE, 'readonly');
      const store = tx.objectStore(DB_STORE);
      const all = [];
      let recoveredSampleRate = sampleRate;
      const cursorReq = store.openCursor();
      cursorReq.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          all.push(cursor.value.chunk);
          if (cursor.value.sampleRate) recoveredSampleRate = cursor.value.sampleRate;
          cursor.continue();
        } else {
          if (all.length > 0) {
            const wavBlob = encodeWav(all, recoveredSampleRate);
            downloadBlob(wavBlob, true);
            setFooter('Recovered a take from before the last crash/reload.');
          }
          clearIndexedDbSession();
        }
      };
    } catch (err) {
      console.warn('IndexedDB recovery failed', err);
    }
  }

  // =========================================================
  // 4. WAV encoding
  // =========================================================

  function encodeWav(float32Chunks, sr) {
    let totalLength = 0;
    for (const c of float32Chunks) totalLength += c.length;

    const pcm16 = new Int16Array(totalLength);
    let offset = 0;
    for (const chunk of float32Chunks) {
      for (let i = 0; i < chunk.length; i++) {
        const s = Math.max(-1, Math.min(1, chunk[i]));
        pcm16[offset++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
    }

    const bytesPerSample = 2;
    const blockAlign = bytesPerSample * 1;
    const byteRate = sr * blockAlign;
    const dataSize = pcm16.length * bytesPerSample;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    function writeString(o, s) {
      for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
    }

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sr, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);

    let pcmOffset = 44;
    for (let i = 0; i < pcm16.length; i++, pcmOffset += 2) {
      view.setInt16(pcmOffset, pcm16[i], true);
    }

    return new Blob([view], { type: 'audio/wav' });
  }

  // =========================================================
  // 5. PeerJS — connection logic
  // =========================================================

  function uniqueGuestPeerId() {
    const stamp = Date.now().toString(36);
    const salt = Math.random().toString(36).slice(2, 8);
    return roomCode + '-guest-' + stamp + '-' + salt;
  }

  function ensureRemoteAudioSafetyUi() {
    if (!remoteAudioWarningEl) {
      remoteAudioWarningEl = document.createElement('div');
      remoteAudioWarningEl.id = 'remoteAudioWarning';
      remoteAudioWarningEl.textContent = 'Warning: Wear headphones to prevent feedback and echo.';
      remoteAudioWarningEl.style.cssText = 'display:none; margin:10px auto 0; max-width:540px; padding:8px 12px; border-radius:999px; background:rgba(255, 182, 0, 0.12); color:#ffe08a; border:1px solid rgba(255,182,0,0.4); font-size:12px; font-weight:700; text-align:center; letter-spacing:0.04em; text-transform:uppercase;';
      document.body.appendChild(remoteAudioWarningEl);
    }

    if (!remoteAudioToggleBtn) {
      remoteAudioToggleBtn = document.createElement('button');
      remoteAudioToggleBtn.id = 'remoteAudioToggle';
      remoteAudioToggleBtn.type = 'button';
      remoteAudioToggleBtn.textContent = 'Unmute co-host audio';
      remoteAudioToggleBtn.style.cssText = 'display:none; margin:10px auto 0; padding:8px 14px; border:none; border-radius:999px; cursor:pointer; background:#2ce0a2; color:#0f172a; font-weight:700;';
      remoteAudioToggleBtn.addEventListener('click', () => {
        const remoteEl = document.getElementById('remoteAudioEl');
        if (!remoteEl) return;
        remoteEl.muted = !remoteEl.muted;
        remoteAudioToggleBtn.textContent = remoteEl.muted ? 'Unmute co-host audio' : 'Mute co-host audio';
        remoteAudioToggleBtn.style.background = remoteEl.muted ? '#2ce0a2' : '#ffd166';
      });
      document.body.appendChild(remoteAudioToggleBtn);
    }

    return { remoteAudioWarningEl, remoteAudioToggleBtn };
  }

  function teardownPeerState() {
    if (dataConn && typeof dataConn.close === 'function') {
      try { dataConn.close(); } catch (err) {}
    }
    if (peer && !peer.destroyed) {
      try { peer.destroy(); } catch (err) {}
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function initPeerForRoom() {
    if (typeof Peer === 'undefined') {
      showLoadFailure();
      return;
    }

    teardownPeerState();

    peer = new Peer(roomCode, PEER_CONFIG);

    peer.on('open', (id) => {
      isHost = true;
      reconnectAttempts = 0;
      onLocalPeerReady(id);
      setFooter('Room open — waiting for your co-host to join.');
    });

    peer.on('call', handleIncomingCall);
    peer.on('connection', (conn) => { dataConn = conn; wireDataConnection(); });

    peer.on('error', (err) => {
      if (err.type === 'unavailable-id') {
        becomeGuestAndConnect();
      } else if (err.type === 'peer-unavailable') {
        setFooter('No host in room yet. Waiting for host…');
      } else {
        console.warn('Peer error:', err.type);
        scheduleReconnect();
      }
    });

    peer.on('disconnected', () => {
      setStatus('offline', 'RECONNECTING');
      setLcdStatus('RECONNECTING');
      if (isHost) {
        if (peer && !peer.destroyed) peer.reconnect();
        return;
      }
      scheduleReconnect();
    });
  }

  function becomeGuestAndConnect() {
    if (typeof Peer === 'undefined') {
      showLoadFailure();
      return;
    }

    teardownPeerState();
    isHost = false;

    const guestId = uniqueGuestPeerId();
    peer = new Peer(guestId, PEER_CONFIG);
    setFooter('Joining room as guest…');

    peer.on('open', (id) => {
      reconnectAttempts = 0;
      onLocalPeerReady(id);
      connectToHost();
    });

    peer.on('call', handleIncomingCall);
    peer.on('connection', (conn) => { dataConn = conn; wireDataConnection(); });

    peer.on('error', (err) => {
      if (err.type === 'peer-unavailable') {
        setFooter('Waiting for room host… retrying.');
        scheduleReconnect();
      } else {
        scheduleReconnect();
      }
    });

    peer.on('disconnected', () => {
      setStatus('offline', 'RECONNECTING');
      scheduleReconnect();
    });
  }

  function onLocalPeerReady(id) {
    if (lcdMyId) lcdMyId.textContent = 'room "' + roomCode + '"';
    setLcdStatus(isHost ? 'ROOM OPEN' : 'JOINING…');
    if (connectBtn) connectBtn.disabled = true;
    if (roomCodeField) roomCodeField.disabled = true;
  }

  function connectToHost() {
    setFooter('Connecting to host…');
    dataConn = peer.connect(roomCode, { reliable: true });
    wireDataConnection();
    getMicStream()
      .then((stream) => {
        const call = peer.call(roomCode, stream);
        wireMediaCall(call);
      })
      .catch(() => setFooter('Voice connection failed — microphone required.'));
  }

  async function handleIncomingCall(incomingCall) {
    let stream;
    try { stream = await getMicStream(); }
    catch (e) { stream = new MediaStream(); }
    incomingCall.answer(stream);
    wireMediaCall(incomingCall);
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectAttempts++;
    const delay = Math.min(1200 * Math.pow(1.5, reconnectAttempts), 10000);
    setStatus('offline', 'RECONNECTING');
    setLcdStatus('RECONNECTING');
    setFooter('Connection dropped — retrying in ' + Math.round(delay / 1000) + 's…');
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (roomCode) {
        if (isHost) initPeerForRoom();
        else becomeGuestAndConnect();
      }
    }, delay);
  }

  function wireDataConnection() {
    dataConn.on('open', () => {
      setStatus('connected', 'PEER LINKED');
      setLcdStatus('PEER CONNECTED');
      setFooter('Co-host connected. Ready to record.');
      if (recordBtn) recordBtn.disabled = false;
    });

    dataConn.on('data', (msg) => {
      if (msg === 'START_RECORD') {
        beginRecording(true);
        dataConn.send('START_ACK');
      } else if (msg === 'STOP_RECORD') {
        finishRecording(true);
      } else if (msg === 'START_ACK') {
        clearTimeout(ackTimeout);
        setFooter('Recording confirmed on both ends.');
      }
    });

    dataConn.on('close', () => {
      setStatus('offline', 'OFFLINE');
      setLcdStatus('PEER LEFT');
      setFooter('Co-host disconnected.');
    });

    dataConn.on('error', (err) => console.warn('Data channel error:', err));
  }

  function wireMediaCall(call) {
    mediaCall = call;
    call.on('stream', (remoteStream) => {
      const { remoteAudioWarningEl: warningEl, remoteAudioToggleBtn: toggleBtn } = ensureRemoteAudioSafetyUi();
      warningEl.style.display = 'block';
      toggleBtn.style.display = 'inline-block';
      toggleBtn.textContent = 'Unmute co-host audio';
      toggleBtn.style.background = '#2ce0a2';

      let el = document.getElementById('remoteAudioEl');
      if (!el) {
        el = document.createElement('audio');
        el.id = 'remoteAudioEl';
        el.autoplay = true;
        el.muted = true;
        el.volume = 0.8;
        el.setAttribute('playsinline', '');
        el.style.display = 'none';
        document.body.appendChild(el);
      }
      el.srcObject = remoteStream;
      el.muted = true;
    });
    call.on('close', () => setFooter('Call ended.'));
    call.on('error', (err) => console.error('Media call error', err));
  }

  function joinRoom() {
    if (typeof Peer === 'undefined') {
      showLoadFailure();
      return;
    }
    const code = slugifyRoomCode(roomCodeField.value);
    if (!code) {
      setFooter('Enter a room code first.');
      return;
    }
    roomCode = code;
    hostUnavailableRetryUsed = false;
    const url = new URL(window.location.href);
    url.searchParams.set('room', roomCode);
    window.history.replaceState({}, '', url);

    setLcdStatus('CONNECTING…');
    setFooter('Opening room…');
    initPeerForRoom();
  }

  // =========================================================
  // 6. Recording Logic
  // =========================================================

  async function beginRecording(triggeredByPeer) {
    if (isRecording) return;
    try {
      await getMicStream();
      pcmChunks = [];
      lastPersistedIndex = 0;
      recSessionId = Date.now();
      isRecording = true;
      recordStartTime = Date.now();

      spinReels(true);
      setStatus('recording', 'RECORDING');
      setLcdStatus('RECORDING');
      if (recordBtn) recordBtn.disabled = true;
      if (stopBtn) stopBtn.disabled = false;
      setFooter(triggeredByPeer ? 'Co-host started recording locally.' : 'Recording… waiting for confirmation.');

      timerInterval = setInterval(() => {
        if (timeDisplay) timeDisplay.textContent = formatTime(Date.now() - recordStartTime);
      }, 250);

      if (!triggeredByPeer && dataConn && dataConn.open) {
        dataConn.send('START_RECORD');
        clearTimeout(ackTimeout);
        ackTimeout = setTimeout(() => {
          setFooter('⚠ No confirmation from co-host yet.');
        }, 2500);
      }
    } catch (err) {
      console.error('Failed to start recording', err);
      setFooter('Could not start recording — check mic permissions.');
    }
  }

  function finishRecording(triggeredByPeer) {
    if (!isRecording) return;
    isRecording = false;
    spinReels(false);
    clearInterval(timerInterval);
    clearTimeout(ackTimeout);

    setStatus(dataConn && dataConn.open ? 'connected' : 'offline', dataConn && dataConn.open ? 'PEER LINKED' : 'OFFLINE');
    setLcdStatus('SAVING…');
    if (recordBtn) recordBtn.disabled = false;
    if (stopBtn) stopBtn.disabled = true;
    setFooter(triggeredByPeer ? 'Co-host stopped the take.' : 'Recording stopped — encoding WAV…');

    if (!triggeredByPeer && dataConn && dataConn.open) {
      dataConn.send('STOP_RECORD');
    }

    setTimeout(() => {
      if (pcmChunks.length === 0) {
        setFooter('Recording was too short to save.');
        setLcdStatus('EMPTY');
        clearIndexedDbSession();
        return;
      }
      const wavBlob = encodeWav(pcmChunks, sampleRate);
      downloadBlob(wavBlob, false);
      clearIndexedDbSession();
    }, 50);
  }

  function timestampForFilename() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return '' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '_' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
  }

  function downloadBlob(blob, isRecovered) {
    const filename = 'dez_podcast_track_' + timestampForFilename() + (isRecovered ? '_recovered' : '') + '.wav';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    setFooter('Saved ' + filename + ' to downloads.');
    setLcdStatus('SAVED');
    if (timeDisplay) timeDisplay.textContent = '00:00';
  }

  // =========================================================
  // Event Listeners
  // =========================================================

  if (shareLinkBtn) {
    shareLinkBtn.addEventListener('click', async () => {
      const code = slugifyRoomCode(roomCodeField.value);
      if (!code) {
        setFooter('Type a room code first.');
        return;
      }
      const url = new URL(window.location.href);
      url.searchParams.set('room', code);
      try {
        await navigator.clipboard.writeText(url.toString());
        const original = shareLinkBtn.textContent;
        shareLinkBtn.textContent = 'COPIED';
        setTimeout(() => (shareLinkBtn.textContent = original), 1200);
        setFooter('Link copied to clipboard.');
      } catch (e) {
        setFooter('Copy this link: ' + url.toString());
      }
    });
  }

  if (connectBtn) connectBtn.addEventListener('click', joinRoom);
  if (roomCodeField) {
    roomCodeField.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') joinRoom();
    });
  }

  if (recordBtn) recordBtn.addEventListener('click', () => beginRecording(false));
  if (stopBtn) stopBtn.addEventListener('click', () => finishRecording(false));

  window.addEventListener('beforeunload', (e) => {
    teardownPeerState();
    if (isRecording) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  window.addEventListener('pagehide', teardownPeerState);

  // =========================================================
  // Boot sequence
  // =========================================================

  setStatus('offline', 'OFFLINE');
  setLcdStatus('BOOTING…');
  getMicStream().catch(() => {});
  checkForRecoverableSession();

  const params = new URLSearchParams(window.location.search);
  const sharedRoom = params.get('room');

  function waitForPeerLibThenJoin(attemptsLeft = 20) {
    if (typeof Peer !== 'undefined') {
      if (sharedRoom) {
        roomCode = sharedRoom;
        if (roomCodeField) roomCodeField.value = sharedRoom;
        becomeGuestAndConnect();
      } else {
        joinRoom();
      }
      return;
    }
    if (attemptsLeft <= 0) {
      showLoadFailure();
      return;
    }
    setTimeout(() => waitForPeerLibThenJoin(attemptsLeft - 1), 200);
  }

  if (sharedRoom) {
    if (roomCodeField) roomCodeField.value = sharedRoom;
    setFooter('Room code loaded from URL — joining automatically…');
    waitForPeerLibThenJoin();
  } else {
    setFooter('Type a room code and press Join Room.');
  }

})();