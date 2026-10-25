/**
 * Module Builder V1.1 — Gesture Classifier
 *
 * Classifies hand landmarks into product-meaningful gestures:
 * POINT, GRAB, PINCH, ROTATE_3, OPEN_PALM, NONE.
 *
 * Critical rule: POINT (index-only) must never classify as ROTATE_3.
 * ROTATE_3 requires the explicit three-finger configuration.
 *
 * Pinch robustness: the thumb–index distance is measured in 2D only.
 * MediaPipe's per-landmark z is a wrist-relative depth estimate with noise
 * often larger than a real pinch opening — including it in the distance
 * made genuine pinches classify as GRAB (accidental MOVE) whenever the
 * z estimates disagreed. A single shared palmSpan() reference keeps every
 * threshold scale-invariant (same hand at any distance from the camera).
 *
 * Source of truth: Doc 03 §4, Doc 03 §7.1, D-012
 */

import type { Gesture, FingerState } from '../../core/contracts';

// ─── Landmark indices (MediaPipe hand model) ──────────────
const INDEX_TIP = 8;
const INDEX_PIP = 6;
const MIDDLE_TIP = 12;
const MIDDLE_PIP = 10;
const RING_TIP = 16;
const RING_PIP = 14;
const PINKY_TIP = 20;
const PINKY_PIP = 18;

interface Landmark {
  x: number;
  y: number;
  z: number;
}

// ─── Shared scale reference ───────────────────────────────

/**
 * Palm span: distance from the wrist (0) to the middle-finger MCP (9).
 * The scale-invariant reference every pinch threshold is measured against,
 * shared with the session controller's depth signal so gesture and motion
 * math agree on the same hand-size measure. 2D only — the z landmark is
 * far too noisy to include.
 */
export function palmSpan(landmarks: Landmark[]): number {
  const wrist = landmarks[0];
  const middleMcp = landmarks[9];
  return Math.hypot(middleMcp.x - wrist.x, middleMcp.y - wrist.y);
}

/**
 * 2D thumb-tip ↔ index-tip distance in normalized frame units.
 * (z excluded — see the file header.)
 */
export function pinchGap(landmarks: Landmark[]): number {
  const thumbTip = landmarks[4];
  const indexTip = landmarks[8];
  return Math.hypot(indexTip.x - thumbTip.x, indexTip.y - thumbTip.y);
}

// ─── Gesture Classifier ─────────────────────────────────

export class GestureClassifier {
  /**
   * Classify a set of 21 hand landmarks into a gesture.
   * This is a pure function — no state, no side effects.
   */
  classify(landmarks: Landmark[]): { gesture: Gesture; fingerState: FingerState } {
    if (!landmarks || landmarks.length < 21) {
      return { gesture: 'NONE', fingerState: { index: false, middle: false, ring: false, pinky: false, thumb: false } };
    }

    const fingerState = this.analyzeFingers(landmarks);
    const gesture = this.determineGesture(landmarks, fingerState);

    return { gesture, fingerState };
  }

  /**
   * Analyze which fingers are extended.
   */
  private analyzeFingers(landmarks: Landmark[]): FingerState {
    const wrist = landmarks[0];
    return {
      index: this.isFingerExtended(landmarks[INDEX_TIP], landmarks[INDEX_PIP], wrist),
      middle: this.isFingerExtended(landmarks[MIDDLE_TIP], landmarks[MIDDLE_PIP], wrist),
      ring: this.isFingerExtended(landmarks[RING_TIP], landmarks[RING_PIP], wrist),
      pinky: this.isFingerExtended(landmarks[PINKY_TIP], landmarks[PINKY_PIP], wrist),
      thumb: this.isThumbExtended(landmarks),
    };
  }

