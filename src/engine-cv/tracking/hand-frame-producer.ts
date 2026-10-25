/**
 * Module Builder V1.1 — HandFrame Producer
 *
 * Processes MediaPipe hand detection results into a single HandFrame.
 * One producer, one pipeline, one HandFrame per processing cycle.
 *
 * Source of truth: Doc 04 §10, Doc 05 §4.1, D-019
 */

import type {
  HandFrame,
  HandState,
  TimestampMs,
  PointerState,
} from '../../core/contracts';
import {
  GestureClassifier,
  palmSpan,
  pinchGap,
  PINCH_OFF_SPAN,
} from './gesture-classifier';

// ─── MediaPipe result types (subset for @mediapipe/tasks-vision) ──

interface MPLandmark {
  x: number;
  y: number;
  z: number;
}

interface MPHandedness {
  categoryName: string;
  score: number;
}

interface MPResult {
  landmarks: MPLandmark[][];
  handedness: MPHandedness[][];
  worldLandmarks?: MPLandmark[][];
}

// ─── HandFrame Producer ─────────────────────────────────

/**
 * How long the pointer's POSITION stays after POINT is lost (misread tolerance).
 */
const POINTER_HOLD_MS = 150;
/**
 * How long the pointer's EXISTENCE stays after the pointing hand switches to a
 * transform gesture (GRAB/PINCH/OPEN_PALM). The tab context was set by hovering
 * with POINT; the camera/transform gesture that follows must not have the
 * context yanked away from under it — otherwise the first gesture frame returns
 * to MODULE context and viewport control can never receive a gesture.
 */
const POINTER_LINGER_MS = 1200;

export class HandFrameProducer {
  private classifier: GestureClassifier;
  private smoothedPointers = new Map<string, { x: number; y: number }>();
  /** Last pointer + expiry — keeps the cursor from blinking on flickers. */
  private lastPointer: { state: PointerState; untilMs: TimestampMs; untilLingerMs: TimestampMs } | null = null;
  /** Per-hand pinch hysteresis state: once pinching, stay PINCH until the
   * thumb-index gap clearly reopens. Without this, borderline pinches sit
   * at the classifier's single threshold and flip PINCH ↔ GRAB — which the
   * session controller reads as an accidental MOVE mid-scale. */
  private pinchState = new Map<string, boolean>();


  constructor() {
    this.classifier = new GestureClassifier();
  }

  /**
   * Process a MediaPipe result into a HandFrame.
   * This is called once per video frame.
   */
  processFrame(mpResult: MPResult, timestamp: TimestampMs): HandFrame {
    // ── Handedness slot assignment (DIRECT mapping) ──
    // Verified against live hardware: this pipeline's handedness labels map
    // DIRECTLY to the user's physical hands — MediaPipe category "Left" =
    // the user's LEFT hand, "Right" = the RIGHT hand. (The general
    // "mirrored-input" swap convention does NOT apply to this capture
    // path; swapping inverted the hand roles in live testing.) The slot
    // label therefore equals the physical hand: right slot = transformation
    // owner, left slot = pause + UI pointer.
    const leftHand = this.processHand(mpResult, 'left');
    const rightHand = this.processHand(mpResult, 'right');

    // ── UI-pointer hand ownership ──
    // The hand that is currently the UI pointer KEEPS pointer ownership; a
    // right hand never "steals" it by starting to point (or by performing a
    // transform gesture). Otherwise hovering UI with the left index while the
    // right hand points would teleport the cursor across the screen and
    // collapse the open context.
    //
    // Ownership resolution, in order:
    //   1. The previous pointer's hand, if it is still pointing (sticky).
    //   2. LEFT hand if it points (fixed preference — LEFT = UI role).
    //   3. RIGHT hand (only when no left hand is present/pointing, e.g. it
    //      is off-frame or being used as the transform hand).
    //
    // Note MediaPipe's handedness category can flip when the palm faces the
    // camera; resolving by role preference (left first, sticky owner) keeps
    // the pointer stable across such flips.
    const leftPointing = !!leftHand && leftHand.gesture === 'POINT';
    const rightPointing = !!rightHand && rightHand.gesture === 'POINT';
    const ownedHand = this.lastPointer?.state.active
      ? this.lastPointer.state.sourceHand
      : null;
    const pointingHand = (() => {
      if (ownedHand === 'left' && leftPointing) return leftHand;
      if (ownedHand === 'right' && rightPointing) return rightHand;
      if (leftPointing) return leftHand;
      if (rightPointing) return rightHand;
      return null;
    })();

    const pointer = this.derivePointerState(pointingHand, timestamp);

    // ── Gesture-linger: keep the pointer (frozen position) alive while the
    // pointing hand has switched to a transform gesture. The UI context was
    // established by hovering; killing the pointer the instant the gesture
    // starts returns to MODULE context and Viewport Control can never act.
    // The last pointer's position is intentionally NOT re-mirrored/re-smoothed
    // — it is a held snapshot, exactly like the existing 150 ms misread hold.
    if (!pointer && this.lastPointer && this.lastPointer.state.active) {
      const sourceHand =
        this.lastPointer.state.sourceHand === 'right' ? rightHand : leftHand;
      const g = sourceHand?.gesture;
      if (
        sourceHand &&
        sourceHand.active &&
        (g === 'GRAB' || g === 'PINCH' || g === 'OPEN_PALM' || g === 'SCALE_POSE') &&
        timestamp <= this.lastPointer.untilLingerMs
      ) {
        return {
          timestamp,
          leftHand,
          rightHand,
          trackingConfidence: this.calculateConfidence(leftHand, rightHand),
          pointer: this.lastPointer.state,

        };
      }
    }

    return {
      timestamp,
      leftHand,
      rightHand,
      trackingConfidence: this.calculateConfidence(leftHand, rightHand),
      pointer,
    };
  }

