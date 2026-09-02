/* =========================================================
   DEZ — app.js
   Fully local, single-device audio recorder. No networking,
   no signaling server, no external services — nothing leaves
   this browser. Two people run this independently on a call
   (Zoom/Discord/phone) and use the on-screen 3-2-1 countdown
   (with an audible beep) to start recording at the same
   moment by eye/ear, then each downloads their own WAV file.

   Kept from the earlier version: Web Audio VU meter, real
   16-bit PCM WAV export (hand-written header, no MediaRecorder
   compression), and IndexedDB crash recovery.
   Removed: PeerJS, WebRTC data/media channels, room codes —
   all deleted, since they were the source of the connection
   bugs and also the only thing that ever touched the network.
   ========================================================= */

(() => {
  'use strict';

  // ---------- DOM refs ----------
  const $ = (id) => document.getElementById(id);

  const countdownBtn    = $('countdownBtn');
  const countdownOverlay= $('countdownOverlay');
  const countdownNumber = $('countdownNumber');
  const recordBtn       = $('recordBtn');
  const stopBtn         = $('stopBtn');
  const timeDisplay     = $('timeDisplay');
  const lcdStatus       = $('lcdStatus');
  const statusLed       = $('statusLed');
  const statusLedCaption= $('statusLedCaption');
  const vuNeedle        = $('vuNeedle');
  const reelLeft        = $('reelLeft');
  const reelRight       = $('reelRight');
  const footerMsg       = $('footerMsg');

  // ---------- State ----------
  let localStream = null;

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

      localStream.getAudioTracks().forEach((track) => {
        track.addEventListener('ended', () => {
          setFooter('\u26a0 Microphone disconnected — reconnect it and reload the page.');
          setLcdStatus('MIC LOST');
          setStatus('offline', 'MIC LOST');
          if (isRecording) finishRecording(true /* micLost */);
        });
      });

      setStatus('connected', 'MIC READY');
      setLcdStatus('READY');
      setFooter('Mic ready. Hop on a call with your co-host, then hit Countdown when you\u2019re both set.');
      recordBtn.disabled = false;
      countdownBtn.disabled = false;
      setupAudioGraph(localStream);
      return localStream;
    } catch (err) {
      console.error('getUserMedia failed', err);
      setStatus('offline', 'MIC ERROR');
      if (err && err.name === 'NotFoundError') {
        setFooter('No microphone found — plug one in and reload the page.');
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
  // 5. Countdown + beep sync helper
  //    Purely local: a visible 3-2-1 flash plus a short audible
  //    beep via an OscillatorNode, so both people (already on a
  //    voice call through some other app/phone) can start
  //    recording at the same instant by eye/ear. No data of any
  //    kind is sent anywhere — it's just UI + a tone.
  // =========================================================

  function beep(freq, durationMs) {
    if (!audioCtx) return;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = freq;
    osc.type = 'sine';
    gain.gain.value = 0.15;
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + durationMs / 1000);
  }

  function runCountdown() {
    if (!audioCtx) {
      setFooter('Allow microphone access first — the countdown uses the same audio engine.');
      return;
    }
    countdownBtn.disabled = true;
    countdownOverlay.hidden = false;
    let count = 3;
    countdownNumber.textContent = String(count);
    beep(660, 150);

    const step = () => {
      count--;
      if (count > 0) {
        countdownNumber.textContent = String(count);
        beep(660, 150);
        setTimeout(step, 1000);
      } else {
        countdownNumber.textContent = 'GO';
        beep(990, 250);
        setTimeout(() => {
          countdownOverlay.hidden = true;
          countdownBtn.disabled = false;
        }, 600);
      }
    };
    setTimeout(step, 1000);
  }

  // =========================================================
  // 6. Recording — real PCM capture
  // =========================================================

  async function beginRecording() {
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
      countdownBtn.disabled = true;
      setFooter('Recording\u2026 hit Stop & Download when you\u2019re done.');

      timerInterval = setInterval(() => {
        timeDisplay.textContent = formatTime(Date.now() - recordStartTime);
      }, 250);
    } catch (err) {
      console.error('Failed to start recording', err);
      setFooter('Could not start recording — check mic permissions.');
    }
  }

  function finishRecording(micLost) {
    if (!isRecording) return;
    isRecording = false;
    spinReels(false);
    clearInterval(timerInterval);

    setStatus('connected', 'MIC READY');
    setLcdStatus('SAVING\u2026');
    recordBtn.disabled = false;
    stopBtn.disabled = true;
    countdownBtn.disabled = false;
    if (!micLost) setFooter('Recording stopped — encoding WAV\u2026');

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

  countdownBtn.addEventListener('click', runCountdown);
  recordBtn.addEventListener('click', beginRecording);
  stopBtn.addEventListener('click', () => finishRecording(false));

  window.addEventListener('beforeunload', (e) => {
    if (isRecording) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // =========================================================
  // Boot
  // =========================================================

  setStatus('offline', 'MIC OFF');
  setLcdStatus('BOOTING\u2026');
  countdownBtn.disabled = true;
  getMicStream().catch(() => {});
  checkForRecoverableSession();

})();
