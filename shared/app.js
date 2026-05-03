/**
 * Guitar Tuner — vanilla JS port of the Air Dan Tranh tuner aesthetic.
 *
 * Sensitivity & detection: identical YIN parameters (threshold 0.15,
 * RMS gate 0.001, single-frame outlier reject ±6 semis with a 3-frame
 * unstick streak, no median smoothing). Trail rendering: per-string
 * rows, neon green stroke layered four ways (corona / mid / body /
 * core), opacity = dB-loudness × age² fade.
 *
 * Layout adds the guitar-specific orientations:
 *   horizontal — strings run left↔right (standard tuner look)
 *   vertical   — strings run top↕bottom (90° rotation, fretboard-on-
 *                stand look). Defaults: thicker on TOP for horizontal,
 *                thicker on LEFT for vertical.
 *
 * Multi-neck (double-headed) is rendered as two stacked panels sharing
 * the live pitch — each neck's nearest-string mapping is independent
 * so unison-pair courses on a 12-string can show their two trails on
 * adjacent rows.
 */

const IN_TUNE_CENTS = 5;
const TRAIL_SECONDS = 4;
// Trail color is brand-themed via window.APP_DEFAULTS.themeHue at
// init time. Defaults match the original guitar green; a brand entry
// (UkuleleTuner, ViolinTuner, ...) overrides themeHue and these get
// recomputed before rendering starts. Mutable on purpose so HSL
// derivation in init() can update them without a full pipeline rewrite.
let TRAIL_RGB = '74, 222, 128';        // base saturated trail
let TRAIL_RGB_INTUNE = '134, 239, 172'; // brighter inside ±5¢

/** Convert HSL → "R, G, B" string (used by canvas rgba()). */
function hslToRgbString(h, s, l) {
  s = s / 100; l = l / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = ((h % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs(hp % 2 - 1));
  let r1 = 0, g1 = 0, b1 = 0;
  if (hp < 1) { r1 = c; g1 = x; }
  else if (hp < 2) { r1 = x; g1 = c; }
  else if (hp < 3) { g1 = c; b1 = x; }
  else if (hp < 4) { g1 = x; b1 = c; }
  else if (hp < 5) { r1 = x; b1 = c; }
  else { r1 = c; b1 = x; }
  const m = l - c / 2;
  const r = Math.round((r1 + m) * 255);
  const g = Math.round((g1 + m) * 255);
  const b = Math.round((b1 + m) * 255);
  return `${r}, ${g}, ${b}`;
}

/** Apply a theme hue across CSS vars and trail RGBs. Idempotent. */
function applyThemeHue(hue) {
  const root = document.documentElement;
  root.style.setProperty('--theme-hue', String(hue));
  // Saturation/lightness chosen to match the original green at H=141:
  //   #4ade80 ≈ hsl(141, 71%, 58%)   ← TRAIL_RGB
  //   #86efac ≈ hsl(141, 76%, 73%)   ← TRAIL_RGB_INTUNE
  TRAIL_RGB = hslToRgbString(hue, 71, 58);
  TRAIL_RGB_INTUNE = hslToRgbString(hue, 76, 73);
}
const ROW_FILL = 0.8;
const MAX_VIEW_CENTS = 80;
// Loosened from -40 → -55 because acoustic-guitar plucks (especially
// low E) often land around -50 dBFS at the mic on desktop; at the old
// floor YIN would detect (the readout updates) but every trail point
// got alpha=0 and nothing drew. -55 keeps a 5 dB margin above the YIN
// RMS gate (~-60 dBFS) so points only fade out at near-silence.
const DB_FLOOR = -55;
const DB_CEIL = -15;
const STABLE_WINDOW_MS = 1500;
const OUTLIER_REJECT_SEMIS = 6;
const OUTLIER_REJECT_STREAK_LIMIT = 3;

/** Cents → vertical offset within a row, in pixels.
 *  · Normal: linear in cents, clamped to ±MAX_VIEW_CENTS = ±80¢.
 *  · Locked-active: piecewise — inner ±80¢ gets the inner half of
 *    rowHalf (linear, fine pluck-tuning detail), outer ±80…2400¢ gets
 *    the outer half (log scale). So D4 played as D3 (-1200¢) and D2
 *    (-2400¢) draw at clearly different positions instead of both
 *    clamping at the edge. ±octave deviations stay distinguishable. */
const MAX_VIEW_CENTS_LOCKED = 2400;
function trailOffset(cents, rowHalf, locked) {
  if (!locked) {
    const c = Math.max(-MAX_VIEW_CENTS, Math.min(MAX_VIEW_CENTS, cents));
    return (c / MAX_VIEW_CENTS) * rowHalf;
  }
  const sign = cents < 0 ? -1 : 1;
  const a = Math.abs(cents);
  if (a <= MAX_VIEW_CENTS) {
    return sign * (a / MAX_VIEW_CENTS) * 0.5 * rowHalf;
  }
  const aClamp = Math.min(a, MAX_VIEW_CENTS_LOCKED);
  const t =
    Math.log2(aClamp / MAX_VIEW_CENTS) /
    Math.log2(MAX_VIEW_CENTS_LOCKED / MAX_VIEW_CENTS);
  return sign * (0.5 + t * 0.5) * rowHalf;
}

function rmsToAlpha(rms) {
  if (rms <= 0) return 0;
  const db = 20 * Math.log10(rms);
  const t = (db - DB_FLOOR) / (DB_CEIL - DB_FLOOR);
  return Math.max(0, Math.min(1, t));
}

function isIOS() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/iPad|iPhone|iPod/i.test(ua)) return true;
  return navigator.platform === 'MacIntel' &&
    typeof navigator.maxTouchPoints === 'number' &&
    navigator.maxTouchPoints > 1;
}

// ---------- Application state ----------

const state = {
  orientation: 'horizontal',          // 'horizontal' | 'vertical'
  thickFirst: true,                   // horizontal: thick on top; vertical: thick on left
  spacing: 'even',                    // 'even' | 'pair' | 'cents'
  leftHanded: false,                  // mirrors the guitar diagram across its long axis (a real lefty guitar)
  /** Map<neckIdx, stringIndex> — when set, routeTrail forces every
   *  pitch detection to that specific string instead of picking the
   *  closest match. Required for octave pairs in even/pair mode where
   *  the closest-pitch logic can't tell which string of a 12-string
   *  course you intend to tune. */
  activeStringByNeck: new Map(),
  category: 'six',
  tuningId: 'standard',
  /** When category === 'doubleHeaded', each entry picks one neck's
   *  guitar type + preset. Lets you do "Neck A: Drop D 6 / Neck B:
   *  DADGAD 6" or any 6/7/8/12 combo on either side. */
  neckPickers: null,
  customNecks: null,                  // [{ label, strings: [...] }] when user customizes (overrides catalog)
  necks: null,                        // resolved [{ label, strings: ['E2',...] }]
  liveTrails: new Map(),              // global key "neck:idx" -> trail points
  pitch: null,
  stablePitch: null,
  stableSamples: [],
  detector: null,
  audioCtx: null,
  analyser: null,
  micStream: null,
  micGain: null,
  micReady: false,
  micError: null,
  micStarting: false,
  rafId: 0,
  drawRafId: 0,
  lastEmittedMidi: null,
  outlierStreak: 0,
};

function resolveTuning() {
  if (state.customNecks) {
    state.necks = state.customNecks.map((n) => ({
      label: n.label,
      strings: n.strings.slice(),
      category: n.category,
    }));
    return;
  }
  const cat = window.TUNING_CATALOG[state.category];
  if (!cat) return;

  if (state.category === 'doubleHeaded') {
    if (!state.neckPickers || state.neckPickers.length !== 2) {
      state.neckPickers = [
        { category: 'twelve', tuningId: 'standard-12' },
        { category: 'six', tuningId: 'standard' },
      ];
    }
    state.necks = state.neckPickers.map((pick, i) => {
      const c = window.TUNING_CATALOG[pick.category];
      const t = c && c.tunings ? c.tunings[pick.tuningId] : null;
      const strings = t && t.strings ? t.strings.slice() : ['E2', 'A2', 'D3', 'G3', 'B3', 'E4'];
      const tuningLabel = t ? t.label : 'Standard';
      return {
        label: `Neck ${String.fromCharCode(65 + i)} · ${tuningLabel}`,
        strings,
        category: pick.category,
      };
    });
    return;
  }

  if (!cat.tunings) return;
  const t = cat.tunings[state.tuningId];
  if (!t) return;
  if (t.necks) {
    state.necks = t.necks.map((n) => ({
      label: n.label,
      strings: n.strings.slice(),
      category: state.category,
    }));
  } else {
    state.necks = [{ label: cat.label, strings: t.strings.slice(), category: state.category }];
  }
}

function inferBodyShape(category) {
  if (!category) return 'figure8';
  if (category === 'mandolin' || category === 'mandola') return 'teardrop';
  if (category === 'banjo' || category === 'banjo4') return 'round';
  if (
    category === 'violin' || category === 'violin5' ||
    category === 'fiddle' || category === 'fiddle5' ||
    category === 'viola' || category === 'viola5' ||
    category === 'cello' || category === 'cello5' ||
    category === 'bass' || category === 'bass5' || category === 'bass6'
  ) return 'hourglass';
  return 'figure8';
}

/** Bowed-string instruments don't have frets — the diagram should
 *  skip the fret loop and the "fingerboard" surface stays smooth. */
const BOWED_CATEGORIES = new Set([
  'violin', 'violin5', 'fiddle', 'fiddle5',
  'viola', 'viola5', 'cello', 'cello5',
  'bass', 'bass5', 'bass6',
]);
function isBowedCategory(c) { return BOWED_CATEGORIES.has(c); }

function totalStringCount() {
  return state.necks.reduce((s, n) => s + n.strings.length, 0);
}

