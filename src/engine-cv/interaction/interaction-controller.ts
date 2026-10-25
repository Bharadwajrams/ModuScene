/**
 * Module Builder V2.0 — Interaction Controller (the ONE transformation brain)
 *
 * Replaces the old SessionController entirely.
 *
 * ── Architecture ─────────────────────────────────────────────
 *
 *   Hand tracking (untouched) → this controller → 3D object
 *
 * There is exactly ONE active mode at any time:
 *
 *   ACTIVE_MODE ∈ { NONE, MOVE, ROTATE, SCALE }
 *
 *   GRAB       → MOVE
 *   OPEN_PALM  → ROTATE
 *   SCALE_POSE → SCALE (thumb+index touching, three fingers open — STATIC
 *                pose; the pose never changes during the operation)
 *
 * Gesture recognition (the classifier + producer) always runs, but
 * transformation EXECUTION is locked to the active mode: when MOVE is
 * active, only the move math runs. Other gestures are still observed —
 * solely so the mode can be changed — and changing mode requires holding
 * the new gesture for MODE_CONFIRM_MS (~1 s). While a different-mode
 * candidate is being confirmed, the old mode's execution is frozen
 * (its gesture is gone; running its math would read the new hand pose
 * as phantom input).
 *
 * Left-hand OPEN_PALM pauses the active transformation and, on release,
 * re-anchors the right-hand control position — so the user can reposition
 * (e.g. re-grip a scale) without the object jumping.
 *
 * Stability model per mode (absolute-anchored, self-correcting):
 *   target = (smoothed hand − anchor) × gain; emitted = capped correction
 *   (target − already-applied). Noise averages out instead of integrating;
 *   once the object reaches the target it stays there.
 *   MOVE    anchor on palm center (X/Y) and palm span (Z).
 *   ROTATE  anchor on slow-smoothed center channels.
 *   SCALE   anchor on the hand's vertical position: hand UP from the
 *           baseline = grow, hand DOWN = shrink, proportional. The baseline
 *           is captured at mode confirmation (and refreshed at every pause
 *           re-anchor), so the full hand range is usable in any direction
 *           and the scale never jumps on activation.
 *
 * Every emitted delta is deadzoned (with Schmitt hysteresis), velocity-
 * capped, and validated non-finite. A single noisy frame can neither
 * switch the mode (1 s confirm) nor corrupt state (grace window, teleport
 * guard, try/catch around the whole frame).
 */

import type {
  CVInteractionState,
  CVMode,
  CVTransformDelta,
  Gesture,
  HandFrame,
  HandState,
  SessionId,
  TimestampMs,
} from '../../core/contracts';

// ─── Timing constants ─────────────────────────────────────

/** Hold the new gesture this long to change the active mode (~1 s). */
export const MODE_CONFIRM_MS = 1000;
/** Left-palm pause engages after this many consistent OPEN_PALM frames. */
const PAUSE_CONFIRM_FRAMES = 12;
/** After the left palm disappears, stay frozen this long before resuming. */
const PAUSE_RELEASE_GRACE_MS = 700;
/** Tracking dropout shorter than this freezes (doesn't corrupt) the transform.
 * Also the HAND-GONE window of the session-lifecycle gate: a confirmed
 * transformation ends only after BOTH slots have been unusable for this
 * long — misreads and single-slot dropouts can never reach it. */
const TRACKING_LOSS_GRACE_MS = 350;

/**
 * Axis-selection context window (the pause-vs-selection disambiguation).
 *
 * The Z axis is selected by holding THREE left fingers — the pose one step
 * from OPEN_PALM. On a real hand the pinky naturally drifts open, the
 * classifier then reads FOUR fingers (OPEN_PALM), and the left-palm pause
 * engaged while the user believed they were selecting/driving Z: the object
 * went dead on Z (X: 1 finger, Y: 2 fingers are far from the collision).
 *
 * Resolution by recency: an axis-selection count (1–3 fingers) marks the
 * left hand as the ACTIVE AXIS-SELECTION channel. For this long afterwards,
 * its 4-finger OPEN_PALM reads as "the selection hand is still present",
 * NOT as a pause request. A deliberate pause (an open palm with no recent
 * selection activity) is untouched.
 */
const AXIS_SELECTION_CONTEXT_MS = 500;

/**
 * ROTATE execution hold (T-03) — bounded tolerance of pose-label flicker.
 *
 * Rotation is a velocity integrator with NO angular state, but its per-frame
 * execution gate consumed the classifier's pose label with zero forgiveness:
 * a rotating palm naturally approaches edge-on, the label starts flipping
 * (OPEN_PALM ↔ ROTATE_3 — which maps to no mode) at a rate that grows with
 * foreshortening, and every flip frame emitted exactly zero rotation while
 * the velocity channels still carried valid hand motion — the stick/bob.
 *
 * While ROTATE is active, execution may continue for up to this long after
 * the last frame whose gesture mapped to ROTATE. Bounded so a sustained
 * misread still ends by the existing contract: mode confirmation (~1 s) and
 * the session-lifecycle gate are untouched — a misread landing on GRAB and
 * held ≥ MODE_CONFIRM_MS still hands off to MOVE. Kept well clear of the
 * confirmation window by design.
 */
const ROTATE_EXECUTION_HOLD_MS = 250;

/**
 * Handedness-flip rescue window (live-session continuity ONLY).
 *
 * A left-slot transform gesture is promoted into the transformation
 * pipeline ONLY while a transformation session is live and the right slot
 * held a valid hand within this window — i.e. MediaPipe relabeled the
 * ALREADY-TRANSFORMING hand mid-session. An idle left fist/pinch (no live
 * session, or the right hand long gone) NEVER enters the pipeline:
 * LEFT owns pause + UI pointer only, never MOVE/ROTATE/SCALE.
 */
const LIVE_SESSION_RESCUE_MS = 450;

// ─── Sensitivity / smoothing constants ────────────────────

/** EMA for the movement channel (responsive). */
const EMA_CENTER = 0.5;
/** EMA for the rotation channels (rotation tolerates latency; heavy
 * smoothing is what keeps hand tremor out of the object). */
/** EMA for scalar channels (pinch distance, palm depth). */
const EMA_SCALAR = 0.2;
/**
 * Dedicated SLOW channels. Depth (palm span) is the noisiest signal in the
 * pipeline — spread-hand pose variance appears as apparent-depth noise — so
 * it gets heavier smoothing than X/Y center. Rotation channels likewise need
 * to lag fast tremor: they feed an anchored correction, so any noise that
 * crosses the deadzone rectifies into visible wobble.
 */
const EMA_DEPTH_SLOW = 0.15;
const EMA_ROT_SLOW = 0.12;
/** Velocity-channel smoothing (frame-to-frame raw center deltas). */
const EMA_VEL = 0.3;
/**
 * Stillness gate: raw movement below this (normalized frame units) counts as
 * the hand being still — slow drift-prone channels freeze instead of tracking.
 * Calibrated above landmark tremor (±0.002–0.003) and below deliberate motion.
 */
const STILLNESS_EPS = 0.004;
const STILLNESS_EPS_SCALAR = 0.006;