  /**
   * Process a single hand from MediaPipe results.
   */
  private processHand(mpResult: MPResult, handedness: 'left' | 'right'): HandState | null {
    const handIdx = this.findHandIndex(mpResult, handedness);
    if (handIdx === -1) return null;

    const landmarks = mpResult.landmarks[handIdx];
    if (!landmarks || landmarks.length < 21) {
      return null;
    }

    // Classify gesture
    const { gesture: rawGesture, fingerState } = this.classifier.classify(landmarks);

    // Pinch/GRAB hysteresis: enter at the classifier's threshold, exit only
    // once the gap clearly reopens (a larger fraction of the palm span).
    // At the boundary the finger-extension state is unreadable — holding the
    // previous state is the only correct answer.
    const span = palmSpan(landmarks);
    const gap = pinchGap(landmarks);
    const wasPinching = this.pinchState.get(handedness) ?? false;
    const isPinch = wasPinching
      ? span > 1e-4 && gap < span * PINCH_OFF_SPAN && rawGesture !== 'SCALE_POSE'
      : rawGesture === 'PINCH';
    this.pinchState.set(handedness, isPinch);
    const gesture = isPinch ? 'PINCH' : rawGesture;

    // Calculate key positions
    const center = this.calculateCenter(landmarks);
    const wrist = { x: landmarks[0].x, y: landmarks[0].y, z: landmarks[0].z ?? 0 };
    const indexTip = { x: landmarks[8].x, y: landmarks[8].y, z: landmarks[8].z ?? 0 };

    // Pinch distance: 2D thumb-tip ↔ index-tip gap in normalized frame units
    // (shared helper — matches the classifier's thresholds exactly; the old
    // 3D version included MediaPipe's noisy z landmark).
    const pinchDistance = gap;

    return {
      active: true,
      handedness,
      landmarks: landmarks.map(l => ({ x: l.x, y: l.y, z: l.z ?? 0 })),
      center,
      wrist,
      indexTip,
      pinchDistance,
      fingerState,
      gesture,
      confidence: this.estimateConfidence(landmarks, mpResult, handIdx),
    };
  }

  /**
   * Blend MediaPipe's handedness score with a landmark-plausibility term.
   * The previous hardcoded 0.8 made the confidence gates in the session
   * controller meaningless — tiny/far/ambiguous hands started sessions just
   * as easily as well-tracked ones, producing erratic transforms.
   */
  private estimateConfidence(
    landmarks: MPLandmark[],
    mpResult: MPResult,
    handIdx: number,
  ): number {
    const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
    const score = clamp01(mpResult.handedness?.[handIdx]?.[0]?.score ?? 0.8);

    // Plausibility from palm size: a hand spanning <5% of the frame is barely
    // trackable; above ~11% it is fully reliable.
    // Same 2D span the classifier uses — z noise made this flicker too.
    const span = palmSpan(landmarks);
    const spanQuality = clamp01((span - 0.05) / 0.06);

    return clamp01(0.65 * score + 0.35 * spanQuality);
  }