/**
 * True when consecutive string pairs share a pitch class — i.e. the
 * tuning is actually course-based (12-string standard, 8-string Taro
 * Patch ukulele, 6-string Liliʻu, etc). 6-string and 7-string guitars
 * return false even though their string counts could be paired:
 * EADGBE has no consecutive pitch-class match. Used to decide whether
 * "Pair" spacing has any visual meaning for a given neck — when it
 * doesn't, we silently fall back to even spacing.
 */
function isPairedTuning(strings) {
  if (strings.length < 4 || strings.length % 2 !== 0) return false;
  for (let i = 0; i < strings.length; i += 2) {
    const m1 = window.noteNameToMidi(strings[i]);
    const m2 = window.noteNameToMidi(strings[i + 1]);
    if (m1 == null || m2 == null) return false;
    if ((((m1 - m2) % 12) + 12) % 12 !== 0) return false;
  }
  return true;
}

// ---------- DOM ----------

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function buildCategorySelect() {
  const sel = $('#category');
  sel.innerHTML = '';
  for (const [id, c] of Object.entries(window.TUNING_CATALOG)) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = c.label;
    sel.appendChild(opt);
  }
  sel.value = state.category;
}

function buildTuningSelect() {
  const sel = $('#tuning');
  const wrap = sel.closest('.ctrl');
  sel.innerHTML = '';
  const cat = window.TUNING_CATALOG[state.category];
  if (!cat || !cat.tunings) {
    if (wrap) wrap.style.display = 'none';
    return;
  }
  if (wrap) wrap.style.display = '';
  for (const [id, t] of Object.entries(cat.tunings)) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = t.label;
    sel.appendChild(opt);
  }
  sel.value = state.tuningId;
}

function buildNeckPickers() {
  const host = $('#neck-pickers');
  host.innerHTML = '';
  if (state.category !== 'doubleHeaded') {
    host.style.display = 'none';
    return;
  }
  host.style.display = '';

  const singleNeckCats = [
    'six', 'seven', 'eight', 'twelve',
    'ukulele', 'ukulele6', 'ukulele8',
    'mandolin', 'mandola', 'banjo', 'banjo4',
    'violin', 'violin5', 'fiddle', 'fiddle5',
    'viola', 'viola5', 'cello', 'cello5',
    'bass', 'bass5', 'bass6',
  ];

  state.neckPickers.forEach((pick, neckIdx) => {
    const block = document.createElement('div');
    block.className = 'neck-pick';

    const tag = document.createElement('span');
    tag.className = 'neck-pick__tag';
    tag.textContent = `Neck ${String.fromCharCode(65 + neckIdx)}`;
    block.appendChild(tag);

    const typeSel = document.createElement('select');
    typeSel.className = 'neck-pick__sel';
    singleNeckCats.forEach((c) => {
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = window.TUNING_CATALOG[c].label;
      typeSel.appendChild(opt);
    });
    typeSel.value = pick.category;
    block.appendChild(typeSel);

    const tuningSel = document.createElement('select');
    tuningSel.className = 'neck-pick__sel';
    const populateTunings = (catId) => {
      tuningSel.innerHTML = '';
      const cat = window.TUNING_CATALOG[catId];
      Object.entries(cat.tunings).forEach(([id, t]) => {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = t.label;
        tuningSel.appendChild(opt);
      });
      tuningSel.value =
        pick.tuningId in cat.tunings ? pick.tuningId : Object.keys(cat.tunings)[0];
      pick.tuningId = tuningSel.value;
    };
    populateTunings(pick.category);
    block.appendChild(tuningSel);

    typeSel.addEventListener('change', () => {
      pick.category = typeSel.value;
      pick.tuningId = Object.keys(window.TUNING_CATALOG[pick.category].tunings)[0];
      populateTunings(pick.category);
      state.customNecks = null;
      state.liveTrails.clear();
      renderAll();
      applyAutoSpacing();
    });
    tuningSel.addEventListener('change', () => {
      pick.tuningId = tuningSel.value;
      state.customNecks = null;
      state.liveTrails.clear();
      renderAll();
      applyAutoSpacing();
    });

    host.appendChild(block);
  });
}

function buildStringEditor() {
  const host = $('#string-editor');
  host.innerHTML = '';
  if (!state.necks) return;

  /** Build one string input wired to (neckIdx, stringIdx). Factored
   *  out so paired-course rendering can reuse the same input handler
   *  without duplicating the closure-capture / change wiring. */
  const buildOneInput = (neckIdx, stringIdx, noteName) => {
    const wrap = document.createElement('div');
    wrap.className = 'string-edit';
    const tag = document.createElement('span');
    tag.className = 'string-edit__tag';
    tag.textContent = `S${stringIdx + 1}`;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = noteName;
    input.spellcheck = false;
    input.addEventListener('change', () => {
      const v = input.value.trim();
      if (window.noteNameToMidi(v) === null) {
        input.classList.add('bad');
        return;
      }
      input.classList.remove('bad');
      if (!state.customNecks) {
        state.customNecks = state.necks.map((n) => ({
          label: n.label,
          strings: n.strings.slice(),
          category: n.category,
        }));
      }
      state.customNecks[neckIdx].strings[stringIdx] = v;
      state.necks[neckIdx].strings[stringIdx] = v;
      state.liveTrails.clear();
      // No renderAll — keeps focus stable so tabbing through 12-string
      // inputs doesn't skip rows.
    });
    wrap.appendChild(tag);
    wrap.appendChild(input);
    return wrap;
  };

  state.necks.forEach((neck, neckIdx) => {
    const block = document.createElement('div');
    block.className = 'neck-edit';
    const h = document.createElement('div');
    h.className = 'neck-edit__label';
    h.textContent = neck.label;
    block.appendChild(h);

    const paired = isPairedTuning(neck.strings);
    const rows = document.createElement('div');
    rows.className = paired ? 'neck-edit__courses' : 'neck-edit__rows';

    if (paired) {
      // One row per course; left input = string n (octave/companion),
      // right = string n+1 (fundamental). The "C#" tag makes the
      // pairing obvious so editing S1 stays clearly the first string
      // of the first course instead of getting lost in a 12-cell grid.
      const courses = neck.strings.length / 2;
      for (let c = 0; c < courses; c++) {
        const course = document.createElement('div');
        course.className = 'course';
        const ctag = document.createElement('span');
        ctag.className = 'course__tag';
        ctag.textContent = `C${c + 1}`;
        course.appendChild(ctag);
        course.appendChild(buildOneInput(neckIdx, c * 2, neck.strings[c * 2]));
        course.appendChild(buildOneInput(neckIdx, c * 2 + 1, neck.strings[c * 2 + 1]));
        rows.appendChild(course);
      }
    } else {
      neck.strings.forEach((noteName, i) => {
        rows.appendChild(buildOneInput(neckIdx, i, noteName));
      });
    }
    block.appendChild(rows);
    host.appendChild(block);
  });
}

function setOrientation(o) {
  state.orientation = o;
  document.body.dataset.orientation = o;
  $$('#orientation .seg').forEach((b) => b.classList.toggle('active', b.dataset.value === o));
  renderAll();
}
function setThickFirst(b) {
  state.thickFirst = b;
  $$('#thick-side .seg').forEach((s) => s.classList.toggle('active', s.dataset.value === (b ? '1' : '0')));
  renderAll();
}
function setSpacing(s) {
  state.spacing = s;
  $$('#spacing .seg').forEach((b) => b.classList.toggle('active', b.dataset.value === s));
  renderAll();
}

/** Auto-pick the default spacing whenever the loaded tuning changes:
 *  paired tunings (12-string, Taro Patch, Liliʻu) → pair mode so the
 *  octave/unison courses cluster as visual pairs out of the box;
 *  everything else → even. Cents is treated as an explicit user
 *  preference and never auto-overridden. */
function applyAutoSpacing() {
  if (state.spacing === 'cents') return;
  const hasPaired =
    state.necks && state.necks.some((neck) => isPairedTuning(neck.strings));
  const target = hasPaired ? 'pair' : 'even';
  if (state.spacing !== target) setSpacing(target);
}
function setHand(h) {
  state.leftHanded = h === 'left';
  $$('#hand .seg').forEach((b) => b.classList.toggle('active', b.dataset.value === h));
}

// ---------- Layout: per-neck Y-positions in cents space ----------

function neckLayout(neck) {
  // Convert each string to midi-float, dedupe identical pitches with a
  // tiny epsilon so the layout doesn't collapse them on top of each
  // other (matters for 12-string pairs whose octave-1 strings land on
  // the SAME pitch — kept distinct as adjacent rows).
  const pitches = neck.strings.map((s) => {
    const m = window.noteNameToMidi(s);
    return m == null ? null : m;
  });

  // Build a sorted index list (low pitch first) and track each
  // string's original index, so we can render strings ordered by pitch
  // OR by the user's chosen "thick first" ordering.
  return pitches.map((p, idx) => ({ midi: p, stringIndex: idx, name: neck.strings[idx] }));
}

function pitchToFraction(midi, allMidis) {
  // Cents-spaced normalisation across [0..1] for one neck.
  const lo = Math.min(...allMidis);
  const hi = Math.max(...allMidis);
  if (hi === lo) return 0.5;
  return (midi - lo) / (hi - lo);
}

// ---------- Mic + detection loop ----------

