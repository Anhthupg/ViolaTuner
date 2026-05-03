/**
 * Guitar tuning catalog. Each tuning is a list of strings ordered
 * THICKEST → THINNEST (low pitch → high pitch in standard guitar
 * convention). The display can flip this for low-on-top vs high-on-top
 * and left/right orientations.
 *
 * For 12-string and double-headed guitars we model each PHYSICAL
 * string. A 12-string is six octave/unison pairs. A double-headed 12+6
 * is a 12-string neck + a 6-string neck on the same body, with each
 * neck independently tunable.
 *
 * Frequency on each string entry is implied by its note name (computed
 * with noteNameToMidi at runtime). We carry a `gauge` field (1.0 =
 * standard) only for the visual thickness mapping.
 */

const TUNING_CATALOG = {
  six: {
    label: '6-string',
    tunings: {
      'standard': {
        label: 'Standard (E A D G B E)',
        strings: ['E2', 'A2', 'D3', 'G3', 'B3', 'E4'],
      },
      'drop-d': {
        label: 'Drop D (D A D G B E)',
        strings: ['D2', 'A2', 'D3', 'G3', 'B3', 'E4'],
      },
      'double-drop-d': {
        label: 'Double Drop D (D A D G B D)',
        strings: ['D2', 'A2', 'D3', 'G3', 'B3', 'D4'],
      },
      'drop-c': {
        label: 'Drop C (C G C F A D)',
        strings: ['C2', 'G2', 'C3', 'F3', 'A3', 'D4'],
      },
      'drop-b': {
        label: 'Drop B (B F# B E G# C#)',
        strings: ['B1', 'F#2', 'B2', 'E3', 'G#3', 'C#4'],
      },
      'dadgad': {
        label: 'DADGAD (D A D G A D)',
        strings: ['D2', 'A2', 'D3', 'G3', 'A3', 'D4'],
      },
      'open-d': {
        label: 'Open D (D A D F# A D)',
        strings: ['D2', 'A2', 'D3', 'F#3', 'A3', 'D4'],
      },
      'open-g': {
        label: 'Open G (D G D G B D)',
        strings: ['D2', 'G2', 'D3', 'G3', 'B3', 'D4'],
      },
      'open-e': {
        label: 'Open E (E B E G# B E)',
        strings: ['E2', 'B2', 'E3', 'G#3', 'B3', 'E4'],
      },
      'open-c': {
        label: 'Open C (C G C G C E)',
        strings: ['C2', 'G2', 'C3', 'G3', 'C4', 'E4'],
      },
      'half-step-down': {
        label: 'Half-step down (Eb Ab Db Gb Bb Eb)',
        strings: ['Eb2', 'Ab2', 'Db3', 'Gb3', 'Bb3', 'Eb4'],
      },
      'whole-step-down': {
        label: 'Whole-step down (D G C F A D)',
        strings: ['D2', 'G2', 'C3', 'F3', 'A3', 'D4'],
      },
      'nashville': {
        label: 'Nashville (high octaves on E A D G)',
        strings: ['E3', 'A3', 'D4', 'G4', 'B3', 'E4'],
      },
      'all-fourths': {
        label: 'All Fourths (E A D G C F)',
        strings: ['E2', 'A2', 'D3', 'G3', 'C4', 'F4'],
      },
      'new-standard': {
        label: 'New Standard (C G D A E G)',
        strings: ['C2', 'G2', 'D3', 'A3', 'E4', 'G4'],
      },
    },
  },

  seven: {
    label: '7-string',
    tunings: {
      'standard-7': {
        label: 'Standard 7 (B E A D G B E)',
        strings: ['B1', 'E2', 'A2', 'D3', 'G3', 'B3', 'E4'],
      },
      'drop-a-7': {
        label: 'Drop A (A E A D G B E)',
        strings: ['A1', 'E2', 'A2', 'D3', 'G3', 'B3', 'E4'],
      },
      'russian-7': {
        label: 'Russian 7 (D G B D G B D)',
        strings: ['D2', 'G2', 'B2', 'D3', 'G3', 'B3', 'D4'],
      },
    },
  },

  eight: {
    label: '8-string',
    tunings: {
      'standard-8': {
        label: 'Standard 8 (F# B E A D G B E)',
        strings: ['F#1', 'B1', 'E2', 'A2', 'D3', 'G3', 'B3', 'E4'],
      },
      'drop-e-8': {
        label: 'Drop E (E B E A D G B E)',
        strings: ['E1', 'B1', 'E2', 'A2', 'D3', 'G3', 'B3', 'E4'],
      },
    },
  },

  twelve: {
    label: '12-string',
    // Per-course ordering follows the standard 12-string convention:
    // odd-numbered string = OCTAVE companion (higher pitch), even-
    // numbered string = FUNDAMENTAL (lower pitch). On a real 12-string
    // the octave string sits physically above its companion, so when
    // you strum down you hit S1 (octave) before S2 (fundamental). For
    // the unison courses (B and high E) the order doesn't matter.
    tunings: {
      'standard-12': {
        label: 'Standard 12 (octave pairs)',
        strings: [
          'E3', 'E2',   // S1 octave / S2 low E fundamental
          'A3', 'A2',
          'D4', 'D3',
          'G4', 'G3',
          'B3', 'B3',
          'E4', 'E4',
        ],
      },
      'drop-d-12': {
        label: 'Drop D 12',
        strings: [
          'D3', 'D2',
          'A3', 'A2',
          'D4', 'D3',
          'G4', 'G3',
          'B3', 'B3',
          'E4', 'E4',
        ],
      },
      'open-g-12': {
        label: 'Open G 12 (Keith Richards-ish)',
        strings: [
          'D3', 'D2',
          'G3', 'G2',
          'D4', 'D3',
          'G4', 'G3',
          'B3', 'B3',
          'D4', 'D4',
        ],
      },
    },
  },

  ukulele: {
    label: 'Ukulele',
    tunings: {
      'soprano-reentrant': {
        label: 'Standard re-entrant (G C E A — high G)',
        strings: ['G4', 'C4', 'E4', 'A4'],
      },
      'low-g': {
        label: 'Low G (G C E A — low G)',
        strings: ['G3', 'C4', 'E4', 'A4'],
      },
      'baritone': {
        label: 'Baritone (D G B E)',
        strings: ['D3', 'G3', 'B3', 'E4'],
      },
      'slack-g': {
        label: 'Slack key G (G C E G)',
        strings: ['G4', 'C4', 'E4', 'G4'],
      },
    },
  },

  ukulele8: {
    label: 'Ukulele 8-string (Taro Patch)',
    // Per-course convention (matches 12-string): odd string = octave
    // companion (higher pitch), even string = fundamental (lower).
    // For unison courses both strings are the same — order doesn't
    // matter, but kept consistent so S1·S2, S3·S4 etc. always read
    // as one course.
    tunings: {
      'taro-patch-g-octave': {
        label: 'Taro Patch (octave G, unison C E A)',
        strings: ['G4', 'G3', 'C4', 'C4', 'E4', 'E4', 'A4', 'A4'],
      },
      'taro-patch-gc-octave': {
        label: 'Taro Patch (octave G + C, unison E A)',
        strings: ['G4', 'G3', 'C4', 'C3', 'E4', 'E4', 'A4', 'A4'],
      },
      'taro-patch-full-octave': {
        label: 'Taro Patch full-octave (G C E A all octave pairs)',
        strings: ['G4', 'G3', 'C4', 'C3', 'E4', 'E3', 'A4', 'A3'],
      },
      'taro-patch-all-unison': {
        label: 'Taro Patch all-unison (re-entrant high G)',
        strings: ['G4', 'G4', 'C4', 'C4', 'E4', 'E4', 'A4', 'A4'],
      },
    },
  },

  ukulele6: {
    label: 'Ukulele 6-string (Liliʻu)',
    tunings: {
      'liliu': {
        label: 'Liliʻu (G C C E A A)',
        strings: ['G4', 'C4', 'C4', 'E4', 'A4', 'A4'],
      },
    },
  },

  mandolin: {
    label: 'Mandolin (8-string, paired)',
    // 4 courses of 2 unison strings — same as a violin tuned in
    // fifths (G3 D4 A4 E5). Convention: list both strings of each
    // course in unison ordering since both members target identical
    // pitch.
    tunings: {
      'standard': {
        label: 'Standard (G G D D A A E E)',
        strings: ['G3', 'G3', 'D4', 'D4', 'A4', 'A4', 'E5', 'E5'],
      },
      'cross-tuning-aaee': {
        label: 'Cross AAEE (A A E E A A E E)',
        strings: ['A3', 'A3', 'E4', 'E4', 'A4', 'A4', 'E5', 'E5'],
      },
      'open-d': {
        label: 'Open D (D D A A D D F# F#)',
        strings: ['D3', 'D3', 'A3', 'A3', 'D4', 'D4', 'F#4', 'F#4'],
      },
      'open-g': {
        label: 'Open G (G G D D G G B B)',
        strings: ['G3', 'G3', 'D4', 'D4', 'G4', 'G4', 'B4', 'B4'],
      },
    },
  },

  mandola: {
    label: 'Mandola (8-string, paired) — fifth lower',
    tunings: {
      'standard': {
        label: 'Standard (C C G G D D A A)',
        strings: ['C3', 'C3', 'G3', 'G3', 'D4', 'D4', 'A4', 'A4'],
      },
    },
  },

  banjo: {
    label: 'Banjo 5-string',
    // 5-string banjo's high drone (S5 G4) is the short string attached
    // at the 5th fret — listed last so input order goes low → high
    // along the main 4 strings, with the drone afterward.
    tunings: {
      'open-g': {
        label: 'Open G (D G B D + g drone)',
        strings: ['D3', 'G3', 'B3', 'D4', 'G4'],
      },
      'double-c': {
        label: 'Double C (C G C D + g drone)',
        strings: ['C3', 'G3', 'C4', 'D4', 'G4'],
      },
      'open-d': {
        label: 'Open D (D F# A D + g drone)',
        strings: ['D3', 'F#3', 'A3', 'D4', 'F#4'],
      },
      'sawmill-modal-g': {
        label: 'Sawmill / Modal G (D G C D + g drone)',
        strings: ['D3', 'G3', 'C4', 'D4', 'G4'],
      },
    },
  },

  banjo4: {
    label: 'Banjo 4-string (Tenor / Plectrum)',
    tunings: {
      'tenor-cgda': {
        label: 'Tenor CGDA (jazz / Irish)',
        strings: ['C3', 'G3', 'D4', 'A4'],
      },
      'tenor-irish-gdae': {
        label: 'Irish Tenor GDAE (octave below mandolin)',
        strings: ['G2', 'D3', 'A3', 'E4'],
      },
      'plectrum-cgbd': {
        label: 'Plectrum CGBD',
        strings: ['C3', 'G3', 'B3', 'D4'],
      },
    },
  },

  // ---------- Bowed-string family ----------
  // Same engine, different body shape (hourglass with F-holes, no
  // frets) inferred via inferBodyShape() in app.js. fftSize bumps to
  // 8192 for any tuning whose lowest pitch lands below ~60 Hz (bass
  // family) so YIN sees enough periods of the fundamental.

  violin: {
    label: 'Violin (4-string)',
    tunings: {
      'standard': {
        label: 'Standard (G D A E)',
        strings: ['G3', 'D4', 'A4', 'E5'],
      },
    },
  },

  violin5: {
    label: 'Violin 5-string',
    tunings: {
      'standard-5': {
        label: 'Standard 5 (C G D A E)',
        strings: ['C3', 'G3', 'D4', 'A4', 'E5'],
      },
    },
  },

  fiddle: {
    label: 'Fiddle (4-string)',
    // Same instrument as violin physically; separate category so the
    // Fiddle Tuner brand can default to fiddle-culture cross-tunings
    // and Old-Time / Cajun variants instead of just classical GDAE.
    tunings: {
      'standard': {
        label: 'Standard (G D A E)',
        strings: ['G3', 'D4', 'A4', 'E5'],
      },
      'cross-aeae': {
        label: 'Cross AEAE (Old-Time)',
        strings: ['A3', 'E4', 'A4', 'E5'],
      },
      'cross-gdgd-sawmill': {
        label: 'Cross GDGD / Sawmill (Old-Time)',
        strings: ['G3', 'D4', 'G4', 'D5'],
      },
      'ddad': {
        label: 'DDAD (modal)',
        strings: ['D3', 'D4', 'A4', 'D5'],
      },
      'cajun-fdaf': {
        label: 'Cajun (F D A F)',
        strings: ['F3', 'D4', 'A4', 'F5'],
      },
      'cumberland-gap-gdgb': {
        label: 'Cumberland Gap (G D G B)',
        strings: ['G3', 'D4', 'G4', 'B4'],
      },
      'high-bass-adae': {
        label: 'High Bass (A D A E)',
        strings: ['A3', 'D4', 'A4', 'E5'],
      },
    },
  },

  fiddle5: {
    label: 'Fiddle 5-string',
    tunings: {
      'standard-5': {
        label: 'Standard 5 (C G D A E)',
        strings: ['C3', 'G3', 'D4', 'A4', 'E5'],
      },
    },
  },

  viola: {
    label: 'Viola (4-string)',
    tunings: {
      'standard': {
        label: 'Standard (C G D A) — fifth below violin',
        strings: ['C3', 'G3', 'D4', 'A4'],
      },
    },
  },

  viola5: {
    label: 'Viola 5-string',
    tunings: {
      'standard-5-low-f': {
        label: 'Standard 5 low F (F C G D A)',
        strings: ['F2', 'C3', 'G3', 'D4', 'A4'],
      },
      'standard-5-high-e': {
        label: 'Standard 5 high E (C G D A E) — violin top',
        strings: ['C3', 'G3', 'D4', 'A4', 'E5'],
      },
    },
  },

  cello: {
    label: 'Cello (4-string)',
    tunings: {
      'standard': {
        label: 'Standard (C G D A) — octave below viola',
        strings: ['C2', 'G2', 'D3', 'A3'],
      },
      'fifth-suite-scordatura': {
        label: 'Bach 5th Suite scordatura (C G D G)',
        strings: ['C2', 'G2', 'D3', 'G3'],
      },
    },
  },

  cello5: {
    label: 'Cello 5-string (Bach 6th-suite style)',
    tunings: {
      'baroque-cgdae': {
        label: '5-string Bach 6th (C G D A E)',
        strings: ['C2', 'G2', 'D3', 'A3', 'E4'],
      },
    },
  },

  bass: {
    label: 'Double Bass / Bass Guitar (4-string)',
    tunings: {
      'standard': {
        label: 'Standard (E A D G) — octave below guitar low 4',
        strings: ['E1', 'A1', 'D2', 'G2'],
      },
      'drop-d': {
        label: 'Drop D (D A D G)',
        strings: ['D1', 'A1', 'D2', 'G2'],
      },
      'orchestral-fifths-cgda': {
        label: 'Orchestral fifths (C G D A) — solo classical',
        strings: ['C1', 'G1', 'D2', 'A2'],
      },
      'solo-tuning-up-step': {
        label: 'Solo tuning (whole step up: F# B E A)',
        strings: ['F#1', 'B1', 'E2', 'A2'],
      },
    },
  },

  bass5: {
    label: 'Bass 5-string',
    tunings: {
      'standard-low-b': {
        label: 'Standard 5 low B (B E A D G)',
        strings: ['B0', 'E1', 'A1', 'D2', 'G2'],
      },
      'standard-high-c': {
        label: 'Standard 5 high C (E A D G C)',
        strings: ['E1', 'A1', 'D2', 'G2', 'C3'],
      },
    },
  },

  bass6: {
    label: 'Bass 6-string',
    tunings: {
      'standard-6': {
        label: 'Standard 6 (B E A D G C)',
        strings: ['B0', 'E1', 'A1', 'D2', 'G2', 'C3'],
      },
    },
  },

  doubleHeaded: {
    label: 'Double-headed (2 necks)',
    // No `tunings` here — UI switches to per-neck independent pickers
    // so you can do "Neck A: Drop D 6 / Neck B: DADGAD 6" or any
    // combination of 6 / 7 / 8 / 12 with any of their tunings.
  },
};

const CIRCLE_OF_FIFTHS = [
  'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#', 'Ab', 'Eb', 'Bb', 'F',
];
const CIRCLE_OF_FIFTHS_RELATIVE_MINOR = [
  'A', 'E', 'B', 'F#', 'C#', 'G#', 'D#', 'A#', 'F', 'C', 'G', 'D',
];

function pitchClassEquivalent(pc) {
  const map = { 'Db': 'C#', 'Eb': 'D#', 'Gb': 'F#', 'Ab': 'G#', 'Bb': 'A#' };
  return map[pc] || pc;
}

window.TUNING_CATALOG = TUNING_CATALOG;
window.CIRCLE_OF_FIFTHS = CIRCLE_OF_FIFTHS;
window.CIRCLE_OF_FIFTHS_RELATIVE_MINOR = CIRCLE_OF_FIFTHS_RELATIVE_MINOR;
window.pitchClassEquivalent = pitchClassEquivalent;