/** Full-frame hand travel maps to this many world units. */
const MOVE_UNITS_PER_SCREEN = 4.0;
/** Palm apparent-size change (toward/away camera) gain for MOVE Z.
 *  Rebalanced from 6.0: a comfortable depth push changes palm span by only
 *  ~8–12% (≈0.01–0.018 in span units), which at gain 6 produced 0.06–0.11
 *  world units — 5–10× weaker than an equivalent X/Y flick. 10.0 maps the
 *  same comfortable push to ≈1.0 world unit, matching X/Y effort.
 *  (Noise safety: the slow EMA attenuates 8–12 Hz tremor to ±0.0003 span
 *  → ±0.003 world units, far below the Z deadzone.) */
const MOVE_Z_UNITS_PER_DEPTH = 10.0;
/**
 * Per-frame Z step cap (MOVE). Deliberately ~half the X/Y cap: span noise
 * that survives the deadzone arrives as spikes, and an oversized Z step
 * reads as wobble. Deliberate depth motion still passes (multiple frames).
 */
const MAX_STEP_MOVE_Z = 0.07;
/** Full-frame hand travel maps to this many radians. */
/**
 * ROTATE is VELOCITY-based (joystick semantics): the smoothed hand velocity
 * drives rotation SPEED. This removes the anchored-position chase dynamics —
 * the wobble source: when the hand stops, velocity decays to zero and rotation
 * STOPS (no target chasing, no deadzone-edge oscillation, no re-anchor need).
 * Tremor (zero-mean, ~8 Hz) averages out in the velocity channel below the
 * deadband; a deliberate sweep passes cleanly.
 */
const ROT_VEL_GAIN = 5.0;
/**
 * Rotation deadzone on the smoothed VELOCITY channel. Deliberately low:
 * the EMA already averages zero-mean landmark tremor down to ~±0.0007 and
 * posture drift converges below this line, while a slow DELIBERATE rotation
 * (~0.002/frame) converges above it — so small intentional rotations pass
 * proportionally instead of being clipped by a minimum-response threshold.
 */
const DEADZONE_ROT_VEL = 0.0012;
/**
 * T-04 velocity-sputter bridge — how long the last above-gate drive value
 * keeps turning the object (decayed) after the slow channel dips under the
 * gate, while the hand is still visibly moving.
 *
 * Derived from the live rotation capture (rot3-full.json, 1200 frames): the
 * duration distribution of sub-gate silent windows is bimodal — deliberate
 * mid-stroke sputter windows all end within 499 ms, while the genuine
 * hover/stop class starts at 829 ms. 500 ms covers the entire deliberate
 * class and expires inside the gap between the classes, so a genuine stop
 * settles strictly faster than the slowest deliberate sputter was ever
 * muted before this change.
 *
 * Deliberately NOT related to T-03's ROTATE_EXECUTION_HOLD_MS (250 ms —
 * gesture-label continuity) nor to MODE_CONFIRM_MS (1 s — mode switching):
 * this window bounds the VELOCITY channel's continuity only.
 */
const ROTATE_VEL_HOLD_MS = 500;
/** Per-frame carry decay applied to the bridged value while the channel is
 * sub-gate. ×0.8: the largest fixture-observed carry (0.0034) falls below the
 * gate within ~5 frames (0.8^5 ≈ 0.33), so the bridge never outlives its
 * 500 ms window; worst-case stop coast = carry·d/(1−d)·ROT_VEL_GAIN ≈
 0.06 rad — inside T-03's L14 bound (0.08) — and a fast-stroke stop stays
 * ≈ 0.12 rad, inside the L15b bound (0.25). */
const ROTATE_VEL_CARRY_DECAY = 0.8;
/** T-04: hard cap on consecutive bridged frames. Bounds the stop-coast by
 * construction: worst-case bridge contribution ≈ carry·ROT_VEL_GAIN·Σ0.8^k
 * (k=0..5) ≈ 0.035 rad for a slow-stroke stop — inside T-03's L14 budget
 * (total ≤ 0.08) — while still covering the fixture's typical deliberate
 * sputter runs (3–7 frames). Longer sub-gate stretches are the hover/stop
 * class (≥829 ms in the capture) where silence is correct. */
const ROTATE_VEL_CARRY_MAX_FRAMES = 6;
/** Per-frame velocity caps — the object can never lunge. */
const MAX_STEP_MOVE = 0.15;
const MAX_STEP_ROTATE = 0.08;
/** Scale change per full-frame vertical hand travel (baseline-relative).
 *  The scale pose is STATIC — the amount comes ONLY from the right hand's
 *  vertical movement relative to the baseline captured at mode entry (or
 *  the last pause re-anchor). 1.0 = a quarter-screen sweep ≈ ×1.25. */
const SCALE_UNITS_PER_SCREEN = 1.0;
const MAX_STEP_SCALE = 0.06;

/** Deadzones + Schmitt hysteresis (emission resume/stop at two thresholds). */
const DEADZONE_MOVE = 0.004;
/**
 * Z deadzone, in WORLD units on the anchored target. Lowered from 0.04:
 * the old value sat ABOVE a normal deliberate depth push (5–8% of span →
 * 0.03–0.05 world units at the old gain), so typical pushes emitted
 * nothing at all — Z felt dead. 0.02 sits at the EMA'd tremor floor
 * (±0.003 world units after the slow EMA) while still clearing pose
 * variance; the Schmitt hysteresis (exit at /1.5) plus the per-frame cap
 * keep the channel quiet on a stationary hand.
 */
const DEADZONE_MOVE_Z = 0.02;
const DEADZONE_SCALE = 0.0025;
const DEADZONE_HYSTERESIS = 1.5;

/** Normalized-frame jump indicating a tracker glitch (teleport guard). */
const TELEPORT_SNAP = 0.4;
const TELEPORT_SNAP_SCALAR = 0.12;

// ─── Helpers ──────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isFiniteVec3(v: { x: number; y: number; z: number } | undefined | null): boolean {
  return !!v && isFiniteNumber(v.x) && isFiniteNumber(v.y) && isFiniteNumber(v.z);
}

/** Map a transformation gesture to its mode (the ONE mapping). */
export function gestureToMode(gesture: Gesture): Exclude<CVMode, 'NONE'> | null {
  switch (gesture) {
    case 'GRAB': return 'MOVE';
    case 'OPEN_PALM': return 'ROTATE';
    case 'SCALE_POSE': return 'SCALE';
    default: return null;
  }
}

/** Smoothed right-hand signals used for anchor/target math. */
interface SmoothedHand {
  cx: number;
  cy: number;
  /** Slow rotation-drive channels (heavily smoothed cx/cy). */
  rotCx: number;
  rotCy: number;
  /** Palm apparent size (wrist→middle-MCP span) — the depth proxy. */
  depth: number;
  /** 2D thumb–index distance. */
  pinch: number;
  /** Slow vertical control channel — the NEW SCALE input (pose is static;
   *  the anchor-relative vertical delta is the scale amount). */
  scaleY: number;
}

/** Per-frame payload handed to the delta consumer (objectId is filled by
 * the CV engine, which owns selection state). */
export interface DeltaPayload {
  delta: CVTransformDelta;
  phase: 'BEGIN' | 'UPDATE' | 'END';
  timestamp: TimestampMs;
  sessionId: SessionId;
}

