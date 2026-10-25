/**
 * CV Interaction Stability Tests (V2.0 architecture)
 *
 * These tests encode the behavioral contract of the rebuilt transformation
 * system: ONE active mode, 1-second mode confirmation, gesture-gated
 * execution, pause/re-anchor, and graceful recovery. Each test targets a
 * failure mode of the previous layered implementation:
 *
 *  - mode changing on a single noisy frame (must require ~1 s hold)
 *  - transformation running without its gesture (gesture gating)
 *  - jitter integration / holding-still drift (anchored correction model)
 *  - velocity saturation (per-frame caps)
 *  - tracking dropout corrupting state (grace + clean END)
 *  - NaN / malformed frames crashing the app (defensive processing)
 *  - handedness flip killing the session (left-slot promotion)
 *  - pause/re-anchor producing jumps
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InteractionController, gestureToMode, MODE_CONFIRM_MS, type DeltaPayload } from '../../src/engine-cv/interaction/interaction-controller';
import { HandFrameProducer } from '../../src/engine-cv/tracking/hand-frame-producer';
import { TransformService } from '../../src/engine-3d/transform-service';
import { SceneManager } from '../../src/engine-3d/scene-manager';
import { EventBus } from '../../src/core/event-bus';
import * as THREE from 'three';
import type { HandFrame, HandState, TimestampMs, CVTransformDelta } from '../../src/core/contracts';

// ─── Helpers ──────────────────────────────────────────────

const FRAME_MS = 33; // ~30 fps

function makeLandmarks(cx = 0.5, cy = 0.5, span = 0.15): HandState['landmarks'] {
  // Minimal plausible 21-landmark layout: wrist(0) and middle-MCP(9) define
  // the palm span (the controller's depth proxy).
  const lm: HandState['landmarks'] = [];
  for (let i = 0; i < 21; i++) {
    lm.push({ x: cx, y: cy + span, z: 0 });
  }
  lm[0] = { x: cx, y: cy + span, z: 0 };
  lm[9] = { x: cx, y: cy, z: 0 };
  return lm;
}

function makeHand(overrides: Partial<HandState> = {}): HandState {
  return {
    active: true,
    handedness: 'right',
    landmarks: makeLandmarks(),
    center: { x: 0.5, y: 0.5, z: 0 },
    wrist: { x: 0.5, y: 0.65, z: 0 },
    indexTip: { x: 0.5, y: 0.4, z: 0 },
    pinchDistance: 0.1,
    fingerState: { index: false, middle: false, ring: false, pinky: false, thumb: false },
    gesture: 'GRAB',
    confidence: 0.9,
    ...overrides,
  };
}

function makeFrame(overrides: Partial<HandFrame> = {}): HandFrame {
  return {
    timestamp: 1000 as TimestampMs,
    leftHand: null,
    rightHand: null,
    trackingConfidence: 0.9,
    pointer: null,
    ...overrides,
  };
}

/** Frames needed to satisfy the ~1 s confirmation at 33 ms/frame. */
const CONFIRM_FRAMES = Math.ceil(MODE_CONFIRM_MS / FRAME_MS) + 1;

/** Hold a right-hand pose until the confirm window is satisfied. */
function confirmGesture(
  controller: InteractionController,
  hand: HandState,
  startMs = 1000,
): number {
  let t = startMs;
  for (let i = 0; i < CONFIRM_FRAMES; i++) {
    controller.processFrame(makeFrame({ timestamp: t as TimestampMs, rightHand: hand }), t as TimestampMs);
    t += FRAME_MS;
  }
  return t;
}

/** Feed a right hand once and return the resulting state. */
function step(
  controller: InteractionController,
  hand: HandState | null,
  t: number,
  left: HandState | null = null,
) {
  return controller.processFrame(
    makeFrame({ timestamp: t as TimestampMs, rightHand: hand, leftHand: left }),
    t as TimestampMs,
  );
}

// ─── Interaction Controller: mode activation ──────────────

