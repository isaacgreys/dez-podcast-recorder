/* =========================================================
   DEZ — app.js
   Room-code based PeerJS connection + WebRTC voice call
   Web Audio API VU meter
   Real PCM WAV recording (via ScriptProcessor tap),
   synced + acknowledged over the data channel, with
   IndexedDB crash recovery.

   CONNECTION MODEL (rewritten for reliability):
   Instead of a dynamic "first one wins = host" race — which
   caused stale-ID ghosts after closing a tab, and flapping
   between host/guest roles — both sides now derive a FIXED
   pair of IDs from the room code: "<room>-a" and "<room>-b".
   Each browser tries "-a" first; if taken, it becomes "-b".
   This is deterministic, self-heals after a disconnect once
   the stale ID lease expires, and never requires guessing
   who's "supposed" to be the host.
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
  let mySlot = null;      // 'a' or 'b'
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let ackTimeout = null;
  let hasEverConnected = false;
  let intentionallyLeaving = false;

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

  // remote audio element + mute state (echo-loop mitigation)
  let remoteAudioEl = null;
  let remoteMuted = false;

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

      // If the mic gets unplugged / revoked mid-session, tell the user
      // clearly instead of silently recording nothing.
      localStream.getAudioTracks().forEach((track) => {
        track.addEventListener('ended', () => {
          setFooter('\u26a0 Microphone disconnected — reconnect it and reload the page.');
          setLcdStatus('MIC LOST');
          if (isRecording) finishRecording(false, true /* micLost */);
        });
      });

      setFooter('Mic ready. Type a room code to connect.');
      setupAudioGraph(localStream);
      return localStream;
    } catch (err) {
      console.error('getUserMedia failed', err);
      if (err && err.name === 'NotFoundError') {
        setFooter('No microphone found — plug one in and reload.');
      } else if (err && err.name === 'NotAllowedError') {
        setFooter('Mic access denied — allow the microphone in your browser settings and reload.');
      } else if (err && err.name === 'NotReadableError') {
        setFooter('Mic is busy in another app — close it and reload.');
      } else {
        setFooter('Could not access the microphone — reload and try again.');
      }
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

    // Some browsers suspend the AudioContext until a user gesture; resume
    // opportunistically on the next interaction so the VU meter/recording
    // don't silently stay dead.
    if (audioCtx.state === 'suspended') {
      const resume = () => { audioCtx.resume(); document.removeEventListener('click', resume); };
      document.addEventListener('click', resume);
    }
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
  // 5. PeerJS — fixed-slot room connect (no host/guest race),
  //    clean teardown on leave, echo-safe remote audio
  // =========================================================

  function slotPeerId(slot) {
    return roomCode + '-' + slot;
  }
  function otherSlot(slot) {
    return slot === 'a' ? 'b' : 'a';
  }

  // Try slot "a" first; if it's taken, fall back to slot "b". If both are
  // taken (e.g. two old ghost sessions), we still attempt "b" — PeerJS will
  // report unavailable-id and we'll surface a clear message rather than loop.
  function initPeerForRoom(preferredSlot) {
    if (typeof Peer === 'undefined') {
      showLoadFailure();
      return;
    }
    if (peer) { try { peer.destroy(); } catch (e) {} peer = null; }

    const slot = preferredSlot || 'a';
    mySlot = slot;
    peer = new Peer(slotPeerId(slot), { debug: 0 });

    peer.on('open', (id) => {
      reconnectAttempts = 0;
      hasEverConnected = true;
      onLocalPeerReady();
      setFooter('Room open on your side — waiting for your co-host\u2026');
      attemptConnectToOther();
    });

    peer.on('call', handleIncomingCall);
    peer.on('connection', (conn) => {
      // Only accept a connection from the room's other slot, to avoid
      // stray/unexpected peers if a room code is guessed.
      dataConn = conn;
      wireDataConnection();
    });

    peer.on('error', (err) => {
      if (err.type === 'unavailable-id') {
        if (slot === 'a') {
          // Someone (maybe our own stale session) holds slot "a" — try "b".
          setFooter('Slot in use — trying the other side of the room\u2026');
          setTimeout(() => initPeerForRoom('b'), 300);
        } else {
          // Both slots taken. Could be two real active sessions (room full),
          // or two ghosts from recent tab closes. Ghosts expire on PeerJS's
          // server after ~60s of inactivity, so retry with backoff instead
          // of failing permanently.
          reconnectAttempts++;
          const delay = Math.min(2000 * reconnectAttempts, 10000);
          setLcdStatus('ROOM FULL?');
          setFooter('Both room slots are in use — if you just closed this page, wait a few seconds and it\u2019ll retry automatically.');
          if (reconnectTimer) clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            if (roomCode) initPeerForRoom('a');
          }, delay);
        }
      } else if (err.type === 'peer-unavailable') {
        // The other slot isn't online yet — totally normal while waiting
        // for a co-host. Don't treat this as an error.
        setFooter('Waiting for your co-host to join\u2026');
      } else if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error' || err.type === 'socket-closed') {
        scheduleReconnect();
      } else if (err.type === 'browser-incompatible') {
        setFooter('Your browser doesn\u2019t support the required WebRTC features — try an up-to-date Chrome, Edge, or Firefox.');
      } else {
        console.error('Peer error', err);
        setFooter('Connection hiccup (' + err.type + ') — retrying\u2026');
        scheduleReconnect();
      }
    });

    peer.on('disconnected', () => {
      if (intentionallyLeaving) return;
      setStatus('offline', 'RECONNECTING');
      setLcdStatus('RECONNECTING');
      setFooter('Signal lost — reconnecting\u2026');
      if (!peer.destroyed) {
        try { peer.reconnect(); } catch (e) { scheduleReconnect(); }
      }
    });

    peer.on('close', () => {
      if (intentionallyLeaving) return;
      setStatus('offline', 'OFFLINE');
      setLcdStatus('CLOSED');
    });
  }

  // After our own peer opens, proactively try to reach the other slot —
  // whichever slot we're NOT in. If they're not there yet, peer-unavailable
  // fires (handled above) and we just wait; they'll call/connect to US once
  // they open, since we're already listening via peer.on('connection'/'call').
  function attemptConnectToOther() {
    const targetId = slotPeerId(otherSlot(mySlot));
    if (dataConn && dataConn.open) return; // already connected
    dataConn = peer.connect(targetId, { reliable: true });
    wireDataConnection();
    getMicStream()
      .then((stream) => {
        const call = peer.call(targetId, stream);
        wireMediaCall(call);
      })
      .catch(() => setFooter('Could not start voice call — mic permission required.'));
  }

  function onLocalPeerReady() {
    lcdMyId.textContent = 'room "' + roomCode + '"';
    setLcdStatus('WAITING');
    connectBtn.disabled = true;
    roomCodeField.disabled = true;
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
      if (roomCode) initPeerForRoom('a');
    }, delay);
  }

  function wireDataConnection() {
    dataConn.on('open', () => {
      reconnectAttempts = 0;
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
      } else if (msg === 'PING') {
        dataConn.send('PONG');
      }
    });

    dataConn.on('close', () => {
      setStatus('offline', 'OFFLINE');
      setLcdStatus('PEER LEFT');
      setFooter('Co-host disconnected — will reconnect automatically if they rejoin.');
      recordBtn.disabled = true;
      // Keep our own peer alive and listening so we auto-reconnect the
      // moment they come back, without needing to touch anything.
    });

    dataConn.on('error', (err) => {
      console.warn('Data connection error', err);
    });
  }

  // ---- Echo-loop prevention -------------------------------------------
  // Playing the co-host's voice through speakers while your own mic is
  // hot (and not using headphones) lets your mic pick the speaker output
  // back up — on both ends at once this builds into a loud feedback loop.
  // We can't detect "wearing headphones" directly, so we mitigate by:
  //   1. Starting the remote audio at a safer default volume, not 100%.
  //   2. Giving a persistent, easy mute toggle for the remote audio.
  //   3. Warning clearly, once, when the call connects.
  function wireMediaCall(call) {
    mediaCall = call;
    call.on('stream', (remoteStream) => {
      if (!remoteAudioEl) {
        remoteAudioEl = document.createElement('audio');
        remoteAudioEl.id = 'remoteAudioEl';
        remoteAudioEl.autoplay = true;
        remoteAudioEl.setAttribute('playsinline', '');
        remoteAudioEl.style.display = 'none';
        remoteAudioEl.volume = 0.7;
        document.body.appendChild(remoteAudioEl);
      }
      remoteAudioEl.srcObject = remoteStream;
      remoteAudioEl.muted = remoteMuted;
      setFooter('\u26a0 Use headphones if possible — playing your co-host through speakers while recording can cause a feedback loop.');
      showHeadphoneWarningOnce();
    });
    call.on('close', () => setFooter('Call ended.'));
    call.on('error', (err) => console.error('Media call error', err));
  }

  let headphoneWarningShown = false;
  function showHeadphoneWarningOnce() {
    if (headphoneWarningShown) return;
    headphoneWarningShown = true;
    const banner = document.getElementById('headphoneBanner');
    if (banner) banner.hidden = false;
  }

  function toggleRemoteMute() {
    remoteMuted = !remoteMuted;
    if (remoteAudioEl) remoteAudioEl.muted = remoteMuted;
    const muteBtn = document.getElementById('muteRemoteBtn');
    if (muteBtn) muteBtn.textContent = remoteMuted ? 'UNMUTE CO-HOST' : 'MUTE CO-HOST';
  }

  function joinRoom() {
    if (typeof Peer === 'undefined') {
      showLoadFailure();
      return;
    }
    if (!navigator.onLine) {
      setFooter('You appear to be offline — check your connection and try again.');
      return;
    }
    const code = slugifyRoomCode(roomCodeField.value);
    if (!code) {
      setFooter('Enter a room code first — anything you and your co-host both know.');
      return;
    }
    roomCode = code;
    intentionallyLeaving = false;
    const url = new URL(window.location.href);
    url.searchParams.set('room', roomCode);
    window.history.replaceState({}, '', url);

    setLcdStatus('CONNECTING\u2026');
    setFooter('Opening room\u2026');
    initPeerForRoom('a');
  }

  function leaveRoomCleanly() {
    intentionallyLeaving = true;
    try { if (dataConn) dataConn.close(); } catch (e) {}
    try { if (mediaCall) mediaCall.close(); } catch (e) {}
    try { if (peer) peer.destroy(); } catch (e) {}
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
      } else if (!triggeredByPeer && (!dataConn || !dataConn.open)) {
        setFooter('\u26a0 Recording locally only — co-host isn\u2019t connected right now.');
      }
    } catch (err) {
      console.error('Failed to start recording', err);
      setFooter('Could not start recording — check mic permissions.');
    }
  }

  function finishRecording(triggeredByPeer, micLost) {
    if (!isRecording) return;
    isRecording = false;
    spinReels(false);
    clearInterval(timerInterval);
    clearTimeout(ackTimeout);

    setStatus(dataConn && dataConn.open ? 'connected' : 'offline', dataConn && dataConn.open ? 'PEER LINKED' : 'OFFLINE');
    setLcdStatus('SAVING\u2026');
    recordBtn.disabled = false;
    stopBtn.disabled = true;
    if (!micLost) {
      setFooter(triggeredByPeer ? 'Co-host stopped the take.' : 'Recording stopped — encoding WAV\u2026');
    }

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
      if (micLost) setFooter('Mic was disconnected — saved what was recorded up to that point.');
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

  const muteRemoteBtn = document.getElementById('muteRemoteBtn');
  if (muteRemoteBtn) muteRemoteBtn.addEventListener('click', toggleRemoteMute);

  window.addEventListener('beforeunload', (e) => {
    if (isRecording) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // Clean deregistration so a closed tab doesn't leave a ghost peer ID
  // that blocks the next join. pagehide fires more reliably than
  // beforeunload on mobile browsers (especially iOS Safari).
  window.addEventListener('pagehide', leaveRoomCleanly);
  window.addEventListener('beforeunload', leaveRoomCleanly);

  // Network state changes — surface clearly instead of a silent hang.
  window.addEventListener('offline', () => {
    setStatus('offline', 'NO INTERNET');
    setLcdStatus('NO INTERNET');
    setFooter('You lost your internet connection — will retry once it\u2019s back.');
  });
  window.addEventListener('online', () => {
    setFooter('Back online — reconnecting\u2026');
    if (roomCode && (!peer || peer.destroyed || peer.disconnected)) {
      initPeerForRoom('a');
    }
  });

  // If the tab is backgrounded for a long time on mobile, some browsers
  // throttle timers/WebRTC. On return, do a lightweight liveness check.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && dataConn && dataConn.open) {
      try { dataConn.send('PING'); } catch (e) {}
    }
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