const IDENTITY_DELTA: CVTransformDelta = {
  mode: 'MOVE',
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
  scale: { x: 1, y: 1, z: 1 },
};

// ─── Interaction Controller ───────────────────────────────

export class InteractionController {
  private sessionId: SessionId = 'cv-session-1';

  // ── The ONE source of truth ──
  private mode: CVMode = 'NONE';
  private paused = false;

  // Mode-change confirmation (1 s hold)
  private confirmGesture: Gesture | null = null;
  private confirmMode: Exclude<CVMode, 'NONE'> | null = null;
  private confirmStart: TimestampMs | null = null;

  /** T-03: most recent frame in which the RIGHT hand's gesture mapped to
   * ROTATE — the anchor of the bounded ROTATE execution hold (see
   * ROTATE_EXECUTION_HOLD_MS). Execution-only state: never affects mode
   * confirmation or session lifetime. */
  private lastRotateReadableMs: TimestampMs | null = null;



  /**
   * Axis-selection context (see AXIS_SELECTION_CONTEXT_MS): the most recent
   * frame time at which the left hand showed a selection finger count (1–3).
   * While the pause decision is inside this window, a left OPEN_PALM is
   * read as "the selection hand drifted open", not as a pause request —
   * and PAUSE_CONFIRM frames are only earned after the window expires.
   */
  private lastSelectionSeenMs: TimestampMs | null = null;
  // Pause bookkeeping (left palm requires PAUSE_CONFIRM_FRAMES frames)
  private pauseFrames = 0;
  /** When the left palm disappeared while paused (resume grace window). */
  private pauseGraceSince: TimestampMs | null = null;
  /** Velocity channels for velocity-based ROTATE (EMA of raw center deltas).
   *  T-06: BOTH axes drive from the fast channel (X: velCy, Y/Z: velCx) —
   *  identical velocity-processing model, mirrored input axis. Vertical-bob
   *  idle safety is the shared gate stack (DEADZONE_ROT_VEL ≈ 2× bob residual
   *  + the T-04 carry, which never re-injects sub-gate values), the same
   *  protection Y/Z have always had. */
  private velCx = 0;
  private velCy = 0;
  /** T-04: last frame at which the ROTATE drive channel was at or above the
   * execution gate, and a damped copy of that drive value. While the channel
   * is sub-gate (stroke curvature / reversal lag), rotation keeps emitting
   * from the DECAYED copy for ROTATE_VEL_HOLD_MS — bounded, never sourced
   * from the raw sub-gate channel, never carried across a hard reset. */
  private lastAboveGateMs: TimestampMs | null = null;
  private aboveGateCarry = 0;
  /** T-04: consecutive bridged (sub-gate) frames emitted from the carry. */
  private bridgeFrames = 0;

  /** Stillness-gate state (frozen slow channels; Schmitt re-arm). */
  private stillFrozen = false;

  // Smoothing
  private smooth: SmoothedHand | null = null;

  // Mode anchor + emission bookkeeping (correction model)
  private anchor: SmoothedHand | null = null;
  private applied = 0;
  private inDeadzoneBand = true;

  // Tracking-loss grace
  private lastValidHandMs: TimestampMs | null = null;
  private inGraceLoss = false;

  // Glitch guard
  private prevRaw: { cx: number; cy: number; depth: number; pinch: number } | null = null;

  // Last valid right hand (for axis-change re-anchoring)
  private lastValidHand: HandState | null = null;

  /** Last time the RIGHT slot held ANY valid hand — the flip-rescue anchor
   * (see resolveEffectiveFrame). Presence, not gesture: a flip can happen
   * while the hand is pointing or open too. */
  private lastRightSlotSeenMs: TimestampMs | null = null;

  /** Last time the LEFT slot was co-visible with a HEALTHY right hand — the
   * flip-rescue disambiguator (see resolveEffectiveFrame). */
  private leftSlotSeenMs: TimestampMs | null = null;

  // Axis under control for MOVE/ROTATE (left-hand finger count; set by engine).
  // The LEFT hand owns axis selection (1–3 fingers) — see the selection-
  // context bookkeeping above and the pause disambiguation in processFrame.
  private controlAxis: 'X' | 'Y' | 'Z' = 'X';

  // UI context (MODULE = object transforms; VIEWPORT = camera control).
  // The controller freezes object execution entirely in VIEWPORT context —
  // the engine owns camera control there.
  private uiContext: 'MODULE' | 'VIEWPORT' = 'MODULE';

  // Output
  private lastInteraction: CVInteractionState = { mode: 'NONE', context: 'MODULE', paused: false, confirm: null };
  private lastFrameNow: TimestampMs = 0;

  // Callback
  private onFrameDelta: ((payload: DeltaPayload) => void) | null = null;

  /** Register the per-frame delta consumer. */
  onDelta(callback: (payload: DeltaPayload) => void): void {
    this.onFrameDelta = callback;
  }

  /**
   * Set the UI context. MODULE = gestures transform the selected object;
   * VIEWPORT = gestures are ignored for objects (the engine drives the
   * camera). Switching context freezes any active object transformation.
   */
  setUIContext(context: 'MODULE' | 'VIEWPORT'): void {
    if (context === this.uiContext) return;
    this.uiContext = context;
    if (context === 'VIEWPORT' && this.mode !== 'NONE') {
      this.endActiveMode(this.lastFrameNow, 'context switched to VIEWPORT');
    }
  }

  /** Set the axis under control (X/Y/Z). Re-anchors so the object never jumps. */
  setControlAxis(axis: 'X' | 'Y' | 'Z'): void {
    if (axis === this.controlAxis) return;
    this.controlAxis = axis;
    if (this.mode !== 'NONE' && this.lastValidHand) {
      this.reanchor(this.lastValidHand);
    }
  }

  /**
   * Handedness-flip resolution — decides whether a left-slot transform
   * gesture may enter the transformation pipeline.
   *
   * MediaPipe's handedness category can flip (palm facing the camera, hands
   * overlapping, frame edges). When it flips on the TRANSFORMING hand, its
   * landmarks land in the LEFT slot; if the gesture were dropped there,
   * MOVE/ROTATE/SCALE could never engage — the "transformations not
   * responding" failure. But an UNGATED promote lets a genuine LEFT fist or
   * pinch start a transformation — the "left hand triggers MOVE" failure.
   *
   * Resolution by temporal continuity — a flipped hand is the SAME hand the
   * right slot just saw; a genuine second hand is not:
   *
   *   1. Right slot OCCUPIED → no promotion, ever. The genuine right hand
   *      owns transformation selection; a simultaneous left GRAB/PINCH is
   *      fully isolated (LEFT = pause + UI pointer only).
   *   2. Live session + right slot seen within LIVE_SESSION_RESCUE_MS →
   *      promote (a mid-session relabel of the transforming hand must not
   *      kill it).
   *   3. Otherwise → IGNORE: no live session means a left GRAB/PINCH is a
   *      genuine left-hand gesture and must never select a mode (LEFT =
   *      pause + UI pointer only).
   *
   * The left OPEN_PALM (pause) and POINT (UI pointer) are never in the
   * promote set, so their left-hand roles are untouched in every branch.
   */
  private resolveEffectiveFrame(frame: HandFrame): HandFrame {
    try {
      const left = frame.leftHand;
      const right = frame.rightHand;
      if (right && right.active === true) return frame;
      if (
        left &&
        left.active === true &&
        this.mode !== 'NONE' &&
        this.lastRightSlotSeenMs !== null &&
        frame.timestamp - this.lastRightSlotSeenMs <= LIVE_SESSION_RESCUE_MS &&
        // Co-presence gate: promote ONLY when the left slot was recently
        // EMPTY — the signature of the transforming hand moving slots. An
        // axis-selection hand (3 fingers classifies as ROTATE_3 — the Z-axis
        // pose) is a PERSISTENT second hand: promoting it on a transient
        // right-slot dropout hijacked the session (the transforming gesture
        // vanished → MOVE died or the mode flipped to ROTATE — the "Z-axis
        // unreliable" defect; X's POINT and Y's 2-finger poses are not in
        // the promote set, which is why only Z suffered).
        (this.leftSlotSeenMs === null || frame.timestamp - this.leftSlotSeenMs > LIVE_SESSION_RESCUE_MS) &&
        (left.gesture === 'GRAB' || left.gesture === 'PINCH' || left.gesture === 'ROTATE_3' || left.gesture === 'SCALE_POSE')
      ) {
        return { ...frame, rightHand: left, leftHand: null };
      }
      return frame;
    } catch {
      return frame;
    }
  }