describe('InteractionController: single ACTIVE_MODE + 1-second confirmation', () => {
  let controller: InteractionController;
  let deltas: DeltaPayload[];

  beforeEach(() => {
    controller = new InteractionController();
    deltas = [];
    controller.onDelta((p) => deltas.push(p));
  });

  const updates = () => deltas.filter((d) => d.phase === 'UPDATE');
  const begins = () => deltas.filter((d) => d.phase === 'BEGIN');
  const ends = () => deltas.filter((d) => d.phase === 'END');

  it('maps gestures to modes via the ONE mapping', () => {
    expect(gestureToMode('GRAB')).toBe('MOVE');
    expect(gestureToMode('OPEN_PALM')).toBe('ROTATE');
    expect(gestureToMode('SCALE_POSE')).toBe('SCALE');
    expect(gestureToMode('POINT')).toBeNull();
    expect(gestureToMode('PINCH')).toBeNull();
    expect(gestureToMode('NONE')).toBeNull();
  });

  it('does NOT activate a mode on a brief gesture (requires ~1 s hold)', () => {
    let t = 1000;
    // A few frames of GRAB — far short of the confirmation window.
    for (let i = 0; i < 5; i++) {
      step(controller, makeHand({ gesture: 'GRAB' }), t);
      t += FRAME_MS;
    }
    expect(controller.getInteractionState().mode).toBe('NONE');
    expect(begins().length).toBe(0);
    expect(controller.getInteractionState().confirm?.mode).toBe('MOVE');
    expect(controller.getInteractionState().confirm!.progress).toBeLessThan(0.3);
  });

  it('publishes monotonic confirm progress for the visual ring, cleared on release', () => {
    let t = 1000;
    const progressions: number[] = [];
    // Hold GRAB *just short* of the window and sample the ring progress.
    const holdFrames = CONFIRM_FRAMES - 4; // ~92% of the window
    for (let i = 0; i < holdFrames; i++) {
      const s = step(controller, makeHand({ gesture: 'GRAB' }), t);
      if (s.confirm) progressions.push(s.confirm.progress);
      t += FRAME_MS;
    }
    // The ring gets real per-frame progress, not just a final flash.
    expect(progressions.length).toBeGreaterThanOrEqual(holdFrames - 1);
    for (let i = 1; i < progressions.length; i++) {
      expect(progressions[i]).toBeGreaterThanOrEqual(progressions[i - 1]);
    }
    expect(progressions[progressions.length - 1]).toBeGreaterThan(0.5);
    // Releasing the gesture clears the pending ring and never activates.
    const s = step(controller, makeHand({ gesture: 'NONE' }), t);
    expect(s.confirm).toBeNull();
    expect(s.mode).toBe('NONE');
  });

  it('activates MOVE after the 1-second GRAB hold', () => {
    const t = confirmGesture(controller, makeHand({ gesture: 'GRAB' }));
    expect(controller.getInteractionState().mode).toBe('MOVE');
    expect(begins().length).toBe(1);
    expect(controller.getInteractionState().confirm).toBeNull();
    void t;
  });

  it('activates ROTATE after the 1-second OPEN_PALM hold', () => {
    confirmGesture(controller, makeHand({ gesture: 'OPEN_PALM' }));
    expect(controller.getInteractionState().mode).toBe('ROTATE');
  });

  it('activates SCALE after the 1-second SCALE_POSE hold', () => {
    confirmGesture(controller, makeHand({ gesture: 'SCALE_POSE', pinchDistance: 0.04 }));
    expect(controller.getInteractionState().mode).toBe('SCALE');
  });

  it('active mode gesture NEVER re-triggers its own confirmation (SCALE re-detection bug)', () => {
    const t = confirmGesture(controller, makeHand({ gesture: 'SCALE_POSE', pinchDistance: 0.04 }));
    expect(controller.getInteractionState().mode).toBe('SCALE');
    // While SCALE is active, the pose is the CONTROL pose: it must never
    // restart the 1-second Scale confirmation while scaling (the vertical
    // position wanders freely — that IS the scale input).
    let s = step(controller, makeHand({ gesture: 'SCALE_POSE', pinchDistance: 0.04, center: { x: 0.5, y: 0.3, z: 0 } }), t + FRAME_MS);
    expect(s.confirm).toBeNull();
    s = step(controller, makeHand({ gesture: 'SCALE_POSE', pinchDistance: 0.04, center: { x: 0.5, y: 0.7, z: 0 } }), t + 2 * FRAME_MS);
    expect(s.confirm).toBeNull();
    expect(s.mode).toBe('SCALE');
    // Competing gestures ARE candidates for switching.
    s = step(controller, makeHand({ gesture: 'GRAB' }), t + 3 * FRAME_MS);
    expect(s.confirm?.mode).toBe('MOVE');
  });

  it('cancels the confirmation when the gesture is released mid-hold', () => {
    let t = 1000;
    for (let i = 0; i < 15; i++) {
      step(controller, makeHand({ gesture: 'GRAB' }), t);
      t += FRAME_MS;
    }
    // Gesture released halfway through the confirm window.
    for (let i = 0; i < 3; i++) {
      step(controller, makeHand({ gesture: 'POINT' }), t);
      t += FRAME_MS;
    }
    expect(controller.getInteractionState().mode).toBe('NONE');
    expect(controller.getInteractionState().confirm).toBeNull();
    expect(begins().length).toBe(0);
  });

  it('switches MOVE → SCALE only after a full 1-second SCALE_POSE hold (no reset needed)', () => {
    let t = confirmGesture(controller, makeHand({ gesture: 'GRAB' }));
    expect(controller.getInteractionState().mode).toBe('MOVE');

    // A couple of SCALE_POSE frames must not switch instantly…
    step(controller, makeHand({ gesture: 'SCALE_POSE', pinchDistance: 0.04 }), t);
    t += FRAME_MS;
    step(controller, makeHand({ gesture: 'SCALE_POSE', pinchDistance: 0.04 }), t);
    t += FRAME_MS;
    expect(controller.getInteractionState().mode).toBe('MOVE');

    // …but holding it for the window does.
    t = confirmGesture(controller, makeHand({ gesture: 'SCALE_POSE', pinchDistance: 0.04 }), t);
    expect(controller.getInteractionState().mode).toBe('SCALE');
    // Old mode ended, new began.
    expect(ends().length).toBe(1);
    expect(begins().length).toBe(2);
  });

  it('exactly one mode is active at any time (state invariant)', () => {
    let t = 1000;
    const gestures: HandState['gesture'][] = ['GRAB', 'OPEN_PALM', 'SCALE_POSE', 'GRAB'];
    for (const g of gestures) {
      t = confirmGesture(controller, makeHand({ gesture: g, pinchDistance: 0.05 }), t);
      t += FRAME_MS * 5;
      const mode = controller.getInteractionState().mode;
      expect(['NONE', 'MOVE', 'ROTATE', 'SCALE']).toContain(mode);
    }
    expect(controller.getInteractionState().mode).toBe('MOVE');
  });
});

// ─── Gesture gating ───────────────────────────────────────

describe('InteractionController: gesture-gated execution', () => {
  let controller: InteractionController;
  let deltas: DeltaPayload[];

  beforeEach(() => {
    controller = new InteractionController();
    deltas = [];
    controller.onDelta((p) => deltas.push(p));
  });

  const updates = () => deltas.filter((d) => d.phase === 'UPDATE');
  const ends = () => deltas.filter((d) => d.phase === 'END');

  it('freezes execution while the pose is unreadable and ends only when the HAND leaves the frame', () => {
    let t = confirmGesture(controller, makeHand({ gesture: 'GRAB' }));

    // Pose misread: POINT frames well beyond any flicker window. The hand is
    // VISIBLE, so the session-lifecycle gate freezes execution but never ends
    // the mode (persistence contract: a confirmed mode ends on a deliberate
    // confirmed switch, an intentional pause, or true hand loss — not on a
    // classification fluctuation).
    const before = updates().length;
    for (let i = 0; i < 20; i++) {
      step(controller, makeHand({ gesture: 'POINT', indexTip: { x: 0.5, y: 0.4, z: 0 } }), t);
      t += FRAME_MS;
    }
    expect(controller.getInteractionState().mode).toBe('MOVE');
    expect(updates().length).toBe(before); // frozen — no phantom transforms
    expect(ends().length).toBe(0);

    // The hand leaves the frame entirely: after the loss window the session
    // ends cleanly, exactly once.
    for (let i = 0; i < 20; i++) {
      step(controller, null, t);
      t += FRAME_MS;
    }
    expect(controller.getInteractionState().mode).toBe('NONE');
    expect(ends().length).toBe(1);
  });

  it('tolerates a brief gesture flicker (a misread does not drop the session)', () => {
    let t = confirmGesture(controller, makeHand({ gesture: 'GRAB' }));

    // 1-2 POINT frames (within GESTURE_RELEASE_TOLERANCE)…
    step(controller, makeHand({ gesture: 'POINT' }), t);
    t += FRAME_MS;
    step(controller, makeHand({ gesture: 'POINT' }), t);
    t += FRAME_MS;
    // …then back to GRAB: the session must still be alive.
    const st = step(controller, makeHand({ gesture: 'GRAB', center: { x: 0.6, y: 0.5, z: 0 } }), t);
    expect(st.mode).toBe('MOVE');
    expect(ends().length).toBe(0);
  });

  it('emits nothing while the gesture is absent (no phantom transforms)', () => {
    let t = confirmGesture(controller, makeHand({ gesture: 'GRAB' }));
    const before = updates().length;

    for (let i = 0; i < 3; i++) {
      step(controller, makeHand({ gesture: 'POINT' }), t);
      t += FRAME_MS;
    }
    expect(updates().length).toBe(before);
  });
});

// ─── MOVE mode ────────────────────────────────────────────

describe('InteractionController: MOVE (stable, anchored, capped)', () => {
  let controller: InteractionController;
  let deltas: DeltaPayload[];

  beforeEach(() => {
    controller = new InteractionController();
    deltas = [];
    controller.onDelta((p) => deltas.push(p));
  });

  const updates = () => deltas.filter((d) => d.phase === 'UPDATE');

  const moveUpdates = () =>
    updates().filter((d) => d.delta.position.x !== 0 || d.delta.position.y !== 0 || d.delta.position.z !== 0);

  it('does not run during confirmation (no transformation before activation)', () => {
    let t = 1000;
    for (let i = 0; i < 10; i++) {
      step(controller, makeHand({ gesture: 'GRAB', center: { x: 0.5 + 0.01 * i, y: 0.5, z: 0 } }), t);
      t += FRAME_MS;
    }
    expect(moveUpdates().length).toBe(0);
  });

  it('moves the object with the hand and STOPS when the hand holds still', () => {
    let t = confirmGesture(controller, makeHand({ gesture: 'GRAB' }));

    // Move the hand to a new position over several frames…
    for (let i = 1; i <= 5; i++) {
      step(controller, makeHand({ gesture: 'GRAB', center: { x: 0.5 + 0.02 * i, y: 0.5, z: 0 } }), t);
      t += FRAME_MS;
    }
    expect(moveUpdates().length).toBeGreaterThan(0);

    // …then hold still: the EMA tail converges (~0.5 s of settle), and
    // after that NOTHING further may be emitted — the object is parked.
    for (let i = 0; i < 20; i++) {
      step(controller, makeHand({ gesture: 'GRAB', center: { x: 0.6, y: 0.5, z: 0 } }), t);
      t += FRAME_MS;
    }
    const countBefore = moveUpdates().length;
    for (let i = 0; i < 70; i++) {
      step(controller, makeHand({ gesture: 'GRAB', center: { x: 0.6, y: 0.5, z: 0 } }), t);
      t += FRAME_MS;
    }
    expect(moveUpdates().length).toBe(countBefore);
  });

  it('does not integrate jitter: sensor noise produces no NET drift', () => {
    let t = confirmGesture(controller, makeHand({ gesture: 'GRAB' }));

    for (let i = 0; i < 90; i++) {
      const jitter = Math.sin(i * 1.7) * 0.003; // ±0.3% frame noise
      step(
        controller,
        makeHand({ gesture: 'GRAB', center: { x: 0.5 + jitter, y: 0.5 - jitter, z: 0 } }),
        t,
      );
      t += FRAME_MS;
    }
    // Net displacement (signed) — alternating noise corrections must cancel,
    // not rectify into one-directional drift. (Sum-of-|delta| would measure
    // activity, not stability.)
    const netX = moveUpdates().reduce((s, d) => s + d.delta.position.x, 0);
    const netY = moveUpdates().reduce((s, d) => s + d.delta.position.y, 0);
    expect(Math.abs(netX)).toBeLessThan(0.15);
    expect(Math.abs(netY)).toBeLessThan(0.15);
  });

  it('caps per-frame deltas (a violent flick cannot lunge the object)', () => {
    let t = confirmGesture(controller, makeHand({ gesture: 'GRAB' }));

    for (let i = 1; i <= 3; i++) {
      step(controller, makeHand({ gesture: 'GRAB', center: { x: 0.5 + 0.13 * i, y: 0.5, z: 0 } }), t);
      t += FRAME_MS;
    }
    for (const d of moveUpdates()) {
      expect(Math.abs(d.delta.position.x)).toBeLessThanOrEqual(0.151); // cap + epsilon
    }
  });

  it('MOVE Z: palm-span shrink (hand away from camera) drives +Z; growth drives −Z', () => {
    controller.setControlAxis('Z');
    const spanned = (span: number) => {
      const h = makeHand({ gesture: 'GRAB' });
      h.landmarks = makeLandmarks(0.5, 0.5, span);
      return h;
    };
    let t = confirmGesture(controller, spanned(0.15));

    // Hand retreats → span shrinks → +Z (push-through-screen). The slow
    // depth channel needs a few frames of travel before the correction
    // builds past the deadzone, so feed a sustained retreat.
    for (let i = 1; i <= 10; i++) {
      step(controller, spanned(0.15 - 0.01 * i), t);
      t += FRAME_MS;
    }
    const zPos = updates().filter((d) => d.delta.position.z !== 0).map((d) => d.delta.position.z);
    expect(zPos.some((z) => z > 0.01)).toBe(true);

    // Hand approaches → span grows → −Z.
    for (let i = 1; i <= 10; i++) {
      step(controller, spanned(0.1 + 0.01 * i), t);
      t += FRAME_MS;
    }
    const allZ = updates().filter((d) => d.delta.position.z !== 0).map((d) => d.delta.position.z);
    expect(allZ.some((z) => z < -0.01)).toBe(true);
  });

  it('MOVE Z rejects span noise: holding still does not wobble the depth axis', () => {
    controller.setControlAxis('Z');
    const spanned = (span: number) => {
      const h = makeHand({ gesture: 'GRAB' });
      h.landmarks = makeLandmarks(0.5, 0.5, span);
      return h;
    };
    let t = confirmGesture(controller, spanned(0.15));

    for (let i = 0; i < 90; i++) {
      const noise = Math.sin(i * 2.1) * 0.003 + (i % 7 === 0 ? 0.001 : 0);
      step(controller, spanned(0.15 + noise), t);
      t += FRAME_MS;
    }
    const total = Math.abs(updates().reduce((s, d) => s + d.delta.position.z, 0));
    expect(total).toBeLessThan(0.15);
  });
});

// ─── ROTATE mode ──────────────────────────────────────────

describe('InteractionController: ROTATE (turntable, capped)', () => {
  let controller: InteractionController;
  let deltas: DeltaPayload[];

  beforeEach(() => {
    controller = new InteractionController();
    deltas = [];
    controller.onDelta((p) => deltas.push(p));
  });

  const rotUpdates = () => deltas.filter((d) => d.phase === 'UPDATE' && d.delta.rotation.x + d.delta.rotation.y + d.delta.rotation.z !== 0);

  it('emits rotation deltas only while OPEN_PALM is held (mode is active)', () => {
    controller.setControlAxis('Y');
    let t = confirmGesture(controller, makeHand({ gesture: 'OPEN_PALM' }));
    expect(controller.getInteractionState().mode).toBe('ROTATE');

    // Horizontal movement → yaw (Y).
    for (let i = 1; i <= 5; i++) {
      step(controller, makeHand({ gesture: 'OPEN_PALM', center: { x: 0.5 + 0.03 * i, y: 0.5, z: 0 } }), t);
      t += FRAME_MS;
    }
    expect(rotUpdates().length).toBeGreaterThan(0);
    const ys = rotUpdates().map((d) => d.delta.rotation.y).filter((v) => v !== 0);
    expect(ys.some((v) => v > 0.005)).toBe(true); // turntable direction: right = +Y

    // Pose misread (hand visible): T-03 execution hold — emission continues
    // only within ROTATE_EXECUTION_HOLD_MS (~250 ms ≈ 8 frames) of the last
    // readable-ROTATE frame, then freezes; the mode PERSISTS either way.
    const before = rotUpdates().length;
    const perFrameEmitted: boolean[] = [];
    for (let i = 0; i < 20; i++) {
      const nBefore = deltas.length;
      step(controller, makeHand({ gesture: 'POINT' }), t);
      t += FRAME_MS;
      perFrameEmitted.push(deltas.length > nBefore);
    }
    expect(controller.getInteractionState().mode).toBe('ROTATE');
    // Bounded: at most the hold window emits…
    expect(perFrameEmitted.filter(Boolean).length).toBeLessThanOrEqual(9);
    // …and the hold has EXPIRED well before the misread ends (last 10 frames silent).
    expect(perFrameEmitted.slice(-10).some(Boolean)).toBe(false);

    // Hand leaves the frame for good → clean END.
    for (let i = 0; i < 20; i++) {
      step(controller, null, t);
      t += FRAME_MS;
    }
    expect(controller.getInteractionState().mode).toBe('NONE');
    expect(rotUpdates().length).toBe(before + perFrameEmitted.filter(Boolean).length);
  });

  it('caps rotation deltas and rejects tremor (no wobble)', () => {
    let t = confirmGesture(controller, makeHand({ gesture: 'OPEN_PALM' }));

    for (let i = 0; i < 90; i++) {
      const tremor = Math.sin(i * 1.3) * 0.005;
      step(controller, makeHand({ gesture: 'OPEN_PALM', center: { x: 0.5, y: 0.5 + tremor, z: 0 } }), t);
      t += FRAME_MS;
    }
    const total = Math.abs(rotUpdates().reduce((s, d) => s + d.delta.rotation.x, 0));
    expect(total).toBeLessThan(0.06); // radians

    // Intentional larger movement is still capped.
    for (let i = 1; i <= 3; i++) {
      step(controller, makeHand({ gesture: 'OPEN_PALM', center: { x: 0.5, y: 0.5 - 0.1 * i, z: 0 } }), t);
      t += FRAME_MS;
    }
    for (const d of rotUpdates()) {
      expect(Math.abs(d.delta.rotation.x)).toBeLessThanOrEqual(0.081); // cap + epsilon
    }
  });
});

// ─── SCALE mode ───────────────────────────────────────────

describe('InteractionController: SCALE session survival (no re-detection)', () => {
  it('vertical hand travel while holding the static pose keeps the session alive', () => {
    const controller = new InteractionController();
    const deltas: DeltaPayload[] = [];
    controller.onDelta((p) => deltas.push(p));
    let t = confirmGesture(controller, makeHand({ gesture: 'SCALE_POSE', pinchDistance: 0.04 }));
    expect(controller.getInteractionState().mode).toBe('SCALE');

    // The pose stays EXACTLY the same while the hand travels vertically —
    // the full-frame travel is legitimate scale input, not a gesture loss.
    // The session must survive (no END) and keep emitting scale.
    for (let i = 1; i <= 12; i++) {
      const s = step(
        controller,
        makeHand({ gesture: 'SCALE_POSE', pinchDistance: 0.04, center: { x: 0.5, y: 0.5 - 0.01 * i, z: 0 } }),
        t + i * FRAME_MS,
      );
      expect(s.mode).toBe('SCALE');
      expect(s.confirm).toBeNull(); // the pose never re-triggers Scale
    }
    expect(deltas.filter((d) => d.phase === 'END').length).toBe(0);
    const scaleUpdates = deltas.filter(
      (d) => d.phase === 'UPDATE' && d.delta.scale.x !== 1,
    );
    expect(scaleUpdates.length).toBeGreaterThan(0);
    // Hand traveled UP (y decreasing) → factors must all be > 1 (grow).
    expect(scaleUpdates.every((d) => d.delta.scale.x > 1)).toBe(true);

    // A competing gesture (OPEN_PALM) becomes a ROTATE candidate: after the
    // 1-second confirm, the mode actually SWITCHES (not a teardown to NONE).
    for (let i = 13; i < 13 + CONFIRM_FRAMES + 2; i++) {
      step(controller, makeHand({ gesture: 'OPEN_PALM' }), t + i * FRAME_MS);
    }
    expect(controller.getInteractionState().mode).toBe('ROTATE');
  });

  it('axis switch requires the finger count to hold for ~300 ms (miscount debounce)', async () => {
    const { detectAxisStable, resetAxisStability } = await import(
      '../../src/engine-cv/cv-engine'
    );
    resetAxisStability();
    // Noisy flicker: 1→2→3→2→1 fingers — nothing may win.
    expect(detectAxisStable(1, 1000)).toBeNull();
    expect(detectAxisStable(2, 1033)).toBeNull();
    expect(detectAxisStable(3, 1066)).toBeNull();
    expect(detectAxisStable(2, 1099)).toBeNull();
    expect(detectAxisStable(1, 1132)).toBeNull();
    // Stable count for 300 ms → the axis commits.
    for (let i = 4; i < 14; i++) expect(detectAxisStable(3, 1000 + i * 33)).toBeNull();
    expect(detectAxisStable(3, 1500)).toBe('Z');
    // A single miscounted frame does NOT flip the axis: 'Z' stays committed.
    expect(detectAxisStable(2, 1533)).toBe('Z');
    expect(detectAxisStable(3, 1566)).toBe('Z');
  });

  describe('InteractionController: SCALE (baseline vertical-delta)', () => {
  let controller: InteractionController;
  let deltas: DeltaPayload[];

  beforeEach(() => {
    controller = new InteractionController();
    deltas = [];
    controller.onDelta((p) => deltas.push(p));
  });

  const scaleUpdates = () =>
    deltas.filter(
      (d) =>
        d.phase === 'UPDATE' &&
        (d.delta.scale.x !== 1 || d.delta.scale.y !== 1 || d.delta.scale.z !== 1),
    );

  it('hand up grows, hand down shrinks — relative to the confirmation-time baseline', () => {
    // Enter with the hand at y=0.5: that position IS the baseline.
    const pose = (y: number) => makeHand({ gesture: 'SCALE_POSE', center: { x: 0.5, y, z: 0 } });
    let t = confirmGesture(controller, pose(0.5));
    expect(controller.getInteractionState().mode).toBe('SCALE');

    // Hand UP (image y decreases) → grow.
    for (let i = 1; i <= 6; i++) {
      step(controller, pose(0.5 - 0.015 * i), t);
      t += FRAME_MS;
    }
    const grows = scaleUpdates().map((d) => d.delta.scale.x);
    expect(grows.length).toBeGreaterThan(0);
    expect(grows.every((f) => f > 1)).toBe(true);

    // Hand DOWN past the baseline → shrink, immediately (proportional both ways).
    for (let i = 1; i <= 6; i++) {
      step(controller, pose(0.5 + 0.015 * i), t);
      t += FRAME_MS;
    }
    const all = scaleUpdates().map((d) => d.delta.scale.x);
    expect(all.some((f) => f < 1)).toBe(true);
    // Multiplicative factors, bounded per frame.
    for (const f of all) {
      expect(f).toBeGreaterThan(0.9);
      expect(f).toBeLessThan(1.1);
    }
  });

  it('held-still hand emits nothing (baseline is the confirmation-time position)', () => {
    const pose = (y: number) => makeHand({ gesture: 'SCALE_POSE', center: { x: 0.5, y, z: 0 } });
    let t = confirmGesture(controller, pose(0.5));

    for (let i = 0; i < 60; i++) {
      step(controller, pose(0.5), t);
      t += FRAME_MS;
    }
    expect(scaleUpdates().length).toBe(0);
  });

  it('scale SETTLES after a fast sweep and then freezes (no drift on a stationary hand)', () => {
    // After a sweep stops, the slow input EMA still converges for a bounded
    // moment (the same settle-glide the MOVE-Z channel has) — that is not
    // drift. The contract: once settled (~1.3 s), a STATIONARY hand emits
    // nothing further, forever (anchored correction → Schmitt deadzone).
    const pose = (y: number) => makeHand({ gesture: 'SCALE_POSE', center: { x: 0.5, y, z: 0 } });
    let t = confirmGesture(controller, pose(0.5));
    for (let i = 1; i <= 10; i++) {
      step(controller, pose(0.5 - 0.012 * i), t);
      t += FRAME_MS;
    }
    // Settle window: convergence may emit a bounded glide…
    for (let i = 0; i < 40; i++) {
      step(controller, pose(0.38), t);
      t += FRAME_MS;
    }
    const settledCount = scaleUpdates().length;
    expect(settledCount).toBeGreaterThan(0);
    // …then a stationary hand must never emit again.
    for (let i = 0; i < 60; i++) {
      step(controller, pose(0.38), t);
      t += FRAME_MS;
    }
    expect(scaleUpdates().length).toBe(settledCount);
  });

  it('applies scale PER-AXIS: only the selected axis takes the factor', () => {
    const pose = (y: number) => makeHand({ gesture: 'SCALE_POSE', center: { x: 0.5, y, z: 0 } });
    controller.setControlAxis('X');
    let t = confirmGesture(controller, pose(0.5));

    for (let i = 1; i <= 4; i++) {
      step(controller, pose(0.5 - 0.015 * i), t);
      t += FRAME_MS;
    }
    const ups = scaleUpdates();
    expect(ups.length).toBeGreaterThan(0);
    for (const d of ups) {
      // X moves, Y/Z pass through at exactly 1.
      expect(d.delta.scale.x).not.toBe(1);
      expect(d.delta.scale.y).toBe(1);
      expect(d.delta.scale.z).toBe(1);
    }
  });

  it('per-axis scale follows the selected axis (Y case)', () => {
    const pose = (y: number) => makeHand({ gesture: 'SCALE_POSE', center: { x: 0.5, y, z: 0 } });
    controller.setControlAxis('Y');
    let t = confirmGesture(controller, pose(0.5));

    for (let i = 1; i <= 4; i++) {
      step(controller, pose(0.5 + 0.012 * i), t);
      t += FRAME_MS;
    }
    const ups = scaleUpdates();
    expect(ups.length).toBeGreaterThan(0);
    for (const d of ups) {
      expect(d.delta.scale.y).not.toBe(1);
      expect(d.delta.scale.x).toBe(1);
      expect(d.delta.scale.z).toBe(1);
    }
  });

  it('thumb-index distance has NO effect on the scale amount', () => {
    // Same vertical trajectory with different pinch gaps — identical output
    // proves the pinch channel is no longer the scale input.
    const pose = (y: number, gap: number) => makeHand({ gesture: 'SCALE_POSE', pinchDistance: gap, center: { x: 0.5, y, z: 0 } });
    const runOne = (gap: number) => {
      const c = new InteractionController();
      const out: DeltaPayload[] = [];
      c.onDelta((p) => out.push(p));
      let tt = confirmGesture(c, pose(0.5, gap));
      for (let i = 1; i <= 5; i++) {
        step(c, pose(0.5 - 0.015 * i, gap), tt);
        tt += FRAME_MS;
      }
      return out.filter((d) => d.phase === 'UPDATE').map((d) => d.delta.scale.x);
    };
    expect(runOne(0.01)).toEqual(runOne(0.09));
  });
});

// ─── Pause / re-anchor (left open palm) ───────────────────

describe('InteractionController: left-palm pause + re-anchor', () => {
  let controller: InteractionController;
  let deltas: DeltaPayload[];

  beforeEach(() => {
    controller = new InteractionController();
    deltas = [];
    controller.onDelta((p) => deltas.push(p));
  });

  const updates = () => deltas.filter((d) => d.phase === 'UPDATE');

  it('freezes the transformation while the left palm is open, resumes with a fresh baseline', () => {
    const pose = (y: number, cx = 0.5) =>
      makeHand({ gesture: 'SCALE_POSE', center: { x: cx, y, z: 0 } });
    let t = confirmGesture(controller, pose(0.5));
    expect(controller.getInteractionState().mode).toBe('SCALE');

    // Scale UP first: the object is larger than at activation.
    for (let i = 1; i <= 6; i++) {
      step(controller, pose(0.5 - 0.015 * i), t);
      t += FRAME_MS;
    }
    expect(updates().filter((d) => d.delta.scale.x !== 1).length).toBeGreaterThan(0);

    // Left palm open long enough to confirm pause (PAUSE_CONFIRM_FRAMES).
    const leftPalm = makeHand({ gesture: 'OPEN_PALM', handedness: 'left' });
    let st = { mode: 'SCALE' as const, paused: false, confirm: null };
    for (let i = 0; i < 14; i++) {
      st = step(controller, pose(0.35), t, leftPalm);
      t += FRAME_MS;
    }
    expect(st.paused).toBe(true);

    // While paused: the right hand is REPOSITIONED far below — NO deltas,
    // scale frozen.
    const before = updates().length;
    for (let i = 0; i < 10; i++) {
      step(controller, pose(0.7), t, leftPalm);
      t += FRAME_MS;
    }
    expect(updates().length).toBe(before);

    // Palm released: the resume grace (~700 ms) keeps it frozen, then the
    // CURRENT right-hand vertical position (0.7) becomes the NEW baseline —
    // scale stays where it was, and upward travel resumes growing from it
    // (repeatable scaling beyond the comfortable hand range).
    step(controller, pose(0.7), t);
    t += FRAME_MS;
    step(controller, pose(0.7), t + 800);
    t += 800 + FRAME_MS;
    expect(controller.getInteractionState().paused).toBe(false);
    const resumeCount = updates().length;
    for (let i = 1; i <= 4; i++) {
      step(controller, pose(0.7 - 0.012 * i), t);
      t += FRAME_MS;
    }
    const resume = updates().slice(resumeCount).map((d) => d.delta.scale.x);
    expect(resume.every((f) => f > 1)).toBe(true);
    for (const f of resume) expect(f).toBeLessThan(1.05); // proportional, not a jump
  });

  it('pause does not change the active mode', () => {
    let t = confirmGesture(controller, makeHand({ gesture: 'GRAB' }));
    const leftPalm = makeHand({ gesture: 'OPEN_PALM', handedness: 'left' });
    let st = { mode: 'MOVE' as const, paused: false, confirm: null };
    for (let i = 0; i < 14; i++) {
      st = step(controller, makeHand({ gesture: 'GRAB' }), t, leftPalm);
      t += FRAME_MS;
    }
    expect(st.mode).toBe('MOVE');
    expect(st.paused).toBe(true);

    // Release → the resume grace (~700 ms) keeps it frozen briefly, then
    // it resumes still MOVE, re-anchored.
    st = step(controller, makeHand({ gesture: 'GRAB', center: { x: 0.3, y: 0.5, z: 0 } }), t);
    expect(st.paused).toBe(true);
    t += FRAME_MS;
    st = step(controller, makeHand({ gesture: 'GRAB', center: { x: 0.3, y: 0.5, z: 0 } }), t + 800);
    t += 800 + FRAME_MS;
    expect(st.paused).toBe(false);
    expect(st.mode).toBe('MOVE');
  });
});

// ─── Recovery / robustness ────────────────────────────────

describe('InteractionController: recovery and robustness', () => {
  let controller: InteractionController;
  let deltas: DeltaPayload[];

  beforeEach(() => {
    controller = new InteractionController();
    deltas = [];
    controller.onDelta((p) => deltas.push(p));
  });

  const updates = () => deltas.filter((d) => d.phase === 'UPDATE');
  const ends = () => deltas.filter((d) => d.phase === 'END');

  it('absorbs brief tracking loss (freeze) and ends cleanly after sustained loss', () => {
    let t = confirmGesture(controller, makeHand({ gesture: 'GRAB' }));

    // ~300 ms of missing hand (< grace): session survives, frozen.
    for (let i = 0; i < 9; i++) {
      step(controller, null, t);
      t += FRAME_MS;
    }
    expect(ends().length).toBe(0);
    expect(updates().length).toBe(0);

    // Reappears: re-anchored, no jump.
    const st = step(controller, makeHand({ gesture: 'GRAB', center: { x: 0.2, y: 0.3, z: 0 } }), t);
    expect(st.mode).toBe('MOVE');
    const last = updates()[updates().length - 1];
    if (last) {
      const mag = Math.hypot(last.delta.position.x, last.delta.position.y);
      expect(mag).toBeLessThan(0.2);
    }

    // Sustained loss (> grace): clean END, mode NONE.
    for (let i = 0; i < 20; i++) {
      step(controller, null, t);
      t += FRAME_MS;
    }
    expect(controller.getInteractionState().mode).toBe('NONE');
    expect(ends().length).toBe(1);
  });

  it('re-anchors instead of gliding when the hand teleports (tracker glitch)', () => {
    let t = confirmGesture(controller, makeHand({ gesture: 'GRAB' }));

    // Steady drift first.
    step(controller, makeHand({ gesture: 'GRAB', center: { x: 0.55, y: 0.5, z: 0 } }), t);
    t += FRAME_MS;
    const before = updates().length;

    // 0.45-frame jump (> TELEPORT_SNAP 0.4): no delta may be emitted.
    step(controller, makeHand({ gesture: 'GRAB', center: { x: 1.0, y: 0.5, z: 0 } }), t);
    t += FRAME_MS;
    expect(updates().length).toBe(before);

    // Motion resumes from the new anchor, bounded.
    step(controller, makeHand({ gesture: 'GRAB', center: { x: 1.02, y: 0.5, z: 0 } }), t);
    const last = updates()[updates().length - 1];
    if (last) {
      expect(Math.abs(last.delta.position.x)).toBeLessThan(0.2);
    }
  });

  it('survives a handedness flip mid-session (the transforming hand moves slots)', () => {
    let t = confirmGesture(controller, makeHand({ gesture: 'GRAB' }));
    const before = updates().length;

    // Right slot empty; the SAME grabbing hand now reports as Left.
    const flipped = makeHand({ gesture: 'GRAB', handedness: 'left', center: { x: 0.57, y: 0.5, z: 0 } });
    const st = step(controller, null, t, flipped);
    expect(st.mode).toBe('MOVE');

    // And transforms keep flowing from the promoted hand.
    step(controller, null, t + FRAME_MS, makeHand({ gesture: 'GRAB', handedness: 'left', center: { x: 0.62, y: 0.5, z: 0 } }));
    expect(updates().length).toBeGreaterThan(before);
  });

  it('left Z-selection pose never hijacks the session on right-slot dropout (co-presence gate)', () => {
    let t = confirmGesture(controller, makeHand({ gesture: 'GRAB' }));
    expect(controller.getInteractionState().mode).toBe('MOVE');

    // Left hand shows the 3-finger Z-axis pose WHILE the right hand is
    // healthy (co-presence — the normal axis-selection situation).
    const zSelect = makeHand({ gesture: 'ROTATE_3', handedness: 'left', center: { x: 0.2, y: 0.5, z: 0 } });
    for (let i = 0; i < 18; i++) {
      step(controller, makeHand({ gesture: 'GRAB' }), t, zSelect);
      t += FRAME_MS;
    }
    expect(controller.getInteractionState().mode).toBe('MOVE');

    // Right slot drops out (tracker glitch) while the left pose persists:
    // the left hand must NOT be promoted (that hijacked the session — the
    // mode flipped to ROTATE and the object rotated on a phantom input).
    let flippedToRotate = false;
    for (let i = 0; i < 40; i++) {
      const st = step(controller, null, t, zSelect);
      t += FRAME_MS;
      if (st.mode === 'ROTATE') flippedToRotate = true;
    }
    expect(flippedToRotate).toBe(false);
  });

  it('never throws on garbage frames and emits only finite deltas', () => {
    expect(() =>
      controller.processFrame(makeFrame({ rightHand: { ...makeHand(), landmarks: [] } as unknown as HandState }), 1000 as TimestampMs),
    ).not.toThrow();
    expect(() =>
      controller.processFrame(makeFrame({ rightHand: makeHand({ confidence: NaN, center: { x: NaN, y: 0.5, z: 0 }, wrist: { x: 0.5, y: Infinity, z: 0 } }) }), 1000 as TimestampMs),
    ).not.toThrow();
    expect(() =>
      controller.processFrame(makeFrame({ rightHand: { ...makeHand(), pinchDistance: undefined } as unknown as HandState }), 1000 as TimestampMs),
    ).not.toThrow();

    for (const d of deltas) {
      expect(Number.isFinite(d.delta.position.x)).toBe(true);
      expect(Number.isFinite(d.delta.scale.x)).toBe(true);
    }
  });

  it('full lifecycle: BEGIN once, updates flow, END exactly once per activation', () => {
    let t = confirmGesture(controller, makeHand({ gesture: 'GRAB' }));
    for (let i = 1; i <= 10; i++) {
      step(controller, makeHand({ gesture: 'GRAB', center: { x: 0.5 + 0.01 * i, y: 0.5, z: 0 } }), t);
      t += FRAME_MS;
    }
    // A pose misread must not add lifecycle events (frozen, still MOVE)…
    for (let i = 0; i < 20; i++) {
      step(controller, makeHand({ gesture: 'POINT' }), t);
      t += FRAME_MS;
    }
    expect(controller.getInteractionState().mode).toBe('MOVE');
    // …then the hand leaves the frame for good: exactly one END.
    for (let i = 0; i < 20; i++) {
      step(controller, null, t);
      t += FRAME_MS;
    }
    expect(deltas.filter((d) => d.phase === 'BEGIN').length).toBe(1);
    expect(ends().length).toBe(1);
    expect(updates().length).toBeGreaterThan(0);
  });
});

// ─── Transform Service: multiplicative scale safety ───────

describe('TransformService SCALE_FACTOR (CV scale path)', () => {
  let eventBus: EventBus;
  let scene: THREE.Scene;
  let sceneManager: SceneManager;
  let transformService: TransformService;
  let objectId: string;
  let testObject: THREE.Object3D;

  beforeEach(() => {
    eventBus = new EventBus();
    scene = new THREE.Scene();
    sceneManager = new SceneManager(scene);
    transformService = new TransformService(eventBus, sceneManager);
    testObject = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
    objectId = sceneManager.addObject(testObject, 'Test Cube');
  });

  const factorCmd = (factor: number) => ({
    commandId: 'cmd-scale',
    source: 'CV' as const,
    objectId,
    operation: 'SCALE_FACTOR' as const,
    property: 'SCALE' as const,
    values: { x: factor, y: factor, z: factor },
    history: 'RECORD' as const,
  });

  it('applies multiplicative scale', () => {
    testObject.scale.set(2, 2, 2);
    transformService.apply(factorCmd(1.1));
    expect(testObject.scale.x).toBeCloseTo(2.2);
  });

  it('rejects factors that would collapse the object', () => {
    testObject.scale.set(0.00005, 1, 1); // 0.00005 × 0.5 < 1e-4
    const result = transformService.apply(factorCmd(0.5));
    expect(result).toBe(false);
    expect(testObject.scale.x).toBeCloseTo(0.00005); // unchanged
  });
});

// ─── HandFrameProducer: pinch hysteresis + 2D pinch + palm center ───────

describe('HandFrameProducer (pinch reliability)', () => {
  const FRAME_MS = 33;
  let producer: HandFrameProducer;

  beforeEach(() => {
    producer = new HandFrameProducer();
  });

  /** Raw MediaPipe-style result. Palm: wrist(0)=(0.5,0.8), middleMCP(9)=(0.5,0.65)
   *  → span 0.15. Thumb tip(4) and index tip(8) placed `gap` apart. */
  const mpPinchishHand = (gap: number, opts: { zSep?: number; curled?: boolean } = {}) => {
    const lm = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.7, z: 0 }));
    lm[0] = { x: 0.5, y: 0.8, z: 0 }; // wrist
    lm[9] = { x: 0.5, y: 0.65, z: 0 }; // middle MCP → span 0.15
    // Fingers curled unless overridden (finger tips fall back toward the palm).
    if (opts.curled !== false) {
      for (const [tip, pip] of [[8, 6], [12, 10], [16, 14], [20, 18]] as const) {
        lm[tip] = { x: 0.5, y: 0.74, z: 0 };
        lm[pip] = { x: 0.5, y: 0.72, z: 0 };
      }
    }
    // Thumb tip and index tip separated by `gap` (2D), optionally split in z.
    // Placed at mid-palm depth: a real pinch's index tip projects inside the
    // palm silhouette, so it stays honestly "curled" at every gap size.
    const zSep = opts.zSep ?? 0;
    lm[4] = { x: 0.5 - gap / 2, y: 0.74, z: -zSep };
    lm[8] = { x: 0.5 + gap / 2, y: 0.74, z: zSep };
    lm[6] = { x: 0.5 + gap / 2, y: 0.7, z: 0 };
    return {
      landmarks: [lm],
      handedness: [[{ categoryName: 'Right', score: 0.95 }]],
    };
  };

  it('keeps PINCH through the hysteresis band instead of flickering to GRAB', () => {
    // Establish a firm pinch (gap 0.03 < 0.28 × span 0.15).
    let t = 1000;
    producer.processFrame(mpPinchishHand(0.03), t as TimestampMs);
    t += FRAME_MS;
    // Open to the hysteresis band (gap 0.06 = 0.4 × span — above the 0.28
    // enter threshold, below the 0.45 exit threshold). The previous
    // behavior let extension-estimate noise flip this to GRAB — which the
    // controller turned into an accidental MOVE mid-scale.
    const frame = producer.processFrame(mpPinchishHand(0.06), t as TimestampMs);
    expect(frame.rightHand?.gesture).toBe('PINCH');
  });

  it('exits PINCH only once the gap clearly reopens, then classifies normally', () => {
    let t = 1000;
    producer.processFrame(mpPinchishHand(0.03), t as TimestampMs);
    t += FRAME_MS;
    producer.processFrame(mpPinchishHand(0.06), t as TimestampMs); // band — hold
    t += FRAME_MS;
    // Fully open (gap 0.09 = 0.6 × span > 0.45 exit): leave PINCH. Fingers
    // are curled, so the honest classification is GRAB.
    const frame = producer.processFrame(mpPinchishHand(0.09), t as TimestampMs);
    expect(frame.rightHand?.gesture).toBe('GRAB');
  });

  it('reports a 2D pinch distance: z noise cannot inflate it into a GRAB', () => {
    // Same physical pinch, but the thumb/index z estimates disagree wildly
    // (MediaPipe z noise). The 3D distance would be ~0.12 — far past any
    // threshold — and the gesture fell through to GRAB (accidental MOVE).
    const frame = producer.processFrame(mpPinchishHand(0.03, { zSep: 0.12 }), 1000 as TimestampMs);
    expect(frame.rightHand?.gesture).toBe('PINCH');
    expect(frame.rightHand?.pinchDistance).toBeCloseTo(0.03, 5); // 2D only
  });

  it('UI pointer ownership: LEFT hand owns the pointer; right never steals it', () => {
    const mkLm = (cx: number, cy: number, kind: string) => {
      const l: Array<{ x: number; y: number; z: number }> = [];
      for (let i = 0; i < 21; i++) l.push({ x: cx, y: cy + 0.1, z: 0 });
      l[0] = { x: cx, y: cy + 0.1, z: 0 };
      l[9] = { x: cx, y: cy, z: 0 };
      if (kind === 'POINT') {
        l[8] = { x: cx, y: cy - 0.08, z: 0 };
        l[6] = { x: cx, y: cy - 0.04, z: 0 };
        l[4] = { x: cx + 0.12, y: cy - 0.08, z: 0 };
      } else {
        l[8] = { x: cx, y: cy, z: 0 };
        l[6] = { x: cx, y: cy - 0.02, z: 0 };
        l[4] = { x: cx + 0.02, y: cy, z: 0 };
      }
      return l;
    };
    const mp = (hands: Array<{ lm: ReturnType<typeof mkLm>; cat: string }>, ts: number) => ({
      landmarks: hands.map((h) => h.lm),
      handedness: hands.map((h) => [{ categoryName: h.cat, score: 0.95 }]),
    }) as never;
    const producer = new HandFrameProducer();
    // LEFT points + RIGHT pinches (transform gesture): pointer is LEFT-owned.
    const f1 = producer.processFrame(
      mp([{ lm: mkLm(0.2, 0.3, 'POINT'), cat: 'Left' }, { lm: mkLm(0.7, 0.4, 'PINCH'), cat: 'Right' }], 1000),
      1000 as TimestampMs,
    );
    expect(f1.pointer?.sourceHand).toBe('left');
    // Both pointing: LEFT still owns it (right must never steal).
    const f2 = producer.processFrame(
      mp([{ lm: mkLm(0.2, 0.3, 'POINT'), cat: 'Left' }, { lm: mkLm(0.7, 0.4, 'POINT'), cat: 'Right' }], 1033),
      1033 as TimestampMs,
    );
    expect(f2.pointer?.sourceHand).toBe('left');
    // With no left hand at all, the right hand may serve as pointer.
    const producer2 = new HandFrameProducer();
    const f3 = producer2.processFrame(
      mp([{ lm: mkLm(0.7, 0.3, 'POINT'), cat: 'Right' }], 5000),
      5000 as TimestampMs,
    );
    expect(f3.pointer?.sourceHand).toBe('right');
  });

  it('pointer lingers while the pointing hand switches to a transform gesture', () => {
    // Wrist at (0.5, 0.6); PIP at (0.5, 0.45). Tip beyond PIP = extended.
    const base = () => {
      const lm: Array<{ x: number; y: number; z: number }> = [];
      for (let i = 0; i < 21; i++) lm.push({ x: 0.5, y: 0.6, z: 0 });
      lm[9] = { x: 0.5, y: 0.5, z: 0 }; // middle MCP (span=0.1)
      lm[6] = { x: 0.5, y: 0.45, z: 0 }; // index PIP
      lm[10] = { x: 0.5, y: 0.55, z: 0 }; // middle PIP
      lm[14] = { x: 0.5, y: 0.55, z: 0 };
      lm[18] = { x: 0.5, y: 0.55, z: 0 };
      return lm;
    };
    const point = () => {
      const lm = base();
      lm[0] = { x: 0.5, y: 0.6, z: 0 };
      lm[8] = { x: 0.5, y: 0.35, z: 0 }; // index tip extended
      lm[4] = { x: 0.65, y: 0.55, z: 0 }; // thumb away
      return lm;
    };
    const grab = () => {
      const lm = base();
      lm[0] = { x: 0.5, y: 0.6, z: 0 };
      lm[8] = { x: 0.5, y: 0.5, z: 0 }; // index tip curled (closer than PIP)
      lm[4] = { x: 0.55, y: 0.5, z: 0 };
      return lm;
    };
    const mp = (lm: Array<{ x: number; y: number; z: number }>, t: number) => ({
      landmarks: [lm],
      handedness: [[{ categoryName: 'Right', score: 0.95 }]],
      t,
    });
    const producer = new HandFrameProducer();
    const f1 = producer.processFrame(mp(point(), 1000) as never, 1000 as TimestampMs);
    expect(f1.pointer?.active).toBe(true);
    // The pointing hand makes a fist (camera gesture): pointer must linger.
    const f2 = producer.processFrame(mp(grab(), 1300) as never, 1300 as TimestampMs);
    expect(f2.rightHand?.gesture).toBe('GRAB');
    expect(f2.pointer?.active).toBe(true);
    // Long after the linger window: pointer is gone.
    const f3 = producer.processFrame(mp(grab(), 3000) as never, 3000 as TimestampMs);
    expect(f3.pointer).toBeNull();
  });

  it('palm center ignores finger curl (no phantom motion while pinching)', () => {
    // Fingertips sweeping down as the pinch opens used to drag the 21-point
    // centroid — converted by the controller into phantom MOVE drift.
    const curled = mpPinchishHand(0.03);
    const splayed = mpPinchishHand(0.03);
    for (const i of [8, 12, 16, 20]) splayed.landmarks[0][i] = { x: 0.5, y: 0.2, z: 0 }; // tips fly up

    const c1 = producer.processFrame(curled, 1000 as TimestampMs).rightHand!.center;
    const c2 = producer.processFrame(splayed, 1033 as TimestampMs).rightHand!.center;
    expect(Math.hypot(c2.x - c1.x, c2.y - c1.y)).toBeLessThan(1e-6);
  });
});

// ─── PointerProcessor: hover/hold targeting ─────────────

describe('PointerProcessor: immediate hover + 1s-hold selection', () => {
  it('row hits take priority over the panel that contains them (and keep it open)', async () => {
    const { PointerProcessor } = await import('../../src/engine-cv/pointer/pointer-processor');
    const pp = new PointerProcessor();
    const events: string[] = [];
    pp.setEventHandlers({
      onTabEnter: (id) => events.push(`enter:${id}`),
      onTabLeave: () => events.push('leave'),
      onModuleHover: (id) => events.push(`hover:${id ?? 'none'}`),
      onModuleSelect: (id) => events.push(`select:${id}`),
      onModuleHoldProgress: (id, p) => events.push(`prog:${id}:${p.toFixed(2)}`),
    });
    // Panel contains the row (overlapping bounds) — the row must win the hit.
    pp.setTargets([
      { id: 'tab:MODULE_SELECTION', type: 'tab', x: 0.1, y: 0.0, width: 0.3, height: 0.08 },
      { id: 'panel:MODULE_SELECTION', type: 'panel', x: 0.1, y: 0.08, width: 0.3, height: 0.4 },
      { id: 'module:A', type: 'module-row', x: 0.12, y: 0.12, width: 0.26, height: 0.06 },
    ]);
    const ptr = { x: 0.2, y: 0.15, active: true } as never;
    // Frame 1: inside the row → row hover fires, and the tab context opens.
    pp.processPointer(ptr, 1000);
    expect(events).toContain('hover:A');
    expect(events).toContain('enter:MODULE_SELECTION');
    // One second later, still over the row → selection fires.
    events.length = 0;
    pp.processPointer(ptr, 2100);
    expect(events).toContain('select:A');
    // Moving to a spot covered ONLY by the panel does NOT collapse it.
    events.length = 0;
    pp.processPointer({ x: 0.35, y: 0.2, active: true } as never, 2200);
    expect(events).not.toContain('leave');
    // Leaving tab AND panel collapses.
    pp.processPointer({ x: 0.9, y: 0.9, active: true } as never, 2300);
    expect(events).toContain('leave');
  });

  it('leaving a row early cancels the hold (no selection)', async () => {
    const { PointerProcessor } = await import('../../src/engine-cv/pointer/pointer-processor');
    const pp = new PointerProcessor();
    let selected: string | null = null;
    pp.setEventHandlers({
      onTabEnter: () => {},
      onTabLeave: () => {},
      onModuleHover: () => {},
      onModuleSelect: (id) => { selected = id; },
      onModuleHoldProgress: () => {},
    });
    pp.setTargets([{ id: 'module:A', type: 'module-row', x: 0, y: 0, width: 0.2, height: 0.1 }]);
    pp.processPointer({ x: 0.1, y: 0.05, active: true } as never, 1000);
    pp.processPointer({ x: 0.1, y: 0.05, active: true } as never, 1400); // 0.4 s in
    pp.processPointer({ x: 0.5, y: 0.5, active: true } as never, 1500); // leave at 0.5 s
    pp.processPointer({ x: 0.1, y: 0.05, active: true } as never, 2100); // would-be past 1 s
    expect(selected).toBeNull();
  });
});
});