  /**
   * Determine gesture from finger state and landmark positions.
   */
  private determineGesture(landmarks: Landmark[], fs: FingerState): Gesture {
    // ── SCALE_POSE (the "OK" gesture): thumb+index touching, three fingers
    // extended ──
    // Fixed scale-control pose (replaces pinch-distance scaling). Must run
    // BEFORE the PINCH check: geometrically, the scale pose IS a pinch with
    // the remaining fingers open — an isPinching-only check would swallow
    // it (tips-close ⇒ PINCH regardless of the other fingers).
    //
    // Discriminator is the MIDDLE/RING/PINKY state, NOT the index: a natural
    // human OK gesture CURLS the index down to meet the thumb (and the thumb
    // tip folds in too), so tip-vs-PIP extension reads index/thumb as
    // "curled" — requiring fs.index here rejected every real OK pose and
    // routed it to PINCH (which maps to no mode — Scale was unreachable
    // live). The three open fingers are what separate the OK pose from a
    // genuine pinch (all fingers curled):
    //   MOVE  = all curled        · ROTATE = all open, tips apart ·
    //   SCALE = three open, tips touching.
    // The thumb-index distance is NOT the scale input — it only enters/exits
    // the pose, identically to any other gesture check.
    if (
      fs.middle && fs.ring && fs.pinky &&
      this.isTipJoined(landmarks)
    ) {
      return 'SCALE_POSE';
    }

    // ── PINCH: Thumb tip close to index tip ─────────────
    // Detected by measuring thumb-index distance, not finger extension.
    // This must come BEFORE GRAB/POINT checks because pinching involves
    // both thumb and index being active even though tips are close.
    //
    // FIST-AWARE THRESHOLD: a deliberate pinch closes FINGERTIP-TO-
    // FINGERTIP — the gap collapses far below one finger-width — while a
    // natural relaxed fist drapes the thumb over the curled fingers, one
    // finger-width (~0.25–0.35 span) from the index tip. On a compact
    // all-curled hand the pinch line is therefore TIGHTER (PINCH_ON_CURLED):
    // the draped-thumb fist falls through to the natural GRAB instead of
    // being swallowed by PINCH (which maps to no mode — the "MOVE requires
    // an exaggerated thumb-away pose" defect). Extended-finger hands keep
    // the general PINCH_ON line, and SCALE_POSE is checked before this
    // branch and is untouched.
    const span = palmSpan(landmarks);
    const gap = pinchGap(landmarks);
    const pinching =
      span > 1e-4 &&
      gap < span * (this.isFistCurl(landmarks) ? PINCH_ON_CURLED : PINCH_ON);
    if (pinching) {
      return 'PINCH';
    }

    // ── OPEN_PALM: four fingers extended (thumb optional) ──
    // The thumb is often tucked or half-visible on a relaxed open palm;
    // requiring it made the end/reset gesture unreliable. The four-finger
    // check alone cannot collide with ROTATE_3 (pinky curled) or GRAB.
    if (fs.index && fs.middle && fs.ring && fs.pinky) {
      return 'OPEN_PALM';
    }

    // ── ROTATE_3: Three fingers extended (index + middle + ring) ──
    // CRITICAL: Must require all three, and pinky should be retracted
    // This ensures POINT (index-only) never classifies as ROTATE
    if (fs.index && fs.middle && fs.ring && !fs.pinky) {
      return 'ROTATE_3';
    }

    // ── GRAB / FIST: a NATURAL grab / closed hand ────────
    // Recognizes the relaxed pose instead of a rigid all-four-curled
    // contract (see isNaturalGrab): ≥3 of 4 fingers curled with a tolerant
    // curl ratio, thumb position IGNORED (the thumb rests wherever it
    // naturally falls). A marginally-extended index within the curl
    // tolerance is still a grab; only a CLEARLY extended index (a
    // deliberate point, checked below) is excluded.
    if (this.isNaturalGrab(landmarks, fs)) {
      return 'GRAB';
    }

    // ── POINT: Only index extended ──────────────────────
    // This is intentionally AFTER ROTATE_3 check to prevent
    // index-only from ever matching rotation
    if (fs.index && !fs.middle && !fs.ring && !fs.pinky) {
      return 'POINT';
    }

    // ── Ambiguous / mixed states ────────────────────────
    return 'NONE';
  }

  /**
   * SCALE_POSE tip-join test: thumb tip and index tip touching/very close.
   * Same 2D scale-invariant measurement as the pinch check — this pose only
   * ENTERS the scale gesture; the thumb-index distance is never the scale
   * AMOUNT (vertical hand travel is).
   */
  private isTipJoined(landmarks: Landmark[]): boolean {
    const span = palmSpan(landmarks);
    if (span < 1e-4) return false;
    return pinchGap(landmarks) < span * SCALE_POSE_TIP_JOIN;
  }

