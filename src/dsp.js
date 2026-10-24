/**
 * Acoustic DSP & 4-Tier Vocal Subsystem Engine
 * Version: 3.0.0-SPA
 * Standards: IEC 61672:2013 (dBA/dBC), GDPR Article 5(1)(c) Low-Pass Redaction
 */

// Biquad Filter implementation for second-order sections (SOS)
export class Biquad {
  constructor(b0, b1, b2, a1, a2) {
    this.b0 = b0; this.b1 = b1; this.b2 = b2;
    this.a1 = a1; this.a2 = a2;
    this.x1 = 0; this.x2 = 0;
    this.y1 = 0; this.y2 = 0;
  }

  process(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }

  filterArray(signal) {
    const out = new Float32Array(signal.length);
    for (let i = 0; i < signal.length; i++) {
      out[i] = this.process(signal[i]);
    }
    return out;
  }
}

// IEC 61672:2013 Discrete Biquad Coefficients for fs = 16,000 Hz
export function createAWeightingCascade() {
  return [
    new Biquad(0.3542, -0.7084, 0.3542, -1.3732, 0.4496),
    new Biquad(1.0, 2.0, 1.0, -0.5471, 0.0748),
    new Biquad(0.5678, -0.5678, 0.0, -0.7932, 0.0)
  ];
}

export function createCWeightingCascade() {
  return [
    new Biquad(0.8924, -1.7848, 0.8924, -1.7812, 0.7884),
    new Biquad(1.0, 2.0, 1.0, -0.1978, 0.0098)
  ];
}

// 4th-Order Butterworth Low-Pass Filter (<300 Hz) for Tier 4 Speech Redaction
export function createPrivacyRedactionFilter(fs = 16000, fc = 300) {
  const w0 = 2 * Math.PI * fc / fs;
  const cosw0 = Math.cos(w0);
  const sinw0 = Math.sin(w0);

  function makeStage(Q) {
    const alpha = sinw0 / (2 * Q);
    const b0 = (1 - cosw0) / 2;
    const b1 = 1 - cosw0;
    const b2 = (1 - cosw0) / 2;
    const a0 = 1 + alpha;
    const a1 = -2 * cosw0;
    const a2 = 1 - alpha;
    return new Biquad(b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0);
  }

  // 4th-order cascade (two 2nd-order stages)
  return [makeStage(0.5411961), makeStage(1.306563)];
}

export function applyCascade(filters, input) {
  let cur = input;
  for (const f of filters) {
    cur = f.filterArray(cur);
  }
  return cur;
}

// Acoustic Metric Calculations
export function computeAcoustics(rawAudio, splOffset = 94.0) {
  const eps = 1e-9;
  const N = rawAudio.length;

  const aFilters = createAWeightingCascade();
  const cFilters = createCWeightingCascade();

  const audioA = applyCascade(aFilters, rawAudio);
  const audioC = applyCascade(cFilters, rawAudio);

  let sumRaw = 0, sumA = 0, sumC = 0, peak = 0;
  for (let i = 0; i < N; i++) {
    const val = rawAudio[i];
    sumRaw += val * val;
    sumA += audioA[i] * audioA[i];
    sumC += audioC[i] * audioC[i];
    const absVal = Math.abs(val);
    if (absVal > peak) peak = absVal;
  }

  const rmsRaw = Math.sqrt(sumRaw / N);
  const rmsA = Math.sqrt(sumA / N);
  const rmsC = Math.sqrt(sumC / N);

  const dbfsRaw = 20 * Math.log10(rmsRaw + eps);
  const dbaSpl = 20 * Math.log10(rmsA + eps) + splOffset;
  const dbcSpl = 20 * Math.log10(rmsC + eps) + splOffset;

  const crestFactor = peak / (rmsRaw + eps);
  const isImpulsive = crestFactor > 4.8 && dbfsRaw > -55.0;

  return {
    dbfsRaw: Math.round(dbfsRaw * 10) / 10,
    dbaSpl: Math.round(dbaSpl * 10) / 10,
    dbcSpl: Math.round(dbcSpl * 10) / 10,
    crestFactor: Math.round(crestFactor * 100) / 100,
    isImpulsive
  };
}

// Pitch (F0) & Anti-HVAC Mechanical Rejection
export function extractVocalProsody(audio, sampleRate = 16000) {
  const N = audio.length;
  const minLag = Math.floor(sampleRate / 350); // 350 Hz upper limit
  const maxLag = Math.floor(sampleRate / 75);  // 75 Hz lower limit
  const eps = 1e-9;

  let zeroLag = 0;
  for (let i = 0; i < N; i++) {
    zeroLag += audio[i] * audio[i];
  }

  let bestLag = -1;
  let maxCorr = -1;

  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0;
    for (let i = 0; i < N - lag; i++) {
      corr += audio[i] * audio[i + lag];
    }
    if (corr > maxCorr) {
      maxCorr = corr;
      bestLag = lag;
    }
  }

  const normCorr = zeroLag > 0 ? maxCorr / zeroLag : 0;
  const pitchF0 = normCorr > 0.30 && bestLag > 0 ? sampleRate / bestLag : 0;
  const noiseEnergy = Math.max(eps, zeroLag - maxCorr);
  const hnrDb = 10 * Math.log10((maxCorr + eps) / noiseEnergy);

  // Anti-HVAC check: Single-tone compressor hum rejection
  const isMechanicalHum = normCorr > 0.90 && pitchF0 < 150.0;
  const isThroughWallVoice = pitchF0 >= 80.0 && pitchF0 <= 320.0 && hnrDb > 2.8 && !isMechanicalHum;

  return {
    pitchF0: Math.round(pitchF0 * 10) / 10,
    hnrDb: Math.round(hnrDb * 10) / 10,
    isThroughWallVoice,
    isMechanicalHum
  };
}

// 16-Bit PCM WAV File Encoder
export function encodeWAV(samples, sampleRate = 16000) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  function writeString(offset, string) {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // Mono channel
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true); // 16-bit
  writeString(36, 'data');
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }

  return new Blob([buffer], { type: 'audio/wav' });
}