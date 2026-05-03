/**
 * YIN pitch detection — same algorithm and tuning as the Dan Tranh
 * Tuner / Air Dan Tranh: threshold = 0.15, RMS gate at 0.001, no
 * octave-disambiguation rule (proven counterproductive). Returns
 * { freq, confidence, rms } or null. Works for guitar fundamentals
 * E2 (~82 Hz) up through E6 (~1318 Hz) on standard mic input.
 */

class YinDetector {
  constructor(sampleRate, bufferSize = 2048) {
    this.sampleRate = sampleRate;
    this.bufferSize = bufferSize;
    this.threshold = 0.15;
    this.probabilityThreshold = 0.1;
    const half = bufferSize >> 1;
    this.yinBuf = new Float32Array(half);
    this.cmndf = new Float32Array(half);
  }

  detect(buffer) {
    if (buffer.length < this.bufferSize) return null;

    let rms = 0;
    for (let i = 0; i < buffer.length; i++) rms += buffer[i] * buffer[i];
    rms = Math.sqrt(rms / buffer.length);
    if (rms < 0.001) return null;
    const signalRms = rms;

    const half = this.bufferSize >> 1;

    for (let tau = 0; tau < half; tau++) {
      let sum = 0;
      for (let i = 0; i < half; i++) {
        const d = buffer[i] - buffer[i + tau];
        sum += d * d;
      }
      this.yinBuf[tau] = sum;
    }

    this.cmndf[0] = 1;
    let runningSum = 0;
    for (let tau = 1; tau < half; tau++) {
      runningSum += this.yinBuf[tau];
      this.cmndf[tau] = this.yinBuf[tau] / (runningSum / tau);
    }

    let tau = -1;
    for (let t = 2; t < half; t++) {
      if (this.cmndf[t] < this.threshold) {
        while (t + 1 < half && this.cmndf[t + 1] < this.cmndf[t]) t++;
        tau = t;
        break;
      }
    }

    if (tau === -1) {
      let minTau = 2;
      let minVal = this.cmndf[2];
      for (let t = 3; t < half; t++) {
        if (this.cmndf[t] < minVal) {
          minVal = this.cmndf[t];
          minTau = t;
        }
      }
      if (minVal > this.probabilityThreshold) return null;
      tau = minTau;
    }

    let refined = tau;
    if (tau > 0 && tau < half - 1) {
      const s0 = this.cmndf[tau - 1];
      const s1 = this.cmndf[tau];
      const s2 = this.cmndf[tau + 1];
      const denom = 2 * (2 * s1 - s2 - s0);
      if (denom !== 0) refined = tau + (s2 - s0) / denom;
    }

    const freq = this.sampleRate / refined;
    if (freq < 30 || freq > 4000) return null;

    const confidence = Math.max(0, Math.min(1, 1 - this.cmndf[tau]));
    return { freq, confidence, rms: signalRms };
  }
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function freqToNote(freq) {
  const midiFloat = 69 + 12 * Math.log2(freq / 440);
  const midi = Math.round(midiFloat);
  const cents = Math.round((midiFloat - midi) * 100);
  const pitchClass = NOTE_NAMES[((midi % 12) + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;
  return { pitchClass, octave, cents, midiFloat, midi };
}

function noteNameToMidi(name) {
  const m = String(name).trim().match(/^([A-Ga-g])([#b]?)(-?\d+)$/);
  if (!m) return null;
  const letter = m[1].toUpperCase();
  const acc = m[2];
  const oct = parseInt(m[3], 10);
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[letter];
  let pc = base + (acc === '#' ? 1 : acc === 'b' ? -1 : 0);
  return pc + (oct + 1) * 12;
}

function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function midiToName(midi) {
  const pc = NOTE_NAMES[((midi % 12) + 12) % 12];
  const oct = Math.floor(midi / 12) - 1;
  return { pitchClass: pc, octave: oct, label: `${pc}${oct}` };
}

window.YinDetector = YinDetector;
window.freqToNote = freqToNote;
window.noteNameToMidi = noteNameToMidi;
window.midiToFreq = midiToFreq;
window.midiToName = midiToName;
window.NOTE_NAMES = NOTE_NAMES;
