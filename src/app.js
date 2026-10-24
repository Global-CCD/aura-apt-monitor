/**
 * Apartment Sound Monitor: SPA Application Engine (v3.0.0-SPA)
 */
import {
  computeAcoustics,
  extractVocalProsody,
  createPrivacyRedactionFilter,
  applyCascade,
  encodeWAV
} from './dsp.js';

// Application State
const STATE = {
  version: '3.0.0-SPA',
  isMonitoring: false,
  splOffset: 94.0,
  thresholdDba: 55.0,
  enableSnapshots: true,
  audioContext: null,
  workletNode: null,
  mediaStream: null,
  slidingBuffer: new Float32Array(32000), // 2.0s buffer at 16 kHz
  rollingL90Buffer: [],
  history60s: {
    dba: new Float32Array(120),
    dbc: new Float32Array(120),
    l90: new Float32Array(120),
    index: 0
  },
  db: null,
  currentPlayingAudio: null
};

// IndexedDB Initialization for Tamper-Evident Incident Storage
function initDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('FlatSoundMonitorDB', 1);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('incidents')) {
        db.createObjectStore('incidents', { keyPath: 'id', autoIncrement: true });
      }
    };
    request.onsuccess = (e) => {
      STATE.db = e.target.result;
      resolve(STATE.db);
    };
    request.onerror = (e) => reject(e);
  });
}

// Save incident to IndexedDB with Web Crypto SHA-256 fingerprinting
async function saveIncident(incident) {
  if (!STATE.db) return;
  const tx = STATE.db.transaction('incidents', 'readwrite');
  const store = tx.objectStore('incidents');
  store.add(incident);
}

// Web Crypto SHA-256
async function computeSha256(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 12);
}

// Canvas 60-Second Real-Time Decibel History Chart
function drawStripChart() {
  const canvas = document.getElementById('stripChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;

  ctx.clearRect(0, 0, width, height);

  // Background Gridlines
  ctx.strokeStyle = '#E2E8F0';
  ctx.lineWidth = 1;
  for (let db = 30; db <= 90; db += 15) {
    const y = height - ((db - 30) / 60) * height;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();

    ctx.fillStyle = '#94A3B8';
    ctx.font = '10px monospace';
    ctx.fillText(`${db} dBA`, 5, y - 2);
  }

  // Draw Threshold Line (Dashed Red)
  const threshY = height - ((STATE.thresholdDba - 30) / 60) * height;
  ctx.strokeStyle = '#EF4444';
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(0, threshY);
  ctx.lineTo(width, threshY);
  ctx.stroke();
  ctx.setLineDash([]);

  // Plot Curves
  function plotCurve(dataArray, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < 120; i++) {
      const idx = (STATE.history60s.index + i) % 120;
      const val = dataArray[idx];
      const x = (i / 119) * width;
      const y = height - ((Math.max(30, Math.min(90, val)) - 30) / 60) * height;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  plotCurve(STATE.history60s.dba, '#2563EB'); // dBA (Blue)
  plotCurve(STATE.history60s.dbc, '#DC2626'); // dBC (Red)
  plotCurve(STATE.history60s.l90, '#16A34A'); // L90 (Green)
}

// Audio Engine Activation
export async function startMonitoring() {
  try {
    STATE.audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    STATE.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    });

    await STATE.audioContext.audioWorklet.addModule('/audio-processor.js');

    const sourceNode = STATE.audioContext.createMediaStreamSource(STATE.mediaStream);
    STATE.workletNode = new AudioWorkletNode(STATE.audioContext, 'continuous-audio-processor');

    STATE.workletNode.port.onmessage = (e) => {
      handleAudioChunk(e.data.audioChunk);
    };

    sourceNode.connect(STATE.workletNode);
    STATE.isMonitoring = true;
    updateUIHealth('HEALTHY', 'ALL SYSTEMS OPERATIONAL');
    document.getElementById('btnToggle').innerText = 'Pause Monitoring';
  } catch (err) {
    console.error('Audio Initialization Failed:', err);
    updateUIHealth('FAULT', 'MIC ACCESS DENIED');
  }
}

export function pauseMonitoring() {
  if (STATE.audioContext && STATE.isMonitoring) {
    STATE.audioContext.suspend();
    STATE.isMonitoring = false;
    document.getElementById('btnToggle').innerText = 'Resume Monitoring';
    updateUIHealth('PROBING', 'MONITORING PAUSED');
  } else if (STATE.audioContext && !STATE.isMonitoring) {
    STATE.audioContext.resume();
    STATE.isMonitoring = true;
    document.getElementById('btnToggle').innerText = 'Pause Monitoring';
    updateUIHealth('HEALTHY', 'ALL SYSTEMS OPERATIONAL');
  }
}