  /**
   * Check if a finger is extended by comparing distance-from-wrist of the
   * tip vs the PIP joint (a straightened finger reaches clearly farther).
   *
   * This is scale-invariant (works at any hand size/distance) and
   * orientation-robust. The previous fixed y-offset threshold broke when the
   * hand tilted or the camera angle changed — a classic source of gestures
   * "changing on their own" and sessions aborting mid-use.
   */
  private isFingerExtended(tip: Landmark, pip: Landmark, wrist: Landmark): boolean {
    const pipDist = this.dist(pip, wrist);
    // Degenerate input (PIP coincides with the wrist) — cannot judge.
    if (pipDist < 1e-4) return false;
    return this.dist(tip, wrist) > pipDist * 1.12;
  }

  /**
   * Curl test for the NATURAL GRAB (mirrors isFingerExtended's convention:
   * an unreadable finger counts as curled, matching the old all-curled
   * contract where a degenerate PIP read as "not extended").
   */
  private isFingerCurled(tip: Landmark, pip: Landmark, wrist: Landmark): boolean {
    const pipDist = this.dist(pip, wrist);
    if (pipDist < 1e-4) return true;
    return this.dist(tip, wrist) < pipDist * NATURAL_GRAB_CURL_RATIO;
  }

  /**
   * NATURAL GRAB: a relaxed grab/closed-hand pose.
   *
   * The old contract required ALL FOUR fingers to be curled below the strict
   * extension line — one naturally slacker finger flipped the flag and the
   * pose fell to NONE/POINT, forcing users into an exaggerated fist. The
   * natural contract:
   *   • index NOT extended (strict 1.12 line — preserves POINT semantics);
   *   • ≥2 of the remaining three fingers curled at the tolerant 1.25
   *     ratio — one finger may drift (natural variation); a half-open hand
   *     (1 curled) stays ambiguous (NONE) rather than guessing.
   * Overlap safety: SCALE_POSE needs three EXTENDED fingers and OPEN_PALM/
   * ROTATE_3 need three or four — a ≥3-curled hand can satisfy none of
   * them, and SCALE_POSE/PINCH are checked before this anyway.
   */
  private isNaturalGrab(landmarks: Landmark[], fs: FingerState): boolean {
    // The INDEX keeps the strict contract: a clearly extended index with
    // the rest curled is a POINT and is never stolen (a natural grab's
    // index is curled; a mid-closure drift reads POINT transiently until
    // the 1 s confirmation sees the settled pose). The natural-variation
    // tolerance applies to the remaining three fingers.
    if (fs.index) return false;
    const wrist = landmarks[0];
    const curledCount =
      (this.isFingerCurled(landmarks[MIDDLE_TIP], landmarks[MIDDLE_PIP], wrist) ? 1 : 0) +
      (this.isFingerCurled(landmarks[RING_TIP], landmarks[RING_PIP], wrist) ? 1 : 0) +
      (this.isFingerCurled(landmarks[PINKY_TIP], landmarks[PINKY_PIP], wrist) ? 1 : 0);
    return curledCount >= NATURAL_GRAB_MIN_CURL;
  }

  /**
   * Fully-closed-hand test (the geometric signature of a FIST, thumb
   * irrelevant): all four fingers curled at the tolerant grab ratio. Note
   * this is a 2D-projection test only — a side-view pinch's index can
   * project exactly like a fist's folded index — so it must never gate the
   * pinch decision by itself; it only SELECTS the tighter fist-aware pinch
   * threshold (see the PINCH branch in determineGesture).
   */
  private isFistCurl(landmarks: Landmark[]): boolean {
    const wrist = landmarks[0];
    return (
      this.isFingerCurled(landmarks[INDEX_TIP], landmarks[INDEX_PIP], wrist) &&
      this.isFingerCurled(landmarks[MIDDLE_TIP], landmarks[MIDDLE_PIP], wrist) &&
      this.isFingerCurled(landmarks[RING_TIP], landmarks[RING_PIP], wrist) &&
      this.isFingerCurled(landmarks[PINKY_TIP], landmarks[PINKY_PIP], wrist)
    );
  }