async function startMic() {
  if (state.micReady || state.micStarting) return;
  state.micStarting = true;
  $('#mic-status').textContent = 'Starting mic…';
  $('#mic-status').classList.remove('error');
  try {
    const constraints = isIOS()
      ? { audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }
      : { audio: true };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    // Window size scales to the tuning's lowest fundamental:
    //   · Guitar / uke / mandolin / violin / viola / cello → 4096 ≈
    //     85 ms. Gives ≥3.5 periods of guitar E2 (82 Hz) — the floor
    //     case for these instruments — comfortably above YIN's 2-period
    //     minimum.
    //   · Bass family (E1 ≈ 41 Hz, B0 ≈ 31 Hz on 5/6-string) → 8192 ≈
    //     170 ms. 4096 only holds 1.7–2.0 periods of B0 / 3.5 of E1;
    //     8192 gives 5.3 periods of B0 and 7.0 of E1. Detection
    //     latency doubles but stays under 200 ms — acceptable for the
    //     long sustain of bass / cello bowing or plucked decay.
    const range = tuningFreqRange();
    analyser.fftSize = range.minHz < 60 ? 8192 : 4096;
    const gain = ctx.createGain();
    // 2× on desktop because acoustic-guitar low-string plucks land
    // ~10 dB quieter than dan tranh metal strings; previous 1× left
    // the trail invisible on most laptop mics. Loud plucks may clip
    // here — analytically harmless for YIN (clipped harmonic-rich
    // signals still expose the fundamental) and the visibility win
    // on quiet plucks far outweighs occasional clipping.
    gain.gain.value = isIOS() ? 16 : 2;
    src.connect(gain);
    gain.connect(analyser);

    state.audioCtx = ctx;
    state.analyser = analyser;
    state.micStream = stream;
    state.micGain = gain;
    state.detector = new window.YinDetector(ctx.sampleRate, analyser.fftSize);
    state.detector.threshold = 0.15;
    state.micReady = true;
    state.micError = null;

    detectionLoop();
    $('#mic-status').textContent = 'Listening — pluck a string';
    $('#mic-status').classList.remove('error');
  } catch (e) {
    state.micError = e instanceof Error ? e.message : String(e);
    $('#mic-status').textContent = 'Mic error — ' + state.micError + ' · click anywhere to retry';
    $('#mic-status').classList.add('error');
  } finally {
    state.micStarting = false;
  }
}

/**
 * Expected fundamental-frequency range for the current tuning. Used
 * to catch YIN's classic octave-up flips on guitar low strings: the
 * 2nd harmonic of E2 (~165 Hz) is often louder than the fundamental
 * (~82 Hz) for the first 100 ms of the pluck, so YIN's first-below-
 * threshold scan can latch onto τ=P/2 and report E3 instead of E2.
 *
 * The fix below halves any detection that lands above maxFreq×1.5
 * (one octave above what's reachable on this tuning, plus a tolerance
 * for bends). Halving is repeated up to 3 times so even a 4×-flipped
 * detection (rare but seen) gets corrected.
 */
/**
 * Snap a detected midi value to the nearest expected string pitch
 * across ±octave shifts.
 *
 * When a detection lands close to ANY tuning string (within ±1.5
 * semis), accept it as-is — that's a real reading, possibly mid-bend
 * or mid-vibrato. When it lands FAR from every string, try ±1 / ±2
 * octave shifts and use whichever shifted version is closest. This
 * catches the residual YIN octave flips that survive the high-Hz
 * halving in tuningFreqRange — flips that land back inside the
 * tuning's frequency range but on a non-string pitch (e.g., 6-string
 * E2 plucked but YIN locks E3, which sits 2 semis from D3 / G3 with
 * no real string at 52).
 */
function snapToNearestStringOctave(midiFloat) {
  if (!state.necks) return midiFloat;
  const expected = [];
  state.necks.forEach((neck) => {
    neck.strings.forEach((s) => {
      const m = window.noteNameToMidi(s);
      if (m != null) expected.push(m);
    });
  });
  if (expected.length === 0) return midiFloat;
  let directDist = Infinity;
  for (const e of expected) {
    const d = Math.abs(midiFloat - e);
    if (d < directDist) directDist = d;
  }
  // 1.5 semis ≈ wider than vibrato or pluck-attack jitter, narrower
  // than even the smallest inter-string gap on a 12-string.
  if (directDist <= 1.5) return midiFloat;
  let bestMidi = midiFloat;
  let bestDist = directDist;
  for (const oct of [-2, -1, 1, 2]) {
    const shifted = midiFloat + oct * 12;
    for (const e of expected) {
      const d = Math.abs(shifted - e);
      if (d < bestDist) { bestDist = d; bestMidi = shifted; }
    }
  }
  return bestMidi;
}

function tuningFreqRange() {
  if (!state.necks) return { minHz: 60, maxHz: 1500 };
  let minM = Infinity, maxM = -Infinity;
  state.necks.forEach((neck) => {
    neck.strings.forEach((s) => {
      const m = window.noteNameToMidi(s);
      if (m == null) return;
      if (m < minM) minM = m;
      if (m > maxM) maxM = m;
    });
  });
  if (!isFinite(minM)) return { minHz: 60, maxHz: 1500 };
  // ±4 semis margin for bends / mistuned strings.
  const minHz = window.midiToFreq(minM - 4);
  const maxHz = window.midiToFreq(maxM + 4);
  return { minHz, maxHz };
}

function detectionLoop() {
  const buf = new Float32Array(state.analyser.fftSize);
  const tick = () => {
    if (!state.analyser) return;
    state.analyser.getFloatTimeDomainData(buf);
    const raw = state.detector.detect(buf);
    const now = performance.now();

    let result = raw;
    if (result) {
      const { minHz, maxHz } = tuningFreqRange();
      // Octave-UP correction: halve until we're under maxHz, up to 3
      // halvings (covers up to a 8× flip — vastly more than YIN ever
      // produces in practice but cheap to allow).
      let f = result.freq;
      let halvings = 0;
      while (f > maxHz && halvings < 3) {
        f /= 2;
        halvings++;
      }
      if (f < minHz / 2 || f > maxHz * 2) {
        result = null;
      } else if (halvings > 0) {
        result = { ...result, freq: f };
      }
    }

    if (result) {
      const midiFloatRaw = 69 + 12 * Math.log2(result.freq / 440);
      const midiFloat = snapToNearestStringOctave(midiFloatRaw);
      // Keep freq aligned with the snapped midi so the readout's
      // freqToNote() display agrees with the rest of the pipeline.
      if (midiFloat !== midiFloatRaw) {
        result = {
          ...result,
          freq: result.freq * Math.pow(2, (midiFloat - midiFloatRaw) / 12),
        };
      }
      if (
        state.lastEmittedMidi !== null &&
        Math.abs(midiFloat - state.lastEmittedMidi) > OUTLIER_REJECT_SEMIS &&
        state.outlierStreak < OUTLIER_REJECT_STREAK_LIMIT
      ) {
        state.outlierStreak++;
      } else {
        state.outlierStreak = 0;
        state.lastEmittedMidi = midiFloat;
        const p = {
          freq: result.freq,
          confidence: result.confidence,
          midiFloat,
          rms: result.rms,
          at: now,
        };
        state.pitch = p;
        pushStable(p);
        routeTrail(p);
      }
    } else {
      state.lastEmittedMidi = null;
      state.outlierStreak = 0;
      state.pitch = null;
    }
    state.rafId = requestAnimationFrame(tick);
  };
  state.rafId = requestAnimationFrame(tick);
}

function pushStable(p) {
  const arr = state.stableSamples;
  arr.push(p);
  const cutoff = p.at - STABLE_WINDOW_MS;
  while (arr.length > 0 && arr[0].at < cutoff) arr.shift();
  const buckets = new Map();
  for (const s of arr) {
    const key = Math.round(s.midiFloat * 10);
    let e = buckets.get(key);
    if (!e) {
      e = { count: 0, sumMidi: 0, sumRms: 0, lastT: 0, freqAtLast: 0 };
      buckets.set(key, e);
    }
    e.count++;
    e.sumMidi += s.midiFloat;
    e.sumRms += s.rms;
    if (s.at > e.lastT) {
      e.lastT = s.at;
      e.freqAtLast = s.freq;
    }
  }
  let best = null;
  for (const e of buckets.values()) {
    if (!best || e.count > best.count || (e.count === best.count && e.lastT > best.lastT)) {
      best = e;
    }
  }
  if (best) {
    state.stablePitch = {
      freq: best.freqAtLast,
      midiFloat: best.sumMidi / best.count,
      rms: best.sumRms / best.count,
      at: best.lastT,
    };
  }
}

function routeTrail(p) {
  // For each neck, find the destination string and append a trail
  // point on its row. If the user has explicitly selected an active
  // string (click-to-select on the canvas), every detection routes to
  // THAT string regardless of which other string is closer in pitch —
  // this is what makes octave-pair tuning work in even/pair mode,
  // where the closest-pitch heuristic can land on the wrong row of
  // the same course. Otherwise fall back to closest-pitch matching.
  state.necks.forEach((neck, neckIdx) => {
    const layout = neckLayout(neck);
    const candidates = activeCandidates(neckIdx, neck);
    const pool = candidates
      ? candidates.map((idx) => layout[idx]).filter((s) => s && s.midi != null)
      : layout.filter((s) => s.midi != null);
    let chosen = null;
    let bestD = Infinity;
    for (const s of pool) {
      const d = Math.abs(s.midi - p.midiFloat);
      if (d < bestD) { bestD = d; chosen = s; }
    }
    if (!chosen) return;
    const centsOff = Math.round((p.midiFloat - chosen.midi) * 100);
    const key = `${neckIdx}:${chosen.stringIndex}`;
    let trail = state.liveTrails.get(key);
    if (!trail) { trail = []; state.liveTrails.set(key, trail); }
    trail.push({
      t: p.at,
      centsOff,
      inTune: Math.abs(centsOff) <= IN_TUNE_CENTS,
      rms: p.rms,
    });
    if (trail.length > 300) trail.shift();
  });
}

// ---------- Drawing ----------

/** Last-rendered layout per neck — keyed by neckIdx. Click handlers
 *  on the canvas read from this to figure out which row was hit. */
const panelLayouts = new Map();

/** Click on a string-panel canvas → set that neck's active string to
 *  whichever row the click landed on (toggle off if the same row is
 *  already active). Uses the cached layout from panelLayouts so we
 *  don't re-derive the spacing math. */