  /**
   * Find which MediaPipe result index corresponds to a handedness.
   * @mediapipe/tasks-vision returns handedness as [{categoryName: "Left", score: 0.9}]
   */
  private findHandIndex(mpResult: MPResult, handedness: 'left' | 'right'): number {
    if (!mpResult.handedness || mpResult.handedness.length === 0) return -1;

    for (let i = 0; i < mpResult.handedness.length; i++) {
      const handArray = mpResult.handedness[i];
      if (!handArray || handArray.length === 0) continue;

      const category = handArray[0]?.categoryName?.toLowerCase() || '';
      if (handedness === 'left' && category.includes('left')) return i;
      if (handedness === 'right' && category.includes('right')) return i;
    }
    return -1;
  }

  /**
   * Calculate the PALM center of the hand.
   *
   * Uses only the wrist, finger MCPs, and thumb CMC — the knuckle block,
   * which stays rigid regardless of what the fingers do. Averaging all 21
   * landmarks (the previous behavior) let every finger curl drag the
   * centroid: opening a pinch would shift the center by a third of the
   * finger length, which the controller converts into phantom MOVE/ROTATE
   * drift whenever a MOVE session is live or a gesture switch is pending.
   */
  private calculateCenter(landmarks: MPLandmark[]): { x: number; y: number; z: number } {
    const PALM_IDX = [0, 1, 5, 9, 13, 17];
    let sumX = 0, sumY = 0, sumZ = 0;
    for (const i of PALM_IDX) {
      const lm = landmarks[i];
      if (!lm) return { x: 0, y: 0, z: 0 }; // degenerate — validated downstream
      sumX += lm.x;
      sumY += lm.y;
      sumZ += lm.z ?? 0;
    }
    return { x: sumX / PALM_IDX.length, y: sumY / PALM_IDX.length, z: sumZ / PALM_IDX.length };
  }

  /**
   * Derive UI pointer state from whichever hand is pointing.
   */
  private derivePointerState(
    pointingHand: HandState | null,
    now: TimestampMs,
  ): PointerState | null {
    if (pointingHand && pointingHand.gesture === 'POINT' && pointingHand.indexTip) {
      const x = pointingHand.indexTip.x;
      const y = pointingHand.indexTip.y;

      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return this.heldPointer(now);
      }

      const smoothed = this.smoothPointer(pointingHand.handedness, 1 - x, y);
      const pointer: PointerState = {
        active: true,
        sourceHand: pointingHand.handedness,
        x: smoothed.x,
        y: smoothed.y,
        hoveredTargetId: null,
        candidateTargetId: null,
        stableSinceMs: null,
      };
      this.lastPointer = {
        state: pointer,
        untilMs: now + POINTER_HOLD_MS,
        untilLingerMs: now + POINTER_LINGER_MS,
      };
      return pointer;
    }
    return this.heldPointer(now);
  }

  /**
   * Briefly hold the last pointer during POINT-classification flickers so
   * the on-screen cursor does not blink in and out every few frames.
   */
  private heldPointer(now: TimestampMs): PointerState | null {
    if (this.lastPointer && now <= this.lastPointer.untilMs) {
      return this.lastPointer.state;
    }
    // Position-hold expired: return null but KEEP the record — the gesture
    // linger window (untilLingerMs) is checked separately in processFrame.
    // Nulling here destroyed that record before the linger check ever ran,
    // which silently disabled the whole linger mechanism.
    return null;
  }

  /**
   * Smooth pointer position with exponential moving average.
   */
  private smoothPointer(key: string, x: number, y: number): { x: number; y: number } {
    const prev = this.smoothedPointers.get(key);
    const alpha = 0.25; // Reduced from 0.4 to cut latency (~160ms vs ~270ms to 99% at 60fps)

    if (!prev) {
      const pos = { x, y };
      this.smoothedPointers.set(key, pos);
      return pos;
    }

    prev.x = prev.x + alpha * (x - prev.x);
    prev.y = prev.y + alpha * (y - prev.y);
    return prev;
  }

  /**
   * Calculate overall tracking confidence.
   */
  private calculateConfidence(left: HandState | null, right: HandState | null): number {
    let total = 0;
    let count = 0;

    if (left) { total += left.confidence; count++; }
    if (right) { total += right.confidence; count++; }

    return count > 0 ? total / count : 0;
  }

  /**
   * Reset smoothed pointers (for testing and state resets).
   */
  reset(): void {
    this.smoothedPointers.clear();
    this.lastPointer = null;
    this.pinchState.clear();
  }
}