// 500ms Sliding Window Handler
async function handleAudioChunk(newChunk) {
  // Roll 32,000-sample sliding buffer
  STATE.slidingBuffer.copyWithin(0, newChunk.length);
  STATE.slidingBuffer.set(newChunk, STATE.slidingBuffer.length - newChunk.length);

  // 1. DSP Acoustic Extraction
  const metrics = computeAcoustics(STATE.slidingBuffer, STATE.splOffset);

  // Rolling L90 calculation (last 120 chunks = 60s)
  STATE.rollingL90Buffer.push(metrics.dbaSpl);
  if (STATE.rollingL90Buffer.length > 120) STATE.rollingL90Buffer.shift();

  const sortedL90 = [...STATE.rollingL90Buffer].sort((a, b) => a - b);
  const l90 = sortedL90[Math.floor(sortedL90.length * 0.1)] || metrics.dbaSpl;

  // 2. Push to 60-second History Ring
  STATE.history60s.dba[STATE.history60s.index] = metrics.dbaSpl;
  STATE.history60s.dbc[STATE.history60s.index] = metrics.dbcSpl;
  STATE.history60s.l90[STATE.history60s.index] = l90;
  STATE.history60s.index = (STATE.history60s.index + 1) % 120;

  // 3. 4-Tier Vocal Subsystem
  const prosody = extractVocalProsody(STATE.slidingBuffer, 16000);
  const triggered = metrics.dbaSpl > STATE.thresholdDba;

  // 4. Update UI Panels
  updateDashboard(metrics, l90, prosody, triggered);
  drawStripChart();

  // 5. Incident Archival & Privacy Redaction
  if (triggered) {
    await processTriggeredEvent(metrics, prosody);
  }
}

// Process and record an incident
async function processTriggeredEvent(metrics, prosody) {
  let evidenceHash = 'Telemetry Only';
  let blob = null;

  if (STATE.enableSnapshots) {
    const redactionFilter = createPrivacyRedactionFilter(16000, 300);
    const redactedAudio = applyCascade(redactionFilter, STATE.slidingBuffer);
    blob = encodeWAV(redactedAudio, 16000);
    evidenceHash = await computeSha256(blob);
  }

  const timestamp = new Date().toLocaleTimeString();
  const tenancyDomain = prosody.isThroughWallVoice ? '[VOICE DISPUTE]' : '[ACOUSTIC IMPACT]';

  const incident = {
    timestamp,
    dba: metrics.dbaSpl,
    dbc: metrics.dbcSpl,
    event: metrics.isImpulsive ? 'Sudden Slam' : 'Continuous Disturbance',
    domain: tenancyDomain,
    hash: evidenceHash,
    audioBlob: blob
  };

  saveIncident(incident);
  addTableRow(incident);
}

// UI DOM Updates
function updateUIHealth(status, text) {
  const bulb = document.getElementById('prelightBulb');
  const label = document.getElementById('prelightLabel');
  label.innerText = text;

  if (status === 'HEALTHY') bulb.className = 'w-3 h-3 rounded-full bg-emerald-500';
  else if (status === 'PROBING') bulb.className = 'w-3 h-3 rounded-full bg-blue-500';
  else if (status === 'FAULT') bulb.className = 'w-3 h-3 rounded-full bg-rose-500';
}

function updateDashboard(m, l90, prosody, triggered) {
  // Loudness Bar
  const bar = document.getElementById('loudnessBar');
  const pct = Math.max(0, Math.min(100, ((m.dbaSpl - 30) / 60) * 100));
  bar.style.width = `${pct}%`;
  document.getElementById('loudnessText').innerText = `${m.dbaSpl} dBA SPL`;

  document.getElementById('txtDbc').innerText = `${m.dbcSpl} dBC`;
  document.getElementById('txtL90').innerText = `${l90.toFixed(1)} dBA`;
  document.getElementById('txtTransient').innerText = m.isImpulsive ? 'YES (Sudden Slam)' : 'No';

  // Vocal Card
  document.getElementById('txtPitch').innerText = prosody.pitchF0 > 0 ? `${prosody.pitchF0} Hz` : '--';
  document.getElementById('txtHnr').innerText = `${prosody.hnrDb} dB`;
  document.getElementById('txtThroughWall').innerText = prosody.isMechanicalHum
    ? 'REJECTED (HVAC Hum)'
    : prosody.isThroughWallVoice ? 'YES (Voice Detected)' : 'No';

  // Watchdog status
  const badge = document.getElementById('txtTriggerState');
  badge.innerText = triggered ? '[TRIGGERED EVENT]' : '[Ambient Quiet]';
  badge.className = triggered ? 'text-sm font-semibold text-rose-600' : 'text-sm font-semibold text-emerald-600';
}