  /**
   * Process one hand frame. Never throws. Returns the current interaction
   * state for UI publication.
   */
  processFrame(frame: HandFrame, now: TimestampMs): CVInteractionState {
    this.lastFrameNow = now;
    try {
      // ── Left-slot co-presence bookkeeping (BEFORE promotion runs) ──
      // Record when the left slot is occupied SIMULTANEOUSLY with a healthy
      // right hand. A genuine MediaPipe relabel of the transforming hand
      // enters an EMPTY left slot (there was no left hand); an axis-selection
      // hand is co-visible long before the right-slot dropout it must never
      // be promoted on.
      if (
        frame.leftHand && frame.leftHand.active === true &&
        this.isValidHand(frame.leftHand, 0.3) &&
        this.isValidHand(frame.rightHand, 0.3)
      ) {
        this.leftSlotSeenMs = frame.timestamp;
      }
      // Handedness-flip fallback: MediaPipe occasionally re-classifies the
      // transforming (right) hand as Left — usually when the palm turns to
      // face the camera. If the right slot is empty but the left slot shows a
      // TRANSFORM gesture (GRAB/PINCH/ROTATE_3/SCALE_POSE), it is the same hand flipped:
      // promote it so the active session survives. (The left open palm stays
      // a pause gesture — OPEN_PALM is never promoted.)
      const effFrame = this.resolveEffectiveFrame(frame);
      this.updateSmoothing(effFrame);

      const right = effFrame.rightHand;
      const left = effFrame.leftHand;
      const rightValid = this.isValidHand(right, 0.3);

      // Snapshot last frame's raw pose BEFORE refreshing prevRaw — the
      // teleport guard in executeActiveMode compares against the previous
      // frame, not the current one.
      const prevRawBefore = this.prevRaw;
      if (rightValid && right) {
        this.lastValidHandMs = now;
        this.lastValidHand = right;
        // Right-slot presence anchor for the flip-rescue decision (see
        // resolveEffectiveFrame). ANY valid right-slot hand counts — flips
        // can happen while the hand is pointing or open.
        this.lastRightSlotSeenMs = now;
        if (this.inGraceLoss) {
          // Recovery: snap-anchor instead of gliding across the dropout gap.
          this.inGraceLoss = false;
          this.reanchor(right);
        }
        this.prevRaw = {
          cx: right.center.x,
          cy: right.center.y,
          depth: this.palmDepth(right),
          pinch: right.pinchDistance ?? this.smooth?.pinch ?? 0,
        };
      }

      // ── Axis-selection context (BEFORE the pause path) ────
      // Track the left hand's finger-count intent so the pause gate below
      // can tell a deliberate OPEN_PALM pause from a drifted-open selection
      // hand. fingerState is what the axis detector reads (cv-engine
      // detectAxisFromLeftHand) — never the classified gesture, which is
      // exactly what flickers.
      if (left && this.isValidHand(left, 0.3)) {
        const fs = left.fingerState;
        const count =
          (fs.index ? 1 : 0) + (fs.middle ? 1 : 0) + (fs.ring ? 1 : 0) + (fs.pinky ? 1 : 0);
        if (count >= 1 && count <= 3) {
          this.lastSelectionSeenMs = now;
        }
      }

      // ── Left open palm = pause / re-anchor ───────────
      // The pause is a DELIBERATE gesture, not a resting pose: a relaxed
      // hand near the frame edge classifies as OPEN_PALM and froze active
      // sessions invisibly (scale/Z/rotation "stopped working"). Pause
      // only engages when BOTH hands are tracked — a genuine two-hand
      // interaction — with a grace window so removing the left hand
      // briefly does not stall the transformation.
      //
      // Selection-context disambiguation (ticket 02): the left hand is ALSO
      // the axis-selection channel — Z is selected with THREE fingers, one
      // pose from OPEN_PALM. A pinky drift makes the classifier read
      // OPEN_PALM while the user is selecting/driving Z, engaging this
      // pause and killing the transformation (X: 1 finger, Y: 2 fingers
      // are far from the collision). So the pause engages only when the
      // left OPEN_PALM is NOT within the selection-context window of an
      // axis-selection count; selection counts clear the pause frames.
      const leftPalm = !!left && left.gesture === 'OPEN_PALM' && this.isValidHand(left, 0.3);
      const inSelectionContext =
        this.lastSelectionSeenMs !== null &&
        now - this.lastSelectionSeenMs <= AXIS_SELECTION_CONTEXT_MS;
      if (leftPalm && !inSelectionContext) {
        // CASE 1 — deliberate pause: no recent selection activity.
        this.pauseFrames += 1;
        if (this.pauseFrames >= PAUSE_CONFIRM_FRAMES && !this.paused) {
          this.paused = true;
          this.clearConfirm(); // pause freezes any pending mode switch too
          this.pauseGraceSince = null;
        }
        return this.publish();
      }
      if (leftPalm && inSelectionContext) {
        // CASE 2 — drifted selection hand: cancel any pause-in-progress
        // frames and any ENGAGED pause (the user re-tensed the selection
        // fingers — e.g. back to 3 — which is selection activity, not a
        // pause). NO early return: a suppressed drift is "not a pause" —
        // the frame continues through mode confirmation, the lifecycle
        // gate, and execution gating below, so Z keeps flowing at full
        // frame rate.
        this.pauseFrames = 0;
        if (this.paused) {
          this.paused = false;
          this.pauseGraceSince = null;
          if (rightValid && right) this.reanchor(right);
        }
      } else {
        // CASE 3 — no left palm this frame: original release logic.
        this.pauseFrames = 0;
        if (this.paused) {
          // Palm removed: hold a grace window (~700 ms) before resuming, in
          // case the tracker momentarily dropped the left hand.
          if (this.pauseGraceSince === null) this.pauseGraceSince = now;
          if (now - this.pauseGraceSince < PAUSE_RELEASE_GRACE_MS) {
            return this.publish(); // still frozen
          }
          // Resume: re-anchor the active transformation at the current
          // right-hand state (the pause/re-grip contract).
          this.paused = false;
          this.pauseGraceSince = null;
          if (rightValid && right) this.reanchor(right);
        }
      }

      // ── Session-lifecycle gate (the ONE aliveness decision) ─
      // A confirmed transformation persists until (a) a different gesture is
      // deliberately held for the confirmation window, (b) the intentional
      // left-palm pause path runs, or (c) the transforming hand is truly
      // GONE. While ANY usable hand is visible in the effective frame
      // (flip-aware), classification fluctuation can only FREEZE execution —
      // it can never end the mode. The former separate teardown clocks
      // (450 ms gesture-release; tracking loss without a visible hand) were
      // both shorter than realistic hand noise, which killed MOVE during
      // movement (sustained pose misreads) and during right-slot dropouts
      // (a promoted left axis pose maps to no mode and accelerated the old
      // release clock). Misreads now freeze; only true absence ends.
      if (this.mode !== 'NONE') {
        const handVisible = rightValid || this.isValidHand(left, 0.3);
        if (!handVisible) {
          if (this.lastValidHandMs !== null && now - this.lastValidHandMs > TRACKING_LOSS_GRACE_MS) {
            // Sustained absence of ANY usable hand: end cleanly (once).
            this.endActiveMode(now, 'hand gone');
          } else {
            this.inGraceLoss = true;
          }
          return this.publish();
        }
        if (!rightValid) {
          // A hand is visible but the RIGHT slot is empty (axis-selection
          // hand up, or a handedness flip in progress): the session freezes
          // and survives; execution resumes when the right slot returns.
          this.inGraceLoss = true;
        }
      }

      // ── Mode confirmation (1-second hold) ─────────────────
      // Only meaningful in MODULE context — viewport gestures are direct.
      this.processModeConfirmation(this.uiContext === 'MODULE' ? right : null, rightValid, now);

      // ── Execution gating (mode-aware) ───────────────────
      // MOVE executes ONLY while its gesture is currently readable; SCALE
      // accepts any non-competing pose (its CONTROL POSE rule — the
      // anti-re-detection contract). An unreadable pose FREEZES execution
      // for that frame; per the lifecycle gate it can never end the session.
      //
      // ROTATE is the exception (T-03): rotation is a velocity integrator,
      // so its pose label may flicker (edge-on palm) while the velocity
      // channels remain valid — execution continues for up to
      // ROTATE_EXECUTION_HOLD_MS after the last readable-ROTATE frame.
      // Bounded: a sustained misread still expires and the mode/session
      // lifetime contract (confirmation, T-01 gate) is untouched.
      if (rightValid && right && this.mode === 'ROTATE' && gestureToMode(right.gesture) === 'ROTATE') {
        this.lastRotateReadableMs = now;
      }
      const rotateHoldAlive =
        this.lastRotateReadableMs !== null &&
        now - this.lastRotateReadableMs <= ROTATE_EXECUTION_HOLD_MS;
      const gestureHeld =
        rightValid && right !== null &&
        (this.mode === 'SCALE'
          ? right.gesture !== 'GRAB' && right.gesture !== 'OPEN_PALM'
          : this.mode === 'ROTATE'
            ? rotateHoldAlive
            : gestureToMode(right.gesture) === this.mode);
      // ── Execute the ONE active mode ───────────────────────
      // In VIEWPORT context the object is untouchable: the engine's camera
      // controller owns the gestures there. Execution also stops while a
      // different-mode candidate is being confirmed.
      const confirmingOther = this.confirmPendingForOtherMode();
      const executionAllowed =
        this.uiContext === 'MODULE' && !confirmingOther;
      if (
        this.mode !== 'NONE' &&
        rightValid &&
        right &&
        !this.inGraceLoss &&
        gestureHeld &&
        executionAllowed
      ) {
        this.executeActiveMode(right, prevRawBefore, now);
      }

      return this.publish();
    } catch (error) {
      // Last-resort guard: a malformed frame must never take the app down.
      console.error('[InteractionCtrl] Frame error (state reset):', error);
      this.hardReset();
      return this.publish();
    }
  }

  // ── Mode confirmation ───────────────────────────────────

  private processModeConfirmation(
    right: HandState | null,
    rightValid: boolean,
    now: TimestampMs,
  ): void {
    const gesture = rightValid && right ? right.gesture : null;
    const wanted = gesture ? gestureToMode(gesture) : null;

    // The candidate must be continuously present: releasing the gesture
    // (transient NONE/POINT/GRAB-flicker) cancels the pending switch.
    if (!wanted) {
      this.clearConfirm();
      return;
    }

    // Already the active mode — nothing to confirm (no ring, no re-anchor).
    if (wanted === this.mode) {
      this.clearConfirm();
      return;
    }

    // New or changed candidate — (re)start the hold window.
    if (wanted !== this.confirmMode || gesture !== this.confirmGesture) {
      this.confirmGesture = gesture;
      this.confirmMode = wanted;
      this.confirmStart = now;
      return;
    }

    // Same candidate held — check the 1-second window.
    if (this.confirmStart !== null && now - this.confirmStart >= MODE_CONFIRM_MS) {
      if (this.confirmMode !== this.mode) {
        // ── MODE CHANGE ── (capture target first: endActiveMode clears the
        // confirm state as part of its cleanup)
        const target = this.confirmMode;
        this.clearConfirm(); // publish a clean state for this transition
        if (this.mode !== 'NONE') {
          this.endActiveMode(now, 'mode switch');
        }
        this.mode = target;
        if (right) this.reanchor(right);
        this.emit(now, { ...IDENTITY_DELTA, mode: target }, 'BEGIN');
        console.log(`[InteractionCtrl] ACTIVE_MODE = ${this.mode}`);
      } else {
        // Re-confirmed the already-active mode — clear the ring.
        this.clearConfirm();
      }
    }
  }

  private clearConfirm(): void {
    this.confirmGesture = null;
    this.confirmMode = null;
    this.confirmStart = null;
  }

  /** A mode-switch confirmation is pending for a mode OTHER than the active one. */
  private confirmPendingForOtherMode(): boolean {
    return this.confirmMode !== null && this.confirmMode !== this.mode;
  }

  // ── Active-mode execution ───────────────────────────────

  private executeActiveMode(
    right: HandState,
    prevRaw: { cx: number; cy: number; depth: number; pinch: number } | null,
    now: TimestampMs,
  ): void {
    // Teleport guard: raw-position discontinuity vs the PREVIOUS frame =
    // tracker glitch. Re-anchor instead of gliding the object across the scene.
    const raw = {
      cx: right.center.x,
      cy: right.center.y,
      depth: this.palmDepth(right),
      pinch: right.pinchDistance ?? this.smooth?.pinch ?? 0,
    };
    if (prevRaw && !this.inGraceLoss) {
      const p = prevRaw;
      const jumped =
        Math.abs(raw.cx - p.cx) > TELEPORT_SNAP ||
        Math.abs(raw.cy - p.cy) > TELEPORT_SNAP ||
        Math.abs(raw.depth - p.depth) > TELEPORT_SNAP_SCALAR ||
        Math.abs(raw.pinch - p.pinch) > TELEPORT_SNAP_SCALAR;
      if (jumped) {
        this.reanchor(right);
        return;
      }
    }

    // Only the active mode's math runs — the others are dormant.
    // handMoved: whether the RAW hand center changed since the previous raw
    // sample (exact inequality — a bit-identical hand is a genuine stop).
    // T-04 uses this so the velocity bridge never carries a frozen hand.
    const handMoved =
      prevRaw === null ||
      raw.cx !== prevRaw.cx ||
      raw.cy !== prevRaw.cy;
    switch (this.mode) {
      case 'MOVE':
        this.executeMove(now);
        break;
      case 'ROTATE':
        this.executeRotate(now, handMoved);
        break;
      case 'SCALE':
        this.executeScale(now);
        break;
    }
  }