  private dist(a: Landmark, b: Landmark): number {
    return Math.sqrt(
      (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + ((a.z ?? 0) - (b.z ?? 0)) ** 2,
    );
  }

  /**
   * Check if thumb is extended.
   * Compares thumb tip distance from wrist vs thumb MCP distance from wrist.
   * MediaPipe landmark 0 = wrist, 1 = thumb CMC, 2 = thumb MCP, 4 = thumb tip.
   */
  private isThumbExtended(landmarks: Landmark[]): boolean {
    const wrist = landmarks[0];
    const thumbTip = landmarks[4];
    const thumbIP = landmarks[3];

    // Distance from wrist to thumb tip
    const tipDist = Math.sqrt(
      (thumbTip.x - wrist.x) ** 2 +
      (thumbTip.y - wrist.y) ** 2 +
      (thumbTip.z - wrist.z) ** 2,
    );

    // Distance from wrist to thumb IP joint (intermediate reference)
    const ipDist = Math.sqrt(
      (thumbIP.x - wrist.x) ** 2 +
      (thumbIP.y - wrist.y) ** 2 +
      (thumbIP.z - wrist.z) ** 2,
    );

    // Thumb is extended if tip is significantly farther from wrist than IP joint
    return tipDist > ipDist * 1.15;
  }
}

/**
 * Pinch-enter threshold as a fraction of the palm span. A deliberate
 * pinch brings the thumb tip well within a quarter of the wrist→MCP
 * distance; finger-extension ambiguity cannot produce that geometry.
 * Wider than the old effective threshold (~0.17 after z-noise) so that
 * borderline finger-curl noise classifies as PINCH, not GRAB.
 */
export const PINCH_ON = 0.28;

/**
 * Pinch-exit threshold for hysteresis: once pinching, the gap must open
 * past this FRACTION OF THE PALM SPAN before the gesture is allowed to
 * leave PINCH. Expressed in span units — multiply by palmSpan to compare
 * against an absolute pinch distance. Kept below PINCH_ON so the two
 * thresholds never cross.
 */
export const PINCH_OFF_SPAN = 0.45;

/**
 * SCALE_POSE tip-join threshold as a fraction of the palm span: thumb tip
 * and index tip must be at/behind this gap for the open hand to read as
 * the fixed scale pose. Aligned with PINCH_ON (0.28): with the three-fingers
 * state as the discriminator, ANY pinch-closeness grip on an otherwise open
 * hand is unambiguously the OK pose — there is no competing interpretation
 * left (a curled-finger pinch still classifies PINCH, which maps to no
 * mode). Keeping the thresholds equal removes the [0.18, 0.28) dead zone
 * where a slightly loose "touching" fell through to PINCH.
 */
export const SCALE_POSE_TIP_JOIN = 0.28;

/**
 * Curl tolerance for the NATURAL GRAB: a finger counts as curled while its
 * tip is closer to the wrist than 1.25× its PIP distance. Sits ABOVE the
 * 1.12 extension line on purpose — the [1.12, 1.25] band is where a
 * comfortable, unforced grab's fingers actually live — while a clearly
 * reaching finger (beyond NATURAL_GRAB_POINT_LINE) is never a grab.
 */
export const NATURAL_GRAB_CURL_RATIO = 1.25;

/**
 * Minimum curled fingers for the NATURAL GRAB among MIDDLE/RING/PINKY
 * (the index is handled strictly — see isNaturalGrab): 2 of 3. One of them
 * may drift open without losing the gesture; a genuinely half-open hand
 * (1 curled) stays ambiguous (NONE) rather than confidently picking the
 * wrong mode.
 */
export const NATURAL_GRAB_MIN_CURL = 2;

/**
 * Pinch-enter threshold on a COMPACT (all-curled) hand, as a fraction of
 * the palm span. A deliberate pinch closes fingertip-to-fingertip — well
 * under one finger-width (~0.25–0.35 span) — while a natural fist's draped
 * thumb rests ABOUT one finger-width from the index tip. 0.22 sits between
 * the two: real pinches still enter (the pinch hysteresis then holds them
 * to the 0.45 exit line), and the draped-thumb fist is freed for the
 * natural GRAB. Must stay below PINCH_ON and comfortably below
 * PINCH_OFF_SPAN.
 */
export const PINCH_ON_CURLED = 0.22;
