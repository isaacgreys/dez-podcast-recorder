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

  // =========================================================
  // Small helpers
  // =========================================================

  function setStatus(state, caption) {
    statusLed.dataset.state = state;
    statusLedCaption.textContent = caption;
  }
  function setLcdStatus(text) { lcdStatus.textContent = text; }
  function setFooter(text) { footerMsg.textContent = text; }

  function formatTime(ms) {
    const totalSec = Math.floor(ms / 1000);
    const mm = String(Math.floor(totalSec / 60)).padStart(2, '0');
    const ss = String(totalSec % 60).padStart(2, '0');
    return mm + ':' + ss;
  }

  function spinReels(spin) {
    reelLeft.classList.toggle('is-spinning', spin);
    reelRight.classList.toggle('is-spinning', spin);
  }

  function showLoadFailure() {
    const banner = document.getElementById('loadFailBanner');
    if (banner) banner.hidden = false;
    setLcdStatus('LOAD ERROR');
    setFooter('Connection library failed to load — reload the page once you\u2019re back online.');
    connectBtn.disabled = true;
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
          noiseSuppression: false,
          autoGainControl: false,
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
  //    (raw PCM, only pushed to pcmChunks while recording)
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
      vuNeedle.style.transform = 'rotate(' + deg + 'deg)';
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
      console.warn('IndexedDB persist failed (non-fatal)', err);
    }
  }

  async function clearIndexedDbSession() {
    try {
      if (!dbPromise) dbPromise = openDb();
      const db = await dbPromise;
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).clear();
    } catch (err) {
      console.warn('IndexedDB clear failed (non-fatal)', err);
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
          setFooter('Found an unsaved take from last session — recovering it now\u2026');
          recoverIndexedDbSession();
        }
      };
    } catch (err) {
      console.warn('IndexedDB check failed (non-fatal)', err);
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
            setFooter('Recovered a take from before the last crash/reload and saved it.');
          }
          clearIndexedDbSession();
        }
      };
    } catch (err) {
      console.warn('IndexedDB recovery failed', err);
    }
  }

  // =========================================================
  // 4. WAV encoding — real uncompressed 16-bit PCM
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
  // 5. PeerJS — room-code based connect, reconnection, acked sync
  // =========================================================

  function myFullPeerId() {
    return isHost ? roomCode : (roomCode + '-guest');
  }

  function ensureRemoteAudioSafetyUi() {
    if (!remoteAudioWarningEl) {
      remoteAudioWarningEl = document.createElement('div');
      remoteAudioWarningEl.id = 'remoteAudioWarning';
      remoteAudioWarningEl.textContent = 'Warning: wear headphones to avoid echo and feedback while talking.';
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
      try { dataConn.close(); } catch (err) { console.warn('Data conn close failed', err); }
    }

    if (peer && !peer.destroyed) {
      try { peer.destroy(); } catch (err) { console.warn('Peer destroy failed', err); }
    }

    if (localStream) {
      localStream.getTracks().forEach((track) => track.stop());
      localStream = null;
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
    hostUnavailableRetryUsed = false;
    if (peer) { peer.destroy(); peer = null; }

    peer = new Peer(roomCode, { debug: 0 });

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
        if (!hostUnavailableRetryUsed) {
          hostUnavailableRetryUsed = true;
          setFooter('Room is still busy or stale — retrying as host once more in a moment.');
          if (reconnectTimer) clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            if (roomCode) initPeerForRoom();
          }, 1200);
          return;
        }
        becomeGuestAndConnect();
      } else if (err.type === 'peer-unavailable') {
        setFooter('No one\u2019s in that room yet — waiting, or double-check the code.');
      } else if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error' || err.type === 'socket-closed') {
        scheduleReconnect();
      } else {
        console.error('Peer error', err);
        setFooter('Connection hiccup (' + err.type + ') — retrying\u2026');
        scheduleReconnect();
      }
    });

    peer.on('disconnected', () => {
      setStatus('offline', 'RECONNECTING');
      setLcdStatus('RECONNECTING');
      if (!peer.destroyed) peer.reconnect();
    });
  }

  function becomeGuestAndConnect() {
    if (typeof Peer === 'undefined') {
      showLoadFailure();
      return;
    }
    if (peer) { peer.destroy(); peer = null; }
    isHost = false;
    peer = new Peer(myFullPeerId(), { debug: 0 });

    peer.on('open', (id) => {
      reconnectAttempts = 0;
      onLocalPeerReady(id);
      connectToHost();
    });
    peer.on('call', handleIncomingCall);
    peer.on('connection', (conn) => { dataConn = conn; wireDataConnection(); });
    peer.on('error', (err) => {
      console.error('Guest peer error', err);
      if (err.type === 'peer-unavailable') {
        // Host isn't there yet (or dropped) — keep retrying as guest rather
        // than bouncing back to a host attempt, so two people joining at
        // nearly the same moment don't flap roles back and forth.
        setFooter('Waiting for co-host\u2019s room to open\u2026 retrying.');
        reconnectAttempts++;
        const delay = Math.min(800 * Math.pow(1.5, reconnectAttempts), 8000);
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          if (roomCode && !isHost) connectToHost();
        }, delay);
      } else if (err.type === 'unavailable-id') {
        // Our own guest slot briefly collided (e.g. rapid rejoin) — just retry shortly.
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          if (roomCode) becomeGuestAndConnect();
        }, 1000);
      } else {
        scheduleReconnect();
      }
    });
    peer.on('disconnected', () => {
      setStatus('offline', 'RECONNECTING');
      if (!peer.destroyed) peer.reconnect();
    });
  }

  function onLocalPeerReady(id) {
    lcdMyId.textContent = 'room "' + roomCode + '"';
    setLcdStatus(isHost ? 'ROOM OPEN' : 'JOINING\u2026');
    connectBtn.disabled = true;
    roomCodeField.disabled = true;
  }

  function connectToHost() {
    setFooter('Joining your co-host\u2026');
    dataConn = peer.connect(roomCode, { reliable: true });
    wireDataConnection();
    getMicStream()
      .then((stream) => {
        const call = peer.call(roomCode, stream);
        wireMediaCall(call);
      })
      .catch(() => setFooter('Could not start voice call — mic permission required.'));
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
    const delay = Math.min(1000 * Math.pow(1.6, reconnectAttempts), 15000);
    setStatus('offline', 'RECONNECTING');
    setLcdStatus('RECONNECTING');
    setFooter('Connection dropped — retrying in ' + Math.round(delay / 1000) + 's\u2026');
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (roomCode) initPeerForRoom();
    }, delay);
  }

  function wireDataConnection() {
    dataConn.on('open', () => {
      setStatus('connected', 'PEER LINKED');
      setLcdStatus('PEER CONNECTED');
      setFooter('Co-host connected. Ready to record.');
      recordBtn.disabled = false;
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
      setFooter('Co-host disconnected — will reconnect automatically if they rejoin.');
    });

    dataConn.on('error', (err) => {
      console.warn('Data connection error', err);
    });
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
        el.volume = 0.18;
        el.setAttribute('playsinline', '');
        el.style.display = 'none';
        document.body.appendChild(el);
      }
      el.srcObject = remoteStream;
      el.muted = true;
      el.volume = 0.18;
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
      setFooter('Enter a room code first — anything you and your co-host both know.');
      return;
    }
    roomCode = code;
    const url = new URL(window.location.href);
    url.searchParams.set('room', roomCode);
    window.history.replaceState({}, '', url);

    setLcdStatus('CONNECTING\u2026');
    setFooter('Opening room\u2026');
    initPeerForRoom();
  }

  // =========================================================
  // 6. Recording — real PCM capture, synced with ack + timeout warning
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
      recordBtn.disabled = true;
      stopBtn.disabled = false;
      setFooter(triggeredByPeer ? 'Co-host started the take — recording locally.' : 'Recording\u2026 waiting for co-host confirmation.');

      timerInterval = setInterval(() => {
        timeDisplay.textContent = formatTime(Date.now() - recordStartTime);
      }, 250);

      if (!triggeredByPeer && dataConn && dataConn.open) {
        dataConn.send('START_RECORD');
        clearTimeout(ackTimeout);
        ackTimeout = setTimeout(() => {
          setFooter('\u26a0 No confirmation from co-host yet — check they\u2019re still connected.');
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
    setLcdStatus('SAVING\u2026');
    recordBtn.disabled = false;
    stopBtn.disabled = true;
    setFooter(triggeredByPeer ? 'Co-host stopped the take.' : 'Recording stopped — encoding WAV\u2026');

    if (!triggeredByPeer && dataConn && dataConn.open) {
      dataConn.send('STOP_RECORD');
    }

    // Let any in-flight onaudioprocess callback finish pushing its chunk
    // before we read pcmChunks, so the last ~85ms of audio isn't dropped.
    setTimeout(() => {
      if (pcmChunks.length === 0) {
        setFooter('Recording was too short to save — try holding the take a little longer.');
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
    setFooter('Saved ' + filename + ' to your downloads.');
    setLcdStatus('SAVED');
    timeDisplay.textContent = '00:00';
  }

  // =========================================================
  // Wire up UI events
  // =========================================================

  shareLinkBtn.addEventListener('click', async () => {
    const code = slugifyRoomCode(roomCodeField.value);
    if (!code) {
      setFooter('Type a room code first, then share the link.');
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.set('room', code);
    try {
      await navigator.clipboard.writeText(url.toString());
      const original = shareLinkBtn.textContent;
      shareLinkBtn.textContent = 'COPIED';
      setTimeout(() => (shareLinkBtn.textContent = original), 1200);
      setFooter('Link copied — send it to your co-host, they just tap it to join.');
    } catch (e) {
      setFooter('Copy this link: ' + url.toString());
    }
  });

  connectBtn.addEventListener('click', joinRoom);
  roomCodeField.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinRoom();
  });

  recordBtn.addEventListener('click', () => beginRecording(false));
  stopBtn.addEventListener('click', () => finishRecording(false));

  window.addEventListener('beforeunload', (e) => {
    teardownPeerState();
    if (isRecording) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  window.addEventListener('pagehide', () => {
    teardownPeerState();
  });

  // =========================================================
  // Boot
  // =========================================================

  setStatus('offline', 'OFFLINE');
  setLcdStatus('BOOTING\u2026');
  getMicStream().catch(() => {});
  checkForRecoverableSession();

  const params = new URLSearchParams(window.location.search);
  const sharedRoom = params.get('room');
  if (sharedRoom) {
    roomCodeField.value = sharedRoom;
    setFooter('Room code loaded from link \u2014 joining automatically\u2026');
    waitForPeerLibThenJoin();
  } else {
    setFooter('Type a room code you both know, then hit Join Room.');
  }

  function waitForPeerLibThenJoin(attemptsLeft) {
    if (attemptsLeft === undefined) attemptsLeft = 20; // ~4s total
    if (typeof Peer !== 'undefined') {
      joinRoom();
      return;
    }
    if (attemptsLeft <= 0) {
      showLoadFailure();
      return;
    }
    setTimeout(() => waitForPeerLibThenJoin(attemptsLeft - 1), 200);
  }

})();