  /** MOVE: anchored correction on one axis (X/Y from palm center, Z from depth). */
  private executeMove(now: TimestampMs): void {
    if (!this.anchor || !this.smooth) return;
    let target: number;
    let deadzone: number;

    if (this.controlAxis === 'Z') {
      // Palm span shrinks as the hand moves away → object moves +Z (deeper).
      target = (this.anchor.depth - this.smooth.depth) * MOVE_Z_UNITS_PER_DEPTH;
      deadzone = DEADZONE_MOVE_Z;
    } else if (this.controlAxis === 'X') {
      // Camera image x is mirrored relative to the user → negate.
      target = -(this.smooth.cx - this.anchor.cx) * MOVE_UNITS_PER_SCREEN;
      deadzone = DEADZONE_MOVE;
    } else {
      // Image y grows downward → negate for natural up = +Y.
      target = -(this.smooth.cy - this.anchor.cy) * MOVE_UNITS_PER_SCREEN;
      deadzone = DEADZONE_MOVE;
    }

    // Z gets its own, gentler step cap: the depth (palm-span) channel is the
    // noisiest input, and the shared X/Y cap (0.15) let span spikes lunge the
    // object along Z — perceived as wobble. The deadzone+hysteresis gate
    // already absorbs most span noise; this caps what little survives.
    const stepCap = this.controlAxis === 'Z' ? MAX_STEP_MOVE_Z : MAX_STEP_MOVE;
    this.emitAxisDelta(
      'position', this.controlAxis,
      target - this.applied, deadzone, stepCap, now,
    );
  }

  /** ROTATE: anchored correction on one axis from slow-smoothed channels. */
  private executeRotate(now: TimestampMs, handMoved: boolean): void {
    if (!this.smooth) return;

    // ── Velocity-based (joystick) rotation ──
    // Hand velocity drives rotation SPEED, not an absolute position target.
    // Stop the hand → velocity decays → rotation stops. No target chasing
    // means no deadzone-edge oscillation and no re-anchor need: the wobble
    // sources of the anchored model are gone by construction.
    // Axis signals (unchanged from the anchored model): X pitch = vertical
    // hand motion; Y yaw and Z roll = horizontal hand motion.
    // T-06: X drives from the FAST vertical channel (velCy) — the same
    // velocity-processing model as Y/Z (EMA_VEL, gate, T-03/T-04, cap),
    // mirrored input axis. The former slow dual-rate X channel
    // (EMA_VEL_XROT + VEL_SWEEP_MOMENTUM snap) is retired: it added
    // +2–6 frames of latency at every magnitude, starved reversals (83% vs
    // 98% duty) and left the small-motion regime dead (converged 0.00054 <
    // gate 0.0012), while bob's residual (≈0.0006) already sits at HALF the
    // shared gate and the T-04 carry never re-injects sub-gate values —
    // the same idle-safety stack Y/Z have always used (pinned by L19).
    const speed = this.controlAxis === 'X' ? this.velCy : this.velCx;
    const v = this.controlAxis === 'X' ? -speed : speed; // Y grows downward

    // ── T-04 hold-and-decay (sub-gate sputter bridge) ──
    // Above the gate: record the frame and mirror the drive value into the
    // carry. Below the gate: emit the DECAYED carry while the bridge window
    // is open — the raw sub-gate channel value is never re-injected (it is
    // exactly the bob the gate exists to suppress). Above-gate frames
    // reset the decay, so the carry always equals the last real drive value
    // at the moment the dip began; reanchor() (axis change, pause release,
    // mode switch) clears it, so a bridge never crosses a re-baseline.
    // A hand whose raw center is bit-identical to the previous frame is a
    // GENUINE STOP: the bridge never engages for it, so natural stopping is
    // exactly the pre-T-04 behavior (L14/L15b) — only a hand that is still
    // visibly moving gets bridged.
    if (Math.abs(v) >= DEADZONE_ROT_VEL) {
      this.lastAboveGateMs = now;
      this.aboveGateCarry = v;
      this.bridgeFrames = 0;
    } else if (
      !handMoved ||
      this.lastAboveGateMs === null ||
      now - this.lastAboveGateMs > ROTATE_VEL_HOLD_MS ||
      this.bridgeFrames >= ROTATE_VEL_CARRY_MAX_FRAMES ||
      Math.abs(this.aboveGateCarry) < DEADZONE_ROT_VEL
    ) {
      this.lastAboveGateMs = null;
      this.aboveGateCarry = 0;
      this.bridgeFrames = 0;
      return;                                            // still hand → no rotation
    } else {
      this.aboveGateCarry *= ROTATE_VEL_CARRY_DECAY;
      this.bridgeFrames++;
    }
    const delta = (Math.abs(v) >= DEADZONE_ROT_VEL ? v : this.aboveGateCarry) * ROT_VEL_GAIN;
    this.emitAxisDelta(
      'rotation', this.controlAxis,
      delta, 0, MAX_STEP_ROTATE, now,
    );
  }

  /**
   * SCALE: baseline-vertical-delta scaling (REDESIGNED).
   *
   * The hand pose is STATIC (SCALE_POSE — thumb+index touching, three
   * fingers open). The scale amount comes ONLY from the right hand's
   * vertical movement relative to the baseline captured when the mode was
   * confirmed (reanchor() — and re-captured at every left-palm pause
   * release). Image y grows DOWNWARD, so hand-UP (cy < anchor) = grow.
   *
   * The anchored-correction model (target − applied) guarantees: no jump on
   * activation (target starts at the baseline), self-correction instead of
   * noise integration (a stationary hand converges to the deadzone), and
   * monotonic proportional response to deliberate travel. Multiplication by
   * the per-axis factor is capped per frame (MAX_STEP_SCALE) and refused
   * below collapse in the transform service.
   */
  private executeScale(now: TimestampMs): void {
    if (!this.anchor || !this.smooth) return;
    // Vertical delta vs the baseline; negate for natural up = grow.
    const deltaUp = -(this.smooth.scaleY - this.anchor.scaleY);
    const target = deltaUp * SCALE_UNITS_PER_SCREEN;
    this.emitScaleDelta(target - this.applied, DEADZONE_SCALE, now);
  }

  // ── Delta emission with deadzone + hysteresis + cap ─────