function handleStringCanvasClick(canvas, e) {
  const host = $('#strings-host');
  const wraps = Array.from(host.children);
  const wrap = canvas.parentElement;
  const neckIdx = wraps.indexOf(wrap);
  if (neckIdx < 0) return;

  const cached = panelLayouts.get(neckIdx);
  if (!cached) return;
  const { horizontal, crossLen, groupPos, groups, layout } = cached;

  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const cx = (e.clientX - rect.left) * dpr;
  const cy = (e.clientY - rect.top) * dpr;
  const crossPx = horizontal ? cy : cx;
  const crossNorm = crossPx / crossLen;

  let bestGi = -1;
  let bestD = Infinity;
  groupPos.forEach((p, gi) => {
    const d = Math.abs(p - crossNorm);
    if (d < bestD) { bestD = d; bestGi = gi; }
  });
  if (bestGi < 0) return;

  // Lock is per-PITCH-GROUP (per-row), not per-course. Click on a row
  // → that row's pitch becomes the locked target; clicking the SAME
  // row again deselects. Octave courses live in two different rows
  // and are locked independently — clicking S5 (D4) row locks just
  // D4; to switch, click S6 (D3) row instead.
  const clickedStringIdx = layout[groups[bestGi].members[0]].stringIndex;
  const cur = state.activeStringByNeck.get(neckIdx);
  const inSameGroup =
    cur != null &&
    layout[cur] &&
    layout[clickedStringIdx] &&
    layout[cur].midi === layout[clickedStringIdx].midi;
  if (inSameGroup) {
    state.activeStringByNeck.delete(neckIdx);
  } else {
    state.activeStringByNeck.set(neckIdx, clickedStringIdx);
  }
  // Wipe trails so old data from the previously-active string doesn't
  // linger on the now-unselected row.
  state.liveTrails.clear();
}

function drawNeckPanel(canvas, neckIdx, neck) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  if (canvas.width !== rect.width * dpr || canvas.height !== rect.height * dpr) {
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
  }
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const layout = neckLayout(neck);
  const orientation = state.orientation;
  const horizontal = orientation === 'horizontal';
  const thickFirst = state.thickFirst;

  // Compute per-string normalized positions (0..1 along the cross axis).
  // "Cross axis" = vertical for horizontal layout, horizontal for vertical layout.
  const midis = layout.map((l) => l.midi).filter((m) => m != null);
  const lo = Math.min(...midis);
  const hi = Math.max(...midis);

  // Build pitch-groups: strings tuned to the IDENTICAL midi share one
  // row (12-string unison pairs like B3+B3 collapse to a single line).
  // Order of group encounter follows input order (low→high), so for
  // pair mode the consecutive input pairing still works on courses.
  const N = layout.length;
  const groups = [];
  const groupOfString = new Array(N);
  {
    const byMidi = new Map();
    layout.forEach((s, i) => {
      if (s.midi == null) {
        groups.push({ midi: null, members: [i] });
        groupOfString[i] = groups.length - 1;
        return;
      }
      const k = s.midi;
      if (byMidi.has(k)) {
        const gi = byMidi.get(k);
        groups[gi].members.push(i);
        groupOfString[i] = gi;
      } else {
        byMidi.set(k, groups.length);
        groups.push({ midi: k, members: [i] });
        groupOfString[i] = groups.length - 1;
      }
    });
  }
  const G = groups.length;

  const positions = new Array(N);
  const rowHalfPerString = new Array(N);
  const groupPos = new Array(G);
  const crossLen = horizontal ? H : W;

  if (state.spacing === 'cents') {
    // True pitch-spaced. With pitch-grouping above, identical-pitch
    // strings already share a row; cents mode just spaces unique
    // pitches by their semitone distance.
    const validMidis = groups.filter((g) => g.midi != null).map((g) => g.midi);
    const lo = Math.min(...validMidis);
    const hi = Math.max(...validMidis);
    const range = hi - lo || 1;
    groups.forEach((g, gi) => {
      if (g.midi == null) { groupPos[gi] = 0.5; return; }
      let frac = (g.midi - lo) / range;
      if (!thickFirst) frac = 1 - frac;
      groupPos[gi] = Math.max(0.04, Math.min(0.96, frac * 0.92 + 0.04));
    });
    const sortedPos = groupPos.slice().sort((a, b) => a - b);
    const minGap = sortedPos.reduce(
      (m, p, i) => (i === 0 ? m : Math.min(m, p - sortedPos[i - 1])),
      Infinity,
    );
    const halfPx = Math.max(0.020, (minGap / 2) * ROW_FILL) * crossLen;
    for (let i = 0; i < N; i++) rowHalfPerString[i] = halfPx;
  } else {
    const orderedG = groups.map((_, i) => i);
    if (!thickFirst) orderedG.reverse();

    // Pair mode only meaningful for actually-paired tunings (12-string,
    // 8-string Taro Patch, etc); 6- and 7-string guitars are never
    // paired so we silently render them with even spacing.
    if (state.spacing === 'pair' && isPairedTuning(neck.strings)) {
      // Course-based pairing — each group's position is determined by
      // the COURSE its strings belong to (= floor(stringIndex / 2)),
      // not by the group's slot index. This matters for tunings that
      // mix octave and unison courses, like the 8-string Taro Patch:
      //   strings  course  groups
      //   S0 G3    C0      g0 (octave member)
      //   S1 G4    C0      g1 (octave member)
      //   S2 C4    C1      g2 (unison course → 1 group with 2 members)
      //   S3 C4    C1      g2
      //   S4 E4    C2      g3
      //   S5 E4    C2      g3
      //   S6 A4    C3      g4
      //   S7 A4    C3      g4
      // With the old "pair groups by slot" rule you'd cluster g2 (C
      // unison) with g3 (E unison) because they were consecutive
      // groups — visually wrong, those are different courses. Course-
      // based positioning lets each course occupy one slot regardless
      // of whether it's an octave pair (2 groups) or unison (1 group).
      const TIGHT = 0.35;
      const raw = new Array(G);
      let minRaw = Infinity, maxRaw = -Infinity;
      groups.forEach((g, gi) => {
        const memberSi = g.members.map((mi) => layout[mi].stringIndex);
        const minSi = Math.min(...memberSi);
        const maxSi = Math.max(...memberSi);
        const courseIdx = Math.floor(minSi / 2);
        // Within-course offset: 0 for the first slot of a pair, TIGHT
        // for the second, TIGHT/2 (centered) for a unison group that
        // owns BOTH slots of a course.
        const avg = ((minSi % 2) + (maxSi % 2)) / 2;
        raw[gi] = courseIdx + avg * TIGHT;
        if (raw[gi] < minRaw) minRaw = raw[gi];
        if (raw[gi] > maxRaw) maxRaw = raw[gi];
      });
      const sideMargin = 0.5;
      const span = (maxRaw - minRaw) + 2 * sideMargin || 1;
      groups.forEach((g, gi) => {
        let pos = (raw[gi] - minRaw + sideMargin) / span;
        if (!thickFirst) pos = 1 - pos;
        groupPos[gi] = pos;
      });
      // Row half from the courses count (2 slots per course) so a few
      // courses on a small instrument (e.g. 4-course ukulele) don't
      // produce pixel-thin rows.
      const courses = Math.ceil(N / 2);
      const halfPx = (crossLen / Math.max(2 * courses, 6)) * 0.5 * ROW_FILL;
      for (let i = 0; i < N; i++) rowHalfPerString[i] = halfPx;
    } else {
      // Even mode with MIN_SLOTS cap so few-string instruments (4-
      // string ukulele) cluster centrally instead of spreading edge to
      // edge. For G ≥ MIN_SLOTS the cap is inert. Each neck's canvas
      // still has its own full panel height — this only redistributes
      // strings WITHIN that panel.
      const MIN_SLOTS = 6;
      const denom = Math.max(G, MIN_SLOTS);
      const sideMargin = (1 - G / denom) / 2;
      orderedG.forEach((gi, slot) => {
        groupPos[gi] = sideMargin + (slot + 0.5) / denom;
      });
      const halfPx = (crossLen / denom) * 0.5 * ROW_FILL;
      for (let i = 0; i < N; i++) rowHalfPerString[i] = halfPx;
    }
  }

  for (let i = 0; i < N; i++) positions[i] = groupPos[groupOfString[i]];

  // ---- Lock state.
  // Strings keep their computed positions — never reposition on click,
  // that caused the "strings jumping" feel. What DOES change for the
  // locked row: its rowHalf (cents-to-pixel mapping) expands to use
  // nearly the full canvas, so ±80¢ deviation spans most of the panel.
  // Other rows stay in place but draw dimmed — they sit in the
  // background, the active row's trail flows over them.
  const lockedActiveIdx = state.activeStringByNeck.get(neckIdx);
  const lockEff = lockedActiveIdx != null && lockEffective(neckIdx, neck);
  const lockedMidi = lockEff && layout[lockedActiveIdx] ? layout[lockedActiveIdx].midi : null;
  if (lockEff) {
    const activeGi = groups.findIndex((g) => g.midi === lockedMidi);
    if (activeGi >= 0) {
      // Half the canvas length minus a small safety margin, so ±80¢
      // → roughly ±half-canvas pixel range regardless of where the
      // row line itself sits. Trail clips at canvas edges if the row
      // is near the top/bottom (acceptable — extreme rows on a 12-
      // string still get a clearly visible "going sharp/flat" arc).
      const expandedHalf = (crossLen - 40 * dpr) / 2;
      groups[activeGi].members.forEach((mi) => {
        const stringIdx = layout[mi].stringIndex;
        rowHalfPerString[stringIdx] = expandedHalf;
      });
    }
  }

  // Cache the rendered layout so canvas click handlers can map a
  // pixel coordinate back to a string index without re-running the
  // spacing math.
  panelLayouts.set(neckIdx, {
    horizontal,
    crossLen,
    groupPos,
    groups,
    layout,
  });

  // ---- Static layer: one string line + one ±5¢ band PER GROUP, so
  //      unison-pair courses (12-string B3+B3) draw a single row.
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Pitch rank used for thickness — low pitch = thick.
  const sortedByPitch = layout
    .filter((s) => s.midi != null)
    .slice()
    .sort((a, b) => a.midi - b.midi);

  groups.forEach((g, gi) => {
    if (g.midi == null) return;
    const crossPx = groupPos[gi] * crossLen;
    // Dim ratio for non-active groups when an effective lock is set.
    // Active group keeps full intensity so its row pops; others fade
    // to a faint reference so the user can still see where they are
    // in the tuning, but the active row dominates the canvas.
    const isActiveGroup = lockEff && g.midi === lockedMidi;
    const dim = lockEff && !isActiveGroup ? 0.20 : 1.0;

    // Thickness from the THICKEST (lowest pitch rank) member of the
    // group — which on a unison course is just the shared pitch.
    const lowestRank = Math.min(
      ...g.members.map((mi) =>
        sortedByPitch.findIndex((x) => x.stringIndex === layout[mi].stringIndex),
      ),
    );
    const thickness = 1.5 + (1 - lowestRank / Math.max(1, sortedByPitch.length - 1)) * 5.5;

    ctx.strokeStyle = `rgba(220, 220, 230, ${0.55 * dim})`;
    ctx.lineWidth = thickness * dpr;
    ctx.beginPath();
    if (horizontal) {
      ctx.moveTo(0, crossPx);
      ctx.lineTo(W, crossPx);
    } else {
      ctx.moveTo(crossPx, 0);
      ctx.lineTo(crossPx, H);
    }
    ctx.stroke();

    // Target ±5¢ band — per group (so a unison course gets one band).
    // Uses the same trailOffset mapping as the trail itself, so the
    // band visually aligns with where ±5¢ lands on the trail.
    const isActiveGroupBand = lockEff && g.midi === lockedMidi;
    const bandHalf = trailOffset(IN_TUNE_CENTS, rowHalfPerString[g.members[0]], isActiveGroupBand);
    ctx.fillStyle = `rgba(${TRAIL_RGB}, ${0.06 * dim})`;
    if (horizontal) {
      ctx.fillRect(0, crossPx - bandHalf, W, bandHalf * 2);
    } else {
      ctx.fillRect(crossPx - bandHalf, 0, bandHalf * 2, H);
    }

    // Active-row highlight: lights up the SINGLE row whose pitch
    // matches the locked string. On a unison course (B3+B3) both
    // strings sit in this row anyway. On an octave course (D4 vs D3)
    // only the row matching the clicked pitch lights up.
    const activeIdx = state.activeStringByNeck.get(neckIdx);
    let isActive = false;
    if (activeIdx != null && layout[activeIdx] && layout[activeIdx].midi != null) {
      isActive = g.midi === layout[activeIdx].midi;
    }
    if (isActive) {
      const fullHalf = rowHalfPerString[g.members[0]];
      ctx.fillStyle = `rgba(${TRAIL_RGB_INTUNE}, 0.14)`;
      if (horizontal) {
        ctx.fillRect(0, crossPx - fullHalf, W, fullHalf * 2);
      } else {
        ctx.fillRect(crossPx - fullHalf, 0, fullHalf * 2, H);
      }
      // Side accent stripe on the start of the time axis.
      ctx.fillStyle = `rgba(${TRAIL_RGB_INTUNE}, 0.90)`;
      if (horizontal) {
        ctx.fillRect(0, crossPx - fullHalf, 4 * dpr, fullHalf * 2);
      } else {
        ctx.fillRect(crossPx - fullHalf, H - 4 * dpr, fullHalf * 2, 4 * dpr);
      }
    }
  });

  // ---- Trail layer: pulled from liveTrails for this neck.
  const now = performance.now();
  const cutoff = now - TRAIL_SECONDS * 1000;

  layout.forEach((s, stringIdx) => {
    const key = `${neckIdx}:${s.stringIndex}`;
    const trail = state.liveTrails.get(key);
    if (!trail) return;
    while (trail.length > 0 && trail[0].t < cutoff) trail.shift();
    if (trail.length < 2) return;

    const pos = positions[stringIdx];
    const crossPx = pos * crossLen;
    const rowHalf = rowHalfPerString[stringIdx];
    // This string's row is the "active" one when the lock is effective
    // and the row's pitch matches the locked midi. Active rows use the
    // log-tail mapping so ±octave deviations stay visually distinct;
    // non-active rows use linear ±80¢ (clamps at edge if octave-off).
    const isActiveRow =
      lockEff && s.midi != null && s.midi === lockedMidi;

    const pts = trail.map((p) => {
      const age = (now - p.t) / (TRAIL_SECONDS * 1000);
      const ageAlpha = Math.max(0, 1 - age * age);
      const alpha = ageAlpha * rmsToAlpha(p.rms);
      const longLen = horizontal ? W : H;
      const longPos = longLen * (1 - age);
      const offset = trailOffset(p.centsOff, rowHalf, isActiveRow);
      if (horizontal) {
        return { x: longPos, y: crossPx + offset, alpha, inTune: p.inTune };
      } else {
        return { x: crossPx + offset, y: longLen - longPos, alpha, inTune: p.inTune };
      }
    });

    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const alpha = Math.min(a.alpha, b.alpha);
      if (alpha <= 0) continue;
      const isInTune = a.inTune && b.inTune;
      const rgb = isInTune ? TRAIL_RGB_INTUNE : TRAIL_RGB;
      const drawSeg = (width, a0) => {
        ctx.strokeStyle = `rgba(${rgb}, ${a0 * alpha})`;
        ctx.lineWidth = width * dpr;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      };
      drawSeg(40, 0.10);
      drawSeg(24, 0.22);
      drawSeg(12, 0.55);
      drawSeg(isInTune ? 8 : 6.4, 1.0);
    }

    const tip = pts[pts.length - 1];
    if (tip.alpha > 0.3) {
      const rgb = tip.inTune ? TRAIL_RGB_INTUNE : TRAIL_RGB;
      ctx.save();
      ctx.shadowBlur = 44 * dpr;
      ctx.shadowColor = `rgba(${rgb}, ${0.9 * tip.alpha})`;
      ctx.fillStyle = `rgba(${rgb}, ${tip.alpha})`;
      ctx.beginPath();
      ctx.arc(tip.x, tip.y, 12 * dpr, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  });

  // ---- Labels: ONE label per group; unison-pair members are joined
  //      with a middot so an octave-1 12-string course reads
  //      "S9·S10 · B3" instead of stacking two overlapping labels.
  ctx.font = `${12 * dpr}px -apple-system, system-ui, sans-serif`;
  ctx.fillStyle = 'rgba(245,245,247,0.85)';
  ctx.textBaseline = 'middle';
  groups.forEach((g, gi) => {
    if (g.midi == null) return;
    const crossPx = groupPos[gi] * crossLen;
    const info = window.midiToName(Math.round(g.midi));
    const tags = g.members
      .map((mi) => `S${layout[mi].stringIndex + 1}`)
      .join('·');
    const hz = window.midiToFreq(g.midi);
    const hzStr = hz < 100 ? hz.toFixed(1) : hz.toFixed(0);
    const label = `${tags} · ${info.label} · ${hzStr} Hz`;
    const isActiveLbl = lockEff && g.midi === lockedMidi;
    const lblDim = lockEff && !isActiveLbl ? 0.30 : 1.0;
    ctx.fillStyle = `rgba(245,245,247,${0.85 * lblDim})`;
    if (horizontal) {
      ctx.textAlign = 'left';
      ctx.fillText(label, 8 * dpr, crossPx);
    } else {
      ctx.save();
      ctx.translate(crossPx, H - 8 * dpr);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = 'left';
      ctx.fillText(label, 0, 0);
      ctx.restore();
    }
  });
}

function drawAll() {
  // Build / sync canvases per neck
  const host = $('#strings-host');
  const wantCount = state.necks.length;
  while (host.childElementCount < wantCount) {
    const wrap = document.createElement('div');
    wrap.className = 'neck-panel';
    const lbl = document.createElement('div');
    lbl.className = 'neck-panel__label';
    const cv = document.createElement('canvas');
    cv.style.cursor = 'pointer';
    cv.addEventListener('click', (e) => handleStringCanvasClick(cv, e));
    wrap.appendChild(lbl);
    wrap.appendChild(cv);
    host.appendChild(wrap);
  }
  while (host.childElementCount > wantCount) host.removeChild(host.lastElementChild);

  state.necks.forEach((neck, idx) => {
    const wrap = host.children[idx];
    wrap.querySelector('.neck-panel__label').textContent = neck.label;
    drawNeckPanel(wrap.querySelector('canvas'), idx, neck);
  });

  drawCircleOfFifths();
  drawGuitarDiagram();
  updateReadout();

  state.drawRafId = requestAnimationFrame(drawAll);
}

/**
 * Schematic guitar silhouette with the right number of strings for
 * the current tuning. Stacks one guitar per neck so a double-headed
 * 12+6 shows two guitar shapes — the upper with 12 strings, the lower
 * with 6. Live string lights up green when its pitch is the closest
 * match to the detected pitch.
 */
function drawGuitarDiagram() {
  const cv = $('#guitar-canvas');
  if (!cv) return;
  const ctx = cv.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = cv.getBoundingClientRect();
  if (cv.width !== rect.width * dpr || cv.height !== rect.height * dpr) {
    cv.width = rect.width * dpr;
    cv.height = rect.height * dpr;
  }
  const W = cv.width;
  const H = cv.height;
  ctx.clearRect(0, 0, W, H);

  const necks = state.necks || [];
  if (necks.length === 0) return;

  const horizontal = state.orientation === 'horizontal';
  const rotated180 = !state.thickFirst;   // thick-side toggle = full 180° rotation
  const lefty = state.leftHanded;          // mirror across the long axis (real left-hand guitar)
  // Bodies overlap on double-headed so the two necks share one body.
  const overlapFactor = necks.length > 1 ? -0.18 : 0.04;

  necks.forEach((neck, idx) => {
    let cx, cy, drawW, drawH;
    if (horizontal) {
      const slot = H / necks.length;
      const overlap = overlapFactor * slot;
      const yTop = idx * slot + (idx > 0 ? overlap : 0);
      const yBot = (idx + 1) * slot - (idx < necks.length - 1 ? overlap : 0);
      cx = W / 2;
      cy = (yTop + yBot) / 2;
      drawW = W;
      drawH = yBot - yTop;
    } else {
      const slot = W / necks.length;
      const overlap = overlapFactor * slot;
      const xLeft = idx * slot + (idx > 0 ? overlap : 0);
      const xRight = (idx + 1) * slot - (idx < necks.length - 1 ? overlap : 0);
      cx = (xLeft + xRight) / 2;
      cy = H / 2;
      // Canonical width (headstock→body axis) maps onto screen height
      // when vertical; canonical height (string-spread axis) maps onto
      // screen width.
      drawW = H;
      drawH = xRight - xLeft;
    }

    ctx.save();
    ctx.translate(cx, cy);

    // Order: orientation (90° CW + Y-flip so canonical thick-on-top
    // becomes screen thick-on-left), then optional 180° rotation
    // (thick-side toggle), then optional lefty mirror across the
    // long axis. Composed at the slot center so the guitar stays
    // centered through every transform combination.
    if (!horizontal) {
      ctx.rotate(Math.PI / 2);
      ctx.scale(1, -1);
    }
    if (rotated180) ctx.rotate(Math.PI);
    if (lefty) ctx.scale(1, -1);

    drawOneGuitar(ctx, -drawW / 2, -drawH / 2, drawW, drawH, neck, idx, dpr);
    ctx.restore();
  });
}

