/**
 * Gesture Classifier unit tests
 */

import { describe, it, expect } from 'vitest';
import { GestureClassifier } from '../../src/engine-cv/tracking/gesture-classifier';

describe('GestureClassifier', () => {
  const classifier = new GestureClassifier();

  // Helper: create 21 landmarks with specific finger positions
  const makeLandmarks = (overrides: Record<string, { x: number; y: number; z?: number }> = {}) => {
    const base = Array.from({ length: 21 }, (_, i) => ({
      x: 0.5,
      y: 0.5,
      z: 0,
    }));
    // Apply overrides by index
    const indexMap: Record<string, number> = {
      wrist: 0, thumb_tip: 4, index_tip: 8, index_mcp: 5, index_pip: 6,
      middle_tip: 12, middle_mcp: 9, middle_pip: 10,
      ring_tip: 16, ring_mcp: 13, ring_pip: 14,
      pinky_tip: 20, pinky_mcp: 17, pinky_pip: 18,
    };
    for (const [key, pos] of Object.entries(overrides)) {
      const idx = indexMap[key];
      if (idx !== undefined) {
        base[idx] = { ...base[idx], ...pos };
      }
    }
    return base;
  };

  it('should classify POINT when only index is extended', () => {
    const landmarks = makeLandmarks({
      wrist: { y: 0.8 },
      index_tip: { y: 0.2 },
      index_mcp: { y: 0.5 },
      middle_tip: { y: 0.6 },
      middle_mcp: { y: 0.5 },
      ring_tip: { y: 0.6 },
      ring_mcp: { y: 0.5 },
      pinky_tip: { y: 0.6 },
      pinky_mcp: { y: 0.5 },
    });

    const result = classifier.classify(landmarks);
    expect(result.gesture).toBe('POINT');
  });

  it('should classify ROTATE_3 when index + middle + ring are extended', () => {
    const landmarks = makeLandmarks({
      wrist: { y: 0.8 },
      index_tip: { y: 0.2 },
      index_mcp: { y: 0.5 },
      middle_tip: { y: 0.2 },
      middle_mcp: { y: 0.5 },
      ring_tip: { y: 0.2 },
      ring_mcp: { y: 0.5 },
      pinky_tip: { y: 0.6 },
      pinky_mcp: { y: 0.5 },
    });

    const result = classifier.classify(landmarks);
    expect(result.gesture).toBe('ROTATE_3');
  });

  it('should classify GRAB when all fingers are curled', () => {
    const landmarks = makeLandmarks({
      wrist: { y: 0.8 },
      index_tip: { y: 0.6 },
      index_mcp: { y: 0.5 },
      middle_tip: { y: 0.6 },
      middle_mcp: { y: 0.5 },
      ring_tip: { y: 0.6 },
      ring_mcp: { y: 0.5 },
      pinky_tip: { y: 0.6 },
      pinky_mcp: { y: 0.5 },
    });

    const result = classifier.classify(landmarks);
    expect(result.gesture).toBe('GRAB');
  });

  it('should classify OPEN_PALM with the thumb tucked (relaxed palm)', () => {
    // Users end/reset with a relaxed open palm — the thumb is often not
    // clearly extended. Four extended fingers must be enough.
    const landmarks = makeLandmarks({
      wrist: { y: 0.8 },
      thumb_tip: { x: 0.45, y: 0.62 },
      index_tip: { y: 0.2 }, index_pip: { y: 0.35 }, index_mcp: { y: 0.5 },
      middle_tip: { y: 0.2 }, middle_pip: { y: 0.35 }, middle_mcp: { y: 0.5 },
      ring_tip: { y: 0.2 }, ring_pip: { y: 0.35 }, ring_mcp: { y: 0.5 },
      pinky_tip: { y: 0.2 }, pinky_pip: { y: 0.35 }, pinky_mcp: { y: 0.5 },
    });

    const result = classifier.classify(landmarks);
    expect(result.gesture).toBe('OPEN_PALM');
  });

  it('should classify OPEN_PALM when all fingers extended', () => {
    const landmarks = makeLandmarks({
      wrist: { y: 0.8 },
      thumb_tip: { x: 0.2 },
      index_tip: { y: 0.2 },
      index_mcp: { y: 0.5 },
      middle_tip: { y: 0.2 },
      middle_mcp: { y: 0.5 },
      ring_tip: { y: 0.2 },
      ring_mcp: { y: 0.5 },
      pinky_tip: { y: 0.2 },
      pinky_mcp: { y: 0.5 },
    });

    const result = classifier.classify(landmarks);
    expect(result.gesture).toBe('OPEN_PALM');
  });

  it('should return NONE for insufficient landmarks', () => {
    const result = classifier.classify([]);
    expect(result.gesture).toBe('NONE');
  });

  // ─── SCALE_POSE: thumb+index touching, three fingers extended ──

  it('should classify SCALE_POSE when tips touch and three fingers are open', () => {
    const landmarks = makeLandmarks({
      wrist: { y: 0.8 },
      // thumb tip and index tip touching (gap 0.04 < 0.18 × span 0.3)
      thumb_tip: { x: 0.46, y: 0.2 },
      index_tip: { y: 0.2 }, index_pip: { y: 0.35 }, index_mcp: { y: 0.5 },
      middle_tip: { y: 0.2 }, middle_pip: { y: 0.35 }, middle_mcp: { y: 0.5 },
      ring_tip: { y: 0.2 }, ring_pip: { y: 0.35 }, ring_mcp: { y: 0.5 },
      pinky_tip: { y: 0.2 }, pinky_pip: { y: 0.35 }, pinky_mcp: { y: 0.5 },
    });

    const result = classifier.classify(landmarks);
    expect(result.gesture).toBe('SCALE_POSE');
  });

  it('NATURAL OK POSE: index curled down to the thumb must still be SCALE_POSE', () => {
    // A human OK gesture curls the index down to meet the thumb — the index
    // TIP is NOT farther from the wrist than its PIP, so the tip-vs-PIP
    // extension heuristic reads the index as "curled". The pose must still
    // classify SCALE_POSE (three open fingers + tips joined), not PINCH.
    const landmarks = makeLandmarks({
      wrist: { y: 0.8 },
      // index curled toward the thumb: tip closer to the wrist than the PIP
      index_tip: { x: 0.44, y: 0.58 }, index_pip: { y: 0.42 }, index_mcp: { y: 0.5 },
      // thumb tip meeting the curled index tip (gap 0.02 < 0.28 × span 0.3)
      thumb_tip: { x: 0.46, y: 0.57 },
      middle_tip: { y: 0.2 }, middle_pip: { y: 0.35 }, middle_mcp: { y: 0.5 },
      ring_tip: { y: 0.2 }, ring_pip: { y: 0.35 }, ring_mcp: { y: 0.5 },
      pinky_tip: { y: 0.2 }, pinky_pip: { y: 0.35 }, pinky_mcp: { y: 0.5 },
    });

    const result = classifier.classify(landmarks);
    expect(result.gesture).toBe('SCALE_POSE');
  });

  it('should NOT classify SCALE_POSE when the tips are apart (open palm stays ROTATE)', () => {
    const landmarks = makeLandmarks({
      wrist: { y: 0.8 },
      thumb_tip: { x: 0.15, y: 0.55 },
      index_tip: { y: 0.2 }, index_pip: { y: 0.35 }, index_mcp: { y: 0.5 },
      middle_tip: { y: 0.2 }, middle_pip: { y: 0.35 }, middle_mcp: { y: 0.5 },
      ring_tip: { y: 0.2 }, ring_pip: { y: 0.35 }, ring_mcp: { y: 0.5 },
      pinky_tip: { y: 0.2 }, pinky_pip: { y: 0.35 }, pinky_mcp: { y: 0.5 },
    });

    const result = classifier.classify(landmarks);
    expect(result.gesture).toBe('OPEN_PALM');
  });

  it('distinguishes the three transform poses (MOVE / ROTATE / SCALE_POSE)', () => {
    const curled = (over: Record<string, { x: number; y: number; z?: number }> = {}) =>
      makeLandmarks({
        wrist: { y: 0.8 },
        index_tip: { y: 0.6 }, index_mcp: { y: 0.5 },
        middle_tip: { y: 0.6 }, middle_mcp: { y: 0.5 },
        ring_tip: { y: 0.6 }, ring_mcp: { y: 0.5 },
        pinky_tip: { y: 0.6 }, pinky_mcp: { y: 0.5 },
        ...over,
      });
    // MOVE: all curled.
    expect(classifier.classify(curled()).gesture).toBe('GRAB');
    // ROTATE: all open, tips apart.
    expect(
      classifier.classify(curled({ thumb_tip: { x: 0.15, y: 0.55 },
        index_tip: { y: 0.2 }, index_pip: { y: 0.35 },
        middle_tip: { y: 0.2 }, middle_pip: { y: 0.35 },
        ring_tip: { y: 0.2 }, ring_pip: { y: 0.35 },
        pinky_tip: { y: 0.2 }, pinky_pip: { y: 0.35 } })).gesture,
    ).toBe('OPEN_PALM');
    // SCALE: open fingers, tips joined.
    expect(
      classifier.classify(curled({ thumb_tip: { x: 0.46, y: 0.2 },
        index_tip: { y: 0.2 }, index_pip: { y: 0.35 },
        middle_tip: { y: 0.2 }, middle_pip: { y: 0.35 },
        ring_tip: { y: 0.2 }, ring_pip: { y: 0.35 },
        pinky_tip: { y: 0.2 }, pinky_pip: { y: 0.35 } })).gesture,
    ).toBe('SCALE_POSE');
  });

  it('CRITICAL: POINT should never be classified as ROTATE_3', () => {
    // Index extended, middle/ring/pinky retracted
    const landmarks = makeLandmarks({
      wrist: { y: 0.8 },
      index_tip: { y: 0.15 },
      index_mcp: { y: 0.5 },
      middle_tip: { y: 0.55 },
      middle_mcp: { y: 0.5 },
      ring_tip: { y: 0.55 },
      ring_mcp: { y: 0.5 },
      pinky_tip: { y: 0.55 },
      pinky_mcp: { y: 0.5 },
    });

    const result = classifier.classify(landmarks);
    expect(result.gesture).not.toBe('ROTATE_3');
    expect(result.gesture).toBe('POINT');
  });

  it('should analyze finger state correctly', () => {
    // Scale-invariant rule: extended = tip farther from the wrist than the
    // PIP; curled = tip folds back toward the palm (closer than PIP).
    const landmarks = makeLandmarks({
      wrist: { y: 0.8 },
      // index: extended
      index_tip: { y: 0.2 }, index_pip: { y: 0.35 }, index_mcp: { y: 0.5 },
      // middle: curled (tip folded back toward the palm)
      middle_tip: { y: 0.55 }, middle_pip: { y: 0.52 }, middle_mcp: { y: 0.5 },
      // ring: extended
      ring_tip: { y: 0.2 }, ring_pip: { y: 0.35 }, ring_mcp: { y: 0.5 },
      // pinky: curled
      pinky_tip: { y: 0.55 }, pinky_pip: { y: 0.52 }, pinky_mcp: { y: 0.5 },
    });

    const result = classifier.classify(landmarks);
    expect(result.fingerState.index).toBe(true);
    expect(result.fingerState.middle).toBe(false);
    expect(result.fingerState.ring).toBe(true);
    expect(result.fingerState.pinky).toBe(false);
  });

  // ─── NATURAL GRAB (relaxed pose recognition) ────────────

  /** Realistic palm: wrist(0)=(0.5,0.8), span 0.15; fingers on -y; each
   *  finger given as tip/PIP wrist-distance ratio (2.0 = straight). */
  const naturalHand = (ratios: number[], thumbGapSpan: number) => {
    const lm = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.8, z: 0 }));
    lm[9] = { x: 0.5, y: 0.65, z: 0 }; // span 0.15
    const fingers: Array<[number, number]> = [[6, 8], [10, 12], [14, 16], [18, 20]];
    fingers.forEach(([pip, tip], i) => {
      const r = ratios[i];
      lm[pip] = { x: 0.5 + (i - 1.5) * 0.022, y: 0.65, z: 0 };
      lm[tip] = { x: lm[pip].x, y: 0.8 - 0.15 * Math.min(r, 2.2), z: 0 };
    });
    lm[4] = { x: lm[8].x - thumbGapSpan * 0.15, y: lm[8].y + 0.01, z: 0 };
    return lm;
  };

  it('NATURAL GRAB: relaxed draped-thumb fist (no forced thumb-away pose)', () => {
    // All fingers curled, thumb naturally draped ~0.30 span from the index
    // tip — previously swallowed by PINCH (→ no mode), forcing users into
    // an exaggerated thumb-away position.
    expect(classifier.classify(naturalHand([0.8, 0.8, 0.8, 0.8], 0.30)).gesture).toBe('GRAB');
  });

  it('NATURAL GRAB: slightly open (one drifted finger) stays GRAB', () => {
    // Ring drifted past the strict extension line (1.32) — natural slack.
    expect(classifier.classify(naturalHand([0.9, 0.95, 1.32, 0.85], 0.32)).gesture).toBe('GRAB');
  });

  it('NATURAL GRAB: half-open hand stays ambiguous (NONE, not a wrong mode)', () => {
    // Two fingers clearly reaching (2.0), two curled — no confident pick.
    expect(classifier.classify(naturalHand([2.0, 0.8, 0.8, 2.0], 0.32)).gesture).toBe('NONE');
  });

  it('deliberate tip-pinch on a closed hand is still PINCH (fingertip-close)', () => {
    // Fist geometry but the thumb tip is FINGERTIP-CLOSE to the index tip
    // (0.14 span — a deliberate pinch closes far under one finger-width).
    expect(classifier.classify(naturalHand([0.6, 0.6, 0.6, 0.6], 0.14)).gesture).toBe('PINCH');
  });

  it('NATURAL GRAB: extended index is never stolen (POINT preserved)', () => {
    expect(classifier.classify(naturalHand([1.9, 0.8, 0.8, 0.8], 0.30)).gesture).toBe('POINT');
  });
});