  private emitAxisDelta(
    kind: 'position' | 'rotation',
    axis: 'X' | 'Y' | 'Z',
    delta: number,
    deadzone: number,
    cap: number,
    now: TimestampMs,
  ): void {
    const out = this.gateDelta(delta, deadzone, cap);
    if (out === null) return;

    const d: CVTransformDelta = {
      mode: this.mode as 'MOVE' | 'ROTATE' | 'SCALE',
      position: kind === 'position' ? axisVec(axis, out) : { x: 0, y: 0, z: 0 },
      rotation: kind === 'rotation' ? axisVec(axis, out) : { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    };
    this.applied += out;
    this.emit(now, d, 'UPDATE');
  }

  private emitScaleDelta(delta: number, deadzone: number, now: TimestampMs): void {
    const out = this.gateDelta(delta, deadzone, MAX_STEP_SCALE);
    if (out === null) return;

    const factor = 1 + out;
    // Per-axis application: only the selected control axis receives the
    // factor; the others pass through unchanged (1.0). Axis 'A' scales all
    // three for whole-object resizing.
    const d: CVTransformDelta = {
      mode: 'SCALE',
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale:
        this.controlAxis === 'X' ? { x: factor, y: 1, z: 1 } :
        this.controlAxis === 'Y' ? { x: 1, y: factor, z: 1 } :
        this.controlAxis === 'Z' ? { x: 1, y: 1, z: factor } :
        { x: factor, y: factor, z: factor },
    };
    this.applied += out;
    this.emit(now, d, 'UPDATE');
  }

  /**
   * Schmitt-trigger emission gate: below the deadzone nothing is emitted;
   * once above it, emission continues until the correction decays below
   * deadzone / hysteresis. Prevents boundary chatter. Returns the capped
   * delta or null (suppressed).
   */
  private gateDelta(delta: number, deadzone: number, cap: number): number | null {
    if (!isFiniteNumber(delta)) return null;
    const abs = Math.abs(delta);
    const enter = deadzone;
    const exit = deadzone / DEADZONE_HYSTERESIS;
    const shouldEmit = this.inDeadzoneBand ? abs > enter : abs > exit;
    this.inDeadzoneBand = !shouldEmit;
    if (!shouldEmit || abs < 1e-4) return null;
    return clamp(delta, -cap, cap);
  }

  private emit(now: TimestampMs, delta: CVTransformDelta, phase: 'BEGIN' | 'UPDATE' | 'END'): void {
    if (!this.onFrameDelta) return;
    try {
      this.onFrameDelta({ delta, phase, timestamp: now, sessionId: this.sessionId });
    } catch (error) {
      console.error('[InteractionCtrl] Delta consumer error:', error);
    }
  }

  /**
   * End the active transformation cleanly: emit END (mode-tagged BEFORE the
   * reset so consumers see which session is ending), then return to NONE.
   * Every exit path funnels through here.
   */
  private endActiveMode(now: TimestampMs, reason: string): void {
    this.emit(now, { ...IDENTITY_DELTA, mode: this.mode as 'MOVE' | 'ROTATE' | 'SCALE' }, 'END');
    this.mode = 'NONE';
    this.clearConfirm();
    this.anchor = null;
    this.inGraceLoss = false;
    console.log(`[InteractionCtrl] Session ended (${reason})`);
  }

  // ── Anchoring ───────────────────────────────────────────

  /**
   * Re-anchor at the given hand state: snap all channels, zero the applied
   * correction. The object stays exactly where it is — the next delta is
   * measured from the new baseline.
   */
  private reanchor(right: HandState): void {
    const next: SmoothedHand = {
      cx: right.center.x,
      cy: right.center.y,
      rotCx: right.center.x,
      rotCy: right.center.y,
      depth: this.palmDepth(right),
      pinch: right.pinchDistance ?? this.smooth?.pinch ?? 0,
      scaleY: right.center.y,
    };
    this.smooth = { ...next };
    this.anchor = { ...next };
    this.applied = 0;
    this.inDeadzoneBand = true;
    // T-04: a re-baseline (axis change, pause release, mode switch) must not
    // carry a stale velocity bridge across it.
    this.lastAboveGateMs = null;
    this.aboveGateCarry = 0;
    this.bridgeFrames = 0;
  }

  // ── Smoothing ───────────────────────────────────────────

  private updateSmoothing(frame: HandFrame): void {
    const right = frame.rightHand;
    if (!right || !this.isValidHand(right, 0)) {
      // No usable hand: freeze smoothing (grace logic handles the mode).
      return;
    }
    const raw: SmoothedHand = {
      cx: right.center.x,
      cy: right.center.y,
      rotCx: right.center.x,
      rotCy: right.center.y,
      depth: this.palmDepth(right),
      pinch: right.pinchDistance ?? this.smooth?.pinch ?? 0,
      scaleY: right.center.y,
    };

    if (!this.smooth || this.mode === 'NONE' || this.inGraceLoss) {
      // Fresh lifecycle or dropout recovery: snap, don't blend across gaps.
      this.smooth = { ...raw };
      return;
    }

    // ── Stillness gate (deadband on the SLOW channels) ──────
    // Landmark tremor is already handled by the EMAs, but slow whole-hand
    // DRIFT (posture relaxation, breathing, sub-1 Hz wander) passes every
    // filter and rectifies through the anchored correction into visible
    // wobble — most visibly on Z (span noise). When the hand is essentially
    // still, the slow POSITION channels FREEZE instead of tracking drift.
    //
    // ROTATE is EXEMPT: it is velocity-based and velocity is integrated
    // BEFORE this gate, so an idle hand's velocity converges under
    // DEADZONE_ROT_VEL and no rotation is emitted anyway — while a slow
    // CONTINUOUS rotation (per-frame motion below this band, typical when
    // the palm compresses near edge-on) was being classified "still" here,
    // freezing its channels and producing the STUCK→INVERSE→RECOVER
    // pattern at the Schmitt boundary. MOVE/SCALE are anchor-based and
    // keep the freeze (their wobble protection depends on it).
    //
    // MOVE on the Z axis gets the SAME exemption for its INPUT channel: the
    // depth (palm-span) signal IS the Z control. Deliberate depth motion
    // changes span by only ~0.003–0.01 per frame — below STILLNESS_EPS_SCALAR
    // — so freezing the depth channel swallowed every normal Z push (the
    // hand looked "still" to the gate while the user was deliberately moving
    // in depth; X/Y kept working because their per-frame center deltas are
    // far larger). Z-move's idle safety is its own gate stack below:
    // DEADZONE_MOVE_Z (6× the stillness band) + Schmitt hysteresis + the
    // MAX_STEP_MOVE_Z cap — the same design as ROTATE's velocity deadzone.
    const rotateActive = this.mode === 'ROTATE';
    const zMoveActive = this.mode === 'MOVE' && this.controlAxis === 'Z';
    const scaleActive = this.mode === 'SCALE';
    const moved =
      Math.abs(raw.cx - this.smooth.cx) > STILLNESS_EPS ||
      Math.abs(raw.cy - this.smooth.cy) > STILLNESS_EPS ||
      Math.abs(raw.depth - this.smooth.depth) > STILLNESS_EPS_SCALAR;
    // Schmitt re-arm: once frozen, stay frozen until movement clearly
    // exceeds the still band — otherwise the residual left at freeze-time
    // gives noise slack to re-open the channel and rectify into drift.
    const movedFar =
      Math.abs(raw.cx - this.smooth.cx) > STILLNESS_EPS * 2.5 ||
      Math.abs(raw.cy - this.smooth.cy) > STILLNESS_EPS * 2.5 ||
      Math.abs(raw.depth - this.smooth.depth) > STILLNESS_EPS_SCALAR * 2.5;
    // Velocity integration is shared by all branches: it is the ROTATE input
    // and must respond proportionally to SLOW deliberate motion (below the
    // stillness band), so it can never be zeroed/decayed-only. Idle safety
    // comes from the velocity EMA (zero-mean tremor averages below the
    // rotation deadzone) plus DEADZONE_ROT_VEL itself.
    this.velCx = this.velCx + EMA_VEL * (raw.cx - this.smooth.cx - this.velCx);
    this.velCy = this.velCy + EMA_VEL * (raw.cy - this.smooth.cy - this.velCy);
    // T-06: the X-only dual-rate block that used to sit here (slow-attack
    // EMA + VEL_SWEEP_MOMENTUM snap on velCySlow) is retired — X now shares
    // the single fast EMA above with Y/Z (see executeRotate).
    // ROTATE bypasses the freeze entirely (see the comment above): the gate
    // exists to protect anchor-based channels from drift, and rotation has
    // no anchor — its idle safety is the velocity deadzone.
    if (rotateActive) {
      this.stillFrozen = false;
    } else if (this.stillFrozen) {
      if (movedFar) {
        this.stillFrozen = false;
      } else {
        this.smooth.cx = this.smooth.cx + EMA_CENTER * (raw.cx - this.smooth.cx);
        this.smooth.cy = this.smooth.cy + EMA_CENTER * (raw.cy - this.smooth.cy);
        this.smooth.pinch = this.smooth.pinch + EMA_SCALAR * (raw.pinch - this.smooth.pinch);
        // Z-move exemption: the depth channel is the control input — keep
        // tracking it even while the position/rotation channels are frozen.
        if (zMoveActive) {
          this.smooth.depth = this.smooth.depth + EMA_DEPTH_SLOW * (raw.depth - this.smooth.depth);
        }
        // SCALE exemption: the vertical channel IS the scale input — keep
        // tracking it while frozen (same reasoning as the Z-move exemption).
        if (scaleActive) {
          this.smooth.scaleY = this.smooth.scaleY + EMA_DEPTH_SLOW * (raw.scaleY - this.smooth.scaleY);
        }
        return;
      }
    } else if (!moved) {
      // Keep fast channels live (snappy X/Y + the pinch control — scaling
      // happens with a STATIONARY hand, so pinch must never freeze), and
      // freeze only the slow drift-prone channels (depth, rotation anchors).
      this.stillFrozen = true;
      this.smooth.cx = this.smooth.cx + EMA_CENTER * (raw.cx - this.smooth.cx);
      this.smooth.cy = this.smooth.cy + EMA_CENTER * (raw.cy - this.smooth.cy);
      this.smooth.pinch = this.smooth.pinch + EMA_SCALAR * (raw.pinch - this.smooth.pinch);
      // Z-move exemption: see the comment above the freeze branches.
      if (zMoveActive) {
        this.smooth.depth = this.smooth.depth + EMA_DEPTH_SLOW * (raw.depth - this.smooth.depth);
      }
      // SCALE exemption: vertical channel is the control input.
      if (scaleActive) {
        this.smooth.scaleY = this.smooth.scaleY + EMA_DEPTH_SLOW * (raw.scaleY - this.smooth.scaleY);
      }
      return;
    }

    this.smooth = {
      cx: this.smooth.cx + EMA_CENTER * (raw.cx - this.smooth.cx),
      cy: this.smooth.cy + EMA_CENTER * (raw.cy - this.smooth.cy),
      rotCx: this.smooth.rotCx + EMA_ROT_SLOW * (raw.cx - this.smooth.rotCx),
      rotCy: this.smooth.rotCy + EMA_ROT_SLOW * (raw.cy - this.smooth.rotCy),
      depth: this.smooth.depth + EMA_DEPTH_SLOW * (raw.depth - this.smooth.depth),
      pinch: this.smooth.pinch + EMA_SCALAR * (raw.pinch - this.smooth.pinch),
      scaleY: this.smooth.scaleY + EMA_DEPTH_SLOW * (raw.scaleY - this.smooth.scaleY),
    };
  }

  /** Palm apparent size — the depth proxy (wrist→middle-MCP 2D span). */
  private palmDepth(hand: HandState): number {
    const lm = hand.landmarks;
    const w = lm?.[0];
    const mcp = lm?.[9];
    if (!w || !mcp || !isFiniteNumber(w.x) || !isFiniteNumber(w.y) || !isFiniteNumber(mcp.x) || !isFiniteNumber(mcp.y)) {
      return -(hand.wrist.z ?? 0);
    }
    return Math.hypot(mcp.x - w.x, mcp.y - w.y);
  }

  private isValidHand(hand: HandState | null | undefined, minConfidence: number): boolean {
    if (!hand || hand.active !== true) return false;
    if (!isFiniteNumber(hand.confidence) || hand.confidence < minConfidence) return false;
    if (!isFiniteVec3(hand.center) || !isFiniteVec3(hand.wrist)) return false;
    return true;
  }

  // ── Publication ─────────────────────────────────────────

  private publish(): CVInteractionState {
    let confirm: CVInteractionState['confirm'] = null;
    if (this.confirmMode !== null && this.confirmStart !== null && this.confirmGesture !== null) {
      const progress = clamp(
        (this.lastFrameNow - this.confirmStart) / MODE_CONFIRM_MS, 0, 1,
      );
      confirm = { gesture: this.confirmGesture, mode: this.confirmMode, progress };
    }
    this.lastInteraction = { mode: this.mode, context: this.uiContext, paused: this.paused, confirm };
    return this.lastInteraction;
  }

  getInteractionState(): CVInteractionState {
    return this.lastInteraction;
  }

  private hardReset(): void {
    if (this.mode !== 'NONE') {
      this.emit(this.lastFrameNow, { ...IDENTITY_DELTA, mode: this.mode as 'MOVE' | 'ROTATE' | 'SCALE' }, 'END');
    }
    this.mode = 'NONE';
    this.paused = false;
    this.clearConfirm();
    this.smooth = null;
    this.anchor = null;
    this.applied = 0;
    this.inDeadzoneBand = true;
    this.inGraceLoss = false;
    this.lastValidHandMs = null;
    this.prevRaw = null;
    this.pauseFrames = 0;
    this.pauseGraceSince = null;
    this.lastSelectionSeenMs = null;
    this.lastRotateReadableMs = null;
    // T-04: velocity-sputter bridge state dies with the session.
    this.lastAboveGateMs = null;
    this.aboveGateCarry = 0;
    this.bridgeFrames = 0;
    this.stillFrozen = false;
    this.velCx = 0;
    this.velCy = 0;
    this.lastValidHand = null;
    this.lastRightSlotSeenMs = null;
    this.leftSlotSeenMs = null;
  }

  /** Full teardown (CV workspace closed). */
  reset(): void {
    this.hardReset();
  }
}

function axisVec(axis: 'X' | 'Y' | 'Z', v: number) {
  return { x: axis === 'X' ? v : 0, y: axis === 'Y' ? v : 0, z: axis === 'Z' ? v : 0 };
}