function drawOneGuitar(ctx, x, y, w, h, neck, neckIdx, dpr) {
  // Always draws the CANONICAL guitar:
  //   · headstock on LEFT, body on RIGHT
  //   · thick string on TOP (input order = thick→thin)
  //   · right-handed
  // The caller (drawGuitarDiagram) composes orientation / 180° rotation
  // / lefty mirror as canvas transforms before calling this.
  // Layout fractions: [headstock | nut | neck | body]
  const headW = w * 0.10;
  const bodyW = w * 0.46;
  const neckW = w - headW - bodyW;
  const neckX = x + headW;
  const cy = y + h / 2;

  // Body — shape varies by instrument family:
  //   · figure-8: guitar / ukulele (default — two-ellipse pear).
  //   · teardrop: mandolin / mandola (pointed at neck, rounded at far end).
  //   · round:    banjo (single drum-head circle, taut skin look).
  const bodyShape = inferBodyShape(neck.category);
  const bodyStartX = x + headW + neckW;
  let bridgeX;

  ctx.save();
  // Body fill / outline pull from the brand theme so each tuner's
  // instrument silhouette wears its own color (Guitar green, Violin
  // magenta, Bass orange, etc.).
  ctx.fillStyle = `rgba(${TRAIL_RGB}, 0.14)`;
  ctx.strokeStyle = `rgba(${TRAIL_RGB_INTUNE}, 0.50)`;
  ctx.lineWidth = 1.1 * dpr;

  if (bodyShape === 'round') {
    // Banjo — drum-head circle. Override fill for a paler taut skin.
    const radius = Math.min(h * 0.46, bodyW * 0.46);
    const drumCx = x + w - radius - 4 * dpr;
    ctx.fillStyle = `rgba(${TRAIL_RGB}, 0.10)`; // themed taut skin
    ctx.beginPath();
    ctx.arc(drumCx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // Inner rim ring (the drum head's tension hoop) — also themed.
    ctx.strokeStyle = `rgba(${TRAIL_RGB_INTUNE}, 0.55)`;
    ctx.beginPath();
    ctx.arc(drumCx, cy, radius * 0.86, 0, Math.PI * 2);
    ctx.stroke();
    bridgeX = drumCx;
  } else if (bodyShape === 'teardrop') {
    // Mandolin — pointed where the neck joins, rounded at the far end.
    const apexX = bodyStartX;
    const tailX = x + w - 4 * dpr;
    const maxRy = h * 0.42;
    ctx.beginPath();
    ctx.moveTo(apexX, cy);
    ctx.bezierCurveTo(
      apexX + bodyW * 0.10, cy - maxRy * 0.55,
      tailX - bodyW * 0.18, cy - maxRy,
      tailX, cy,
    );
    ctx.bezierCurveTo(
      tailX - bodyW * 0.18, cy + maxRy,
      apexX + bodyW * 0.10, cy + maxRy * 0.55,
      apexX, cy,
    );
    ctx.fill();
    ctx.stroke();
    // Oval sound hole offset toward neck side.
    const holeCx = apexX + bodyW * 0.45;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.80)';
    ctx.beginPath();
    ctx.ellipse(holeCx, cy, bodyW * 0.10, maxRy * 0.20, 0, 0, Math.PI * 2);
    ctx.fill();
    bridgeX = tailX - bodyW * 0.20;
  } else if (bodyShape === 'hourglass') {
    // Violin / fiddle / viola / cello / bass — figure-8 with a
    // pinched waist (C-bouts) and 2 F-hole slits flanking the bridge.
    // Drawn as ONE closed path traced clockwise from the leftmost
    // point of the upper bout. Each bout's half is one cubic bezier
    // (left equator → top peak → right equator); the C-bout waist is
    // two cubics (right equator of upper bout → top of waist; top of
    // waist → left equator of lower bout) that pinch inward toward
    // cy. The previous version's control points sent the curve
    // BELOW its endpoints, producing the "spaghetti" body the user
    // saw on violin/cello.
    const upperRx = bodyW * 0.28;
    const upperRy = h * 0.32;
    const lowerRx = bodyW * 0.34;
    const lowerRy = h * 0.40;
    const upperCx = bodyStartX + upperRx * 1.05;
    const lowerCx = x + w - lowerRx * 1.05;
    const upperLeftX = upperCx - upperRx;
    const upperRightX = upperCx + upperRx;
    const lowerLeftX = lowerCx - lowerRx;
    const lowerRightX = lowerCx + lowerRx;
    const waistX = (upperRightX + lowerLeftX) / 2;
    const waistRy = h * 0.13;       // narrower than either bout
    const cBoutBend = bodyW * 0.03; // how far control points pull inward

    ctx.beginPath();
    ctx.moveTo(upperLeftX, cy);
    // Upper bout — top half (cy → cy via top peak)
    ctx.bezierCurveTo(
      upperLeftX, cy - upperRy,
      upperRightX, cy - upperRy,
      upperRightX, cy,
    );
    // C-bout TOP: upper-right equator → top of waist (concave)
    ctx.bezierCurveTo(
      upperRightX + cBoutBend, cy - waistRy * 0.4,
      waistX - cBoutBend, cy - waistRy,
      waistX, cy - waistRy,
    );
    // C-bout TOP cont.: top of waist → lower-left equator
    ctx.bezierCurveTo(
      waistX + cBoutBend, cy - waistRy,
      lowerLeftX - cBoutBend, cy - waistRy * 0.4,
      lowerLeftX, cy,
    );
    // Lower bout — top half
    ctx.bezierCurveTo(
      lowerLeftX, cy - lowerRy,
      lowerRightX, cy - lowerRy,
      lowerRightX, cy,
    );
    // Lower bout — bottom half
    ctx.bezierCurveTo(
      lowerRightX, cy + lowerRy,
      lowerLeftX, cy + lowerRy,
      lowerLeftX, cy,
    );
    // C-bout BOTTOM (mirror)
    ctx.bezierCurveTo(
      lowerLeftX - cBoutBend, cy + waistRy * 0.4,
      waistX + cBoutBend, cy + waistRy,
      waistX, cy + waistRy,
    );
    ctx.bezierCurveTo(
      waistX - cBoutBend, cy + waistRy,
      upperRightX + cBoutBend, cy + waistRy * 0.4,
      upperRightX, cy,
    );
    // Upper bout — bottom half (close)
    ctx.bezierCurveTo(
      upperRightX, cy + upperRy,
      upperLeftX, cy + upperRy,
      upperLeftX, cy,
    );
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // F-holes — two thin slit shapes flanking the bridge area on the
    // lower bout, slightly above and below the equator.
    ctx.fillStyle = 'rgba(0, 0, 0, 0.78)';
    const fHoleX = lowerCx - lowerRx * 0.10;
    const fHoleRy = lowerRy * 0.32;
    [-1, 1].forEach((side) => {
      const fy = cy + side * lowerRy * 0.28;
      ctx.beginPath();
      ctx.ellipse(fHoleX, fy, bodyW * 0.014, fHoleRy, 0, 0, Math.PI * 2);
      ctx.fill();
    });
    bridgeX = lowerCx + lowerRx * 0.18;
  } else {
    // Figure-8 (guitar / ukulele).
    const upperRy = h * 0.34;
    const upperRx = bodyW * 0.34;
    const lowerRy = h * 0.44;
    const lowerRx = bodyW * 0.40;
    const upperCx = bodyStartX + upperRx * 0.85;
    const lowerCx = x + w - lowerRx * 0.85;
    ctx.beginPath();
    ctx.ellipse(upperCx, cy, upperRx, upperRy, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(lowerCx, cy, lowerRx, lowerRy, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // Sound hole on the lower bout.
    ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
    ctx.beginPath();
    ctx.arc(lowerCx - lowerRx * 0.12, cy, lowerRx * 0.30, 0, Math.PI * 2);
    ctx.fill();
    bridgeX = lowerCx + lowerRx * 0.55;
  }
  ctx.restore();

  // Bridge.
  const fretBoardH = h * 0.20;
  ctx.fillStyle = 'rgba(60, 35, 20, 0.85)';
  ctx.fillRect(bridgeX - 2 * dpr, cy - fretBoardH * 0.7, 4 * dpr, fretBoardH * 1.4);

  // Fretboard (neck).
  ctx.fillStyle = 'rgba(50, 30, 20, 0.65)';
  ctx.fillRect(neckX, cy - fretBoardH / 2, neckW, fretBoardH);
  // Frets — skipped on bowed-string fingerboards (violin, viola,
  // cello, bass) which are smooth.
  if (!isBowedCategory(neck.category)) {
    ctx.strokeStyle = 'rgba(200, 200, 200, 0.30)';
    ctx.lineWidth = 1 * dpr;
    for (let f = 1; f <= 5; f++) {
      const fx = neckX + (neckW * f) / 5.5;
      ctx.beginPath();
      ctx.moveTo(fx, cy - fretBoardH / 2);
      ctx.lineTo(fx, cy + fretBoardH / 2);
      ctx.stroke();
    }
  }

  // Headstock — angled trapezoid.
  ctx.fillStyle = 'rgba(50, 30, 20, 0.75)';
  ctx.strokeStyle = 'rgba(220, 180, 130, 0.35)';
  ctx.lineWidth = 1 * dpr;
  ctx.beginPath();
  ctx.moveTo(x, cy - fretBoardH * 0.95);
  ctx.lineTo(x + headW * 0.92, cy - fretBoardH * 0.55);
  ctx.lineTo(x + headW, cy - fretBoardH * 0.55);
  ctx.lineTo(x + headW, cy + fretBoardH * 0.55);
  ctx.lineTo(x + headW * 0.92, cy + fretBoardH * 0.55);
  ctx.lineTo(x, cy + fretBoardH * 0.95);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Strings.
  const N = neck.strings.length;
  const allMidis = neck.strings.map((s) => window.noteNameToMidi(s));
  const validMidis = allMidis.filter((m) => m != null);
  if (validMidis.length === 0) return;
  const lo = Math.min(...validMidis);
  const hi = Math.max(...validMidis);
  const range = hi - lo || 1;

  // Live string detection — closest to detected pitch (within 0.5 semi).
  let liveStringIdx = -1;
  if (state.stablePitch) {
    let bestD = 0.5;
    allMidis.forEach((m, i) => {
      if (m == null) return;
      const d = Math.abs(m - state.stablePitch.midiFloat);
      if (d < bestD) { bestD = d; liveStringIdx = i; }
    });
  }

  const stringTopY = cy - fretBoardH * 0.40;
  const stringBotY = cy + fretBoardH * 0.40;

  for (let i = 0; i < N; i++) {
    const m = allMidis[i];
    if (m == null) continue;
    // Input order is THICK→THIN, drawn canonically as thick-on-top.
    const frac = N === 1 ? 0.5 : i / (N - 1);
    const yString = stringTopY + frac * (stringBotY - stringTopY);

    const pitchFrac = 1 - (m - lo) / range; // 1 = thickest
    const thickness = (0.6 + pitchFrac * 1.8) * dpr;

    const isLive = liveStringIdx === i;
    ctx.save();
    if (isLive) {
      ctx.shadowBlur = 10 * dpr;
      ctx.shadowColor = `rgba(${TRAIL_RGB_INTUNE}, 0.85)`;
      ctx.strokeStyle = `rgba(${TRAIL_RGB_INTUNE}, 0.95)`;
    } else {
      ctx.strokeStyle = 'rgba(220, 220, 230, 0.78)';
    }
    ctx.lineWidth = thickness;
    ctx.beginPath();
    ctx.moveTo(neckX, yString);
    ctx.lineTo(bridgeX, yString);
    ctx.stroke();
    ctx.restore();

    // Tuning peg dot on the headstock.
    const pegFrac = N === 1 ? 0.5 : i / (N - 1);
    const pegY = (cy - fretBoardH * 0.85) + pegFrac * (fretBoardH * 1.7);
    ctx.fillStyle = isLive ? `rgba(${TRAIL_RGB_INTUNE}, 0.95)` : 'rgba(200, 200, 210, 0.85)';
    ctx.beginPath();
    ctx.arc(x + headW * 0.50, pegY, 2.2 * dpr, 0, Math.PI * 2);
    ctx.fill();

    // String label at the headstock side — "S1 E2".
    const info = window.midiToName(Math.round(m));
    ctx.fillStyle = isLive ? `rgba(${TRAIL_RGB_INTUNE}, 0.95)` : 'rgba(245, 245, 247, 0.72)';
    ctx.font = `${8.5 * dpr}px -apple-system, system-ui, sans-serif`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(`S${i + 1} ${info.label}`, x + headW * 0.42, pegY);
  }

  // Neck name in the corner.
  if (state.necks.length > 1) {
    ctx.fillStyle = `rgba(${TRAIL_RGB_INTUNE}, 0.85)`;
    ctx.font = `600 ${9 * dpr}px -apple-system, system-ui, sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(neck.label, x + 2 * dpr, y + 2 * dpr);
  }
}

// ---------- Readout ----------

/**
 * Candidate string indices on a given neck for a tuning detection.
 *
 *   · No lock → all strings on the neck are candidates.
 *   · Lock → all strings sharing the locked string's PITCH (same
 *     midi). For unison courses (12-string B3+B3 or E4+E4, mandolin
 *     pairs, Liliʻu / Taro Patch unisons) that returns both course
 *     members so plucking either routes to the same row. For octave
 *     pairs (D3 vs D4) the two strings are different pitches and live
 *     in DIFFERENT groups — locking S5 (D4) returns just S5; the user
 *     picks S5 vs S6 by clicking the row they actually want to tune.
 */
/**
 * Lock has functional effect only when the visual layout can't already
 * disambiguate plucked strings on its own:
 *
 *   · cents spacing → rows ARE pitch-proportional, closest-pitch
 *     always lands on the right row, lock is redundant;
 *   · non-paired tunings (6/7/8-string guitar) → every string has a
 *     unique pitch, no octave-twin to confuse routing.
 *
 * For both cases the user can still click a row (we keep the highlight
 * for visual reference) but routeTrail / readout ignore the lock and
 * fall back to closest-pitch matching, so behavior is identical to
 * unlocked. Lock matters only in pair/even spacing on a paired tuning,
 * where two strings can sit on different rows yet have an octave-twin
 * the closest-pitch heuristic can drift to.
 */
function lockEffective(neckIdx, neck) {
  if (state.spacing === 'cents') return false;
  if (!isPairedTuning(neck.strings)) return false;
  return true;
}

function activeCandidates(neckIdx, neck) {
  const activeIdx = state.activeStringByNeck.get(neckIdx);
  if (activeIdx == null) return null;
  if (!lockEffective(neckIdx, neck)) return null;
  const layout = neckLayout(neck);
  const lockedMidi = layout[activeIdx] && layout[activeIdx].midi;
  if (lockedMidi == null) return [activeIdx];
  const out = [];
  layout.forEach((s, idx) => {
    if (s.midi === lockedMidi) out.push(idx);
  });
  return out.length ? out : [activeIdx];
}

function nearestStringForStablePitch() {
  if (!state.stablePitch || !state.necks) return null;
  const m = state.stablePitch.midiFloat;

  // Locked AND lock is effective for this neck (paired tuning + pair/
  // even spacing): readout follows the same candidate pool routeTrail
  // uses. For 6-string / cents mode the `if (!candidates)` guard skips
  // straight to the closest-pitch fallback below, so the lock click
  // is purely visual and the readout behaves like unlocked.
  for (let neckIdx = 0; neckIdx < state.necks.length; neckIdx++) {
    const candidates = activeCandidates(neckIdx, state.necks[neckIdx]);
    if (!candidates) continue;
    const neck = state.necks[neckIdx];
    const layout = neckLayout(neck);
    let best = null;
    let bestD = Infinity;
    for (const idx of candidates) {
      const s = layout[idx];
      if (!s || s.midi == null) continue;
      const d = Math.abs(s.midi - m);
      if (d < bestD) { bestD = d; best = s; }
    }
    if (best) return { neckIdx, neck, s: best, locked: true };
  }

  // No lock → closest-pitch match across all strings on all necks.
  let best = null;
  let bestD = Infinity;
  state.necks.forEach((neck, neckIdx) => {
    const layout = neckLayout(neck);
    for (const s of layout) {
      if (s.midi == null) continue;
      const d = Math.abs(s.midi - m);
      if (d < bestD) {
        bestD = d;
        best = { neckIdx, neck, s, locked: false };
      }
    }
  });
  return best;
}

function updateReadout() {
  const stable = nearestStringForStablePitch();
  if (!state.stablePitch || !stable) {
    $('#note').textContent = '—';
    $('#cents').textContent = '';
    $('#cents').className = 'readout__cents';
    $('#target').textContent = state.micReady ? 'Pluck a string…' : (state.micError ? '' : 'Press Start to enable mic');
    return;
  }
  const note = window.freqToNote(state.stablePitch.freq);
  const cents = Math.round((state.stablePitch.midiFloat - stable.s.midi) * 100);
  $('#note').innerHTML = `${note.pitchClass}<span class="oct">${note.octave}</span>`;
  $('#cents').textContent = (cents > 0 ? '+' : '') + cents + '¢';
  $('#cents').className =
    'readout__cents ' +
    (Math.abs(cents) <= IN_TUNE_CENTS ? 'intune' : cents > 0 ? 'sharp' : 'flat');
  const tgt = window.midiToName(Math.round(stable.s.midi));
  const targetFreq = window.midiToFreq(stable.s.midi).toFixed(1);
  const neckTag = state.necks.length > 1 ? `${stable.neck.label} · ` : '';
  const lockedTag = stable.locked ? '🔒 ' : '';
  const activeHint = stable.locked
    ? ' · click row again to unlock'
    : ' · click a row to lock';
  $('#target').textContent = `${lockedTag}${neckTag}string ${stable.s.stringIndex + 1} · target ${tgt.label} · ${targetFreq} Hz${activeHint}`;
}

// ---------- Circle of Fifths ----------

/**
 * Pitch-class circle of fifths.
 *
 *   · Slices = the 12 pitch classes (C, G, D, A, E, B, F#, C#, G#/Ab,
 *     D#/Eb, A#/Bb, F) arranged in fifth-order around the wheel.
 *   · Rings = guitar necks. Single-neck = 1 ring. Double-headed = 2
 *     concentric rings (outer = Neck A, inner = Neck B).
 *   · Each used slice carries the string number(s) tuned to that pitch
 *     class on that neck — including unison/octave duplicates, so a
 *     12-string E course shows "S1·S2" alongside "S11·S12".
 *   · Live pitch lights up its slice across every ring (it's the same
 *     note no matter which neck is sounding it).
 */
function drawCircleOfFifths() {
  const cv = $('#circle-canvas');
  const ctx = cv.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = cv.getBoundingClientRect();
  if (cv.width !== rect.width * dpr || cv.height !== rect.height * dpr) {
    cv.width = rect.width * dpr;
    cv.height = rect.height * dpr;
  }
  const W = cv.width;
  const H = cv.height;
  ctx.clearRect(0, 0, W, H);
  const cx = W / 2;
  const cy = H / 2;
  const rOuter = Math.min(W, H) * 0.46;
  const rInnermost = rOuter * 0.22;

  const necks = state.necks || [];
  const N_RINGS = Math.max(1, necks.length);
  const ringWidth = (rOuter - rInnermost) / N_RINGS;

  // Pitch class → list of string numbers, per neck.
  const neckMaps = necks.map((neck) => {
    const map = new Map();
    neck.strings.forEach((noteName, idx) => {
      const m = window.noteNameToMidi(noteName);
      if (m == null) return;
      const pc = window.NOTE_NAMES[((m % 12) + 12) % 12];
      if (!map.has(pc)) map.set(pc, []);
      map.get(pc).push(idx + 1);
    });
    return map;
  });

  const livePC = state.stablePitch
    ? window.NOTE_NAMES[((Math.round(state.stablePitch.midiFloat) % 12) + 12) % 12]
    : null;

  const slice = (Math.PI * 2) / 12;

  for (let ring = 0; ring < N_RINGS; ring++) {
    const r1 = rOuter - ring * ringWidth;
    const r0 = r1 - ringWidth;
    const rMid = (r0 + r1) / 2;
    const map = neckMaps[ring] || new Map();

    for (let i = 0; i < 12; i++) {
      const pcLabel = window.CIRCLE_OF_FIFTHS[i];
      const pc = window.pitchClassEquivalent(pcLabel);
      const a0 = -Math.PI / 2 + (i - 0.5) * slice;
      const a1 = -Math.PI / 2 + (i + 0.5) * slice;
      const ac = -Math.PI / 2 + i * slice;

      const stringList = map.get(pc) || [];
      const isUsed = stringList.length > 0;
      const isLive = livePC === pc;

      ctx.beginPath();
      ctx.arc(cx, cy, r1, a0, a1);
      ctx.arc(cx, cy, r0, a1, a0, true);
      ctx.closePath();
      ctx.fillStyle = isLive
        ? `rgba(${TRAIL_RGB_INTUNE}, 0.55)`
        : isUsed
          ? `rgba(${TRAIL_RGB}, 0.22)`
          : 'rgba(255,255,255,0.035)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.15)';
      ctx.lineWidth = 1 * dpr;
      ctx.stroke();

      // Pitch class letter — sits in the OUTER half of the ring.
      const pcFontPx = Math.min(16, ringWidth * 0.32) * dpr;
      ctx.font = `600 ${pcFontPx}px -apple-system, system-ui, sans-serif`;
      ctx.fillStyle = isLive ? '#0a0a0f' : 'rgba(245,245,247,0.92)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const labelR = rMid + ringWidth * 0.18;
      ctx.fillText(pcLabel, cx + Math.cos(ac) * labelR, cy + Math.sin(ac) * labelR);

      // String numbers — sit in the INNER half of the ring.
      if (stringList.length > 0) {
        const tagFontPx = Math.min(11, ringWidth * 0.22) * dpr;
        ctx.font = `${tagFontPx}px -apple-system, system-ui, sans-serif`;
        ctx.fillStyle = isLive ? '#0a0a0f' : 'rgba(245,245,247,0.78)';
        const tags = stringList.map((n) => `S${n}`).join('·');
        const tagR = rMid - ringWidth * 0.22;
        ctx.fillText(tags, cx + Math.cos(ac) * tagR, cy + Math.sin(ac) * tagR);
      }
    }

    // Per-ring neck label at the 12-o'clock gap between slice 11 and 0.
    if (necks.length > 1) {
      const tag = String.fromCharCode(65 + ring);
      ctx.font = `600 ${Math.min(11, ringWidth * 0.22) * dpr}px -apple-system, system-ui, sans-serif`;
      ctx.fillStyle = 'rgba(245,245,247,0.55)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      // Place just outside the ring at the very top — between slices.
      const tagAngle = -Math.PI / 2 - slice * 0.5;
      const tagR = rMid;
      ctx.save();
      ctx.fillStyle = 'rgba(10,10,15,0.92)';
      ctx.beginPath();
      ctx.arc(cx + Math.cos(tagAngle) * tagR, cy + Math.sin(tagAngle) * tagR, ringWidth * 0.28, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `rgba(${TRAIL_RGB_INTUNE}, 0.95)`;
      ctx.fillText(tag, cx + Math.cos(tagAngle) * tagR, cy + Math.sin(tagAngle) * tagR);
      ctx.restore();
    }
  }

  // Center hole.
  ctx.beginPath();
  ctx.arc(cx, cy, rInnermost, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(10,10,15,0.92)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 1 * dpr;
  ctx.stroke();
  ctx.fillStyle = 'rgba(245,245,247,0.85)';
  ctx.font = `600 ${10 * dpr}px -apple-system, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('5ths', cx, cy - 5 * dpr);
  ctx.fillStyle = 'rgba(245,245,247,0.55)';
  ctx.font = `${8 * dpr}px -apple-system, system-ui, sans-serif`;
  ctx.fillText(livePC || '—', cx, cy + 6 * dpr);
}

// ---------- Top-level rendering ----------

function renderAll() {
  resolveTuning();
  buildStringEditor();
  buildNeckPickers();
}

function init() {
  // Allow per-page default overrides. Each entry point HTML
  // (guitar.html, ukulele.html, index.html) sets a tiny config
  // object before app.js loads to point the tuner at its preferred
  // instrument; everything else stays shared between pages.
  if (typeof window.APP_DEFAULTS === 'object' && window.APP_DEFAULTS) {
    const d = window.APP_DEFAULTS;
    if (d.category) state.category = d.category;
    if (d.tuningId) state.tuningId = d.tuningId;
    if (d.title) {
      document.title = d.title;
      const h1 = document.querySelector('header h1');
      if (h1) h1.textContent = d.title;
    }
    if (d.subtitle) {
      const sub = document.querySelector('header .sub');
      if (sub) sub.textContent = d.subtitle;
    }
    if (typeof d.themeHue === 'number') applyThemeHue(d.themeHue);
  } else {
    applyThemeHue(141); // default green for backwards-compat
  }

  buildCategorySelect();
  buildTuningSelect();
  resolveTuning();
  buildStringEditor();
  buildNeckPickers();
  applyAutoSpacing();

  document.body.dataset.orientation = state.orientation;
  setOrientation(state.orientation);
  setThickFirst(state.thickFirst);
  setSpacing(state.spacing);
  setHand(state.leftHanded ? 'left' : 'right');

  $('#category').addEventListener('change', (e) => {
    state.category = e.target.value;
    const tunings = window.TUNING_CATALOG[state.category].tunings;
    state.tuningId = tunings ? Object.keys(tunings)[0] : null;
    state.customNecks = null;
    state.liveTrails.clear();
    buildTuningSelect();
    renderAll();
    applyAutoSpacing();
  });
  $('#tuning').addEventListener('change', (e) => {
    state.tuningId = e.target.value;
    state.customNecks = null;
    state.liveTrails.clear();
    renderAll();
    applyAutoSpacing();
  });
  $$('#orientation .seg').forEach((b) => {
    b.addEventListener('click', () => setOrientation(b.dataset.value));
  });
  $$('#thick-side .seg').forEach((b) => {
    b.addEventListener('click', () => setThickFirst(b.dataset.value === '1'));
  });
  $$('#spacing .seg').forEach((b) => {
    b.addEventListener('click', () => setSpacing(b.dataset.value));
  });
  $$('#hand .seg').forEach((b) => {
    b.addEventListener('click', () => setHand(b.dataset.value));
  });
  $('#start-mic').addEventListener('click', () => {
    if (!state.micReady) startMic();
  });

  // Auto-start mic on page load — same as AirDanTranh's TunerView,
  // which runs startTuner() in a useEffect on mount. Browsers that
  // require a prior user gesture (file://, some Safari modes) will
  // throw on the getUserMedia call and surface the error in the
  // readout; the Start mic button stays as a manual retry.
  startMic();
  // First user click anywhere also retries — on file:// the auto-call
  // above is silently rejected, but a click counts as a gesture and
  // the prompt will fire on retry.
  document.addEventListener(
    'click',
    () => { if (!state.micReady) startMic(); },
    { once: false },
  );
  $('#reset-trail').addEventListener('click', () => state.liveTrails.clear());
  $('#reset-tuning').addEventListener('click', () => {
    state.customNecks = null;
    state.liveTrails.clear();
    renderAll();
    applyAutoSpacing();
  });

  drawAll();
}

window.addEventListener('DOMContentLoaded', init);