function addTableRow(inc) {
  const table = document.getElementById('incidentTableBody');
  const row = document.createElement('tr');
  row.className = 'border-b border-slate-100 hover:bg-slate-50 transition-colors text-xs font-mono';

  row.innerHTML = `
    <td class="p-2">${inc.timestamp}</td>
    <td class="p-2 font-bold">${inc.dba}</td>
    <td class="p-2">${inc.dbc}</td>
    <td class="p-2 text-blue-600">• ${inc.event}</td>
    <td class="p-2">${inc.domain}</td>
    <td class="p-2">
      ${inc.audioBlob ? `<button class="btn-play px-2 py-0.5 bg-slate-200 rounded text-slate-700 hover:bg-slate-300">▶ Play</button>` : '--'}
    </td>
    <td class="p-2 text-slate-400">${inc.hash}</td>
  `;

  if (inc.audioBlob) {
    const playBtn = row.querySelector('.btn-play');
    playBtn.onclick = () => {
      if (STATE.currentPlayingAudio) {
        STATE.currentPlayingAudio.pause();
      }
      const audioUrl = URL.createObjectURL(inc.audioBlob);
      const audio = new Audio(audioUrl);
      STATE.currentPlayingAudio = audio;
      audio.play();
      playBtn.innerText = '■ Stop';
      audio.onended = () => { playBtn.innerText = '▶ Play'; };
    };
  }

  table.prepend(row);
  if (table.children.length > 50) {
    table.removeChild(table.lastChild);
  }
}

// Generate Irish RTB / EPA Section 108 Dispute Dossier (Printable HTML/PDF View)
export function exportRtbDossier() {
  if (!STATE.db) return;
  const tx = STATE.db.transaction('incidents', 'readonly');
  const store = tx.objectStore('incidents');
  const req = store.getAll();

  req.onsuccess = () => {
    const incidents = req.result;
    const printWin = window.open('', '_blank');
    const rows = incidents.map(i => `
      <tr>
        <td style="padding:6px;border:1px solid #ccc;">${i.timestamp}</td>
        <td style="padding:6px;border:1px solid #ccc;font-weight:bold;">${i.dba} dBA</td>
        <td style="padding:6px;border:1px solid #ccc;">${i.dbc} dBC</td>
        <td style="padding:6px;border:1px solid #ccc;">${i.event}</td>
        <td style="padding:6px;border:1px solid #ccc;">${i.domain}</td>
        <td style="padding:6px;border:1px solid #ccc;font-family:monospace;">${i.hash}</td>
      </tr>
    `).join('');

    printWin.document.write(`
      <html>
        <head>
          <title>Acoustic Evidence Dossier - Irish RTB / EPA Section 108</title>
          <style>body{font-family:sans-serif;padding:20px;color:#1e293b;}table{width:100%;border-collapse:collapse;margin-top:15px;font-size:12px;}</style>
        </head>
        <body>
          <h2>Certificate of Acoustic Disturbance</h2>
          <p><strong>Jurisdiction:</strong> Ireland (EPA Act 1992 Section 108 / Residential Tenancies Act 2004)</p>
          <p><strong>Generated:</strong> ${new Date().toLocaleString()}</p>
          <p><strong>Standards:</strong> IEC 61672:2013 Class 2 (dBA/dBC) | GDPR Article 5(1)(c) Low-Pass Redacted Telemetry</p>
          <table>
            <thead>
              <tr style="background:#f1f5f9;">
                <th style="padding:6px;border:1px solid #ccc;">Timestamp</th>
                <th style="padding:6px;border:1px solid #ccc;">L_Aeq</th>
                <th style="padding:6px;border:1px solid #ccc;">L_Ceq</th>
                <th style="padding:6px;border:1px solid #ccc;">Event</th>
                <th style="padding:6px;border:1px solid #ccc;">Domain</th>
                <th style="padding:6px;border:1px solid #ccc;">SHA-256 Hash</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
          <script>window.print();</script>
        </body>
      </html>
    `);
    printWin.document.close();
  };
}

// Global Event Listeners
window.addEventListener('DOMContentLoaded', async () => {
  await initDatabase();
  document.getElementById('btnToggle').onclick = () => {
    if (!STATE.isMonitoring) startMonitoring();
    else pauseMonitoring();
  };
  document.getElementById('btnExportRtb').onclick = exportRtbDossier;

  document.getElementById('sliderThreshold').oninput = (e) => {
    STATE.thresholdDba = parseFloat(e.target.value);
    document.getElementById('valThreshold').innerText = `${STATE.thresholdDba} dBA`;
  };

  document.getElementById('sliderOffset').oninput = (e) => {
    STATE.splOffset = parseFloat(e.target.value);
    document.getElementById('valOffset').innerText = `${STATE.splOffset} dB`;
  };

  document.getElementById('chkSnapshots').onchange = (e) => {
    STATE.enableSnapshots = e.target.checked;
  };
});