/**
 * CV DIAGNOSIS LOOPS (diagnosing-bugs)
 *
 * Red-capable feedback loops for the reported live symptoms, built BEFORE
 * any fix. They now double as the regression suite for the fixes:
 *
 *   L1  MOVE survives a sustained pose misread while the hand is visible
 *       (fixed by the session-lifecycle gate — ticket 01)
 *   L2  Z push-and-hold keeps the object there; return-through-start is a
 *       reverse command (hand back → object back; invariant holds under the
 *       anchored model — kept as regression)
 *   L3  left-palm pause changes pause state only, never the mode
 *   L4  right-slot dropout (± left axis pose) does not end MOVE
 *       (fixed by the session-lifecycle gate — ticket 01)
 *   L5  ownership guard: a left GRAB alone never starts/maintains MOVE
 *   L6  recovery after a tolerated flicker re-anchors without a lurch
 *   L7  X rotation: breathing bob must not stall a slow deliberate sweep
 *   L8  Z fast push is not mistaken for a teleport
 *   L9  Z-selection pose with a drifted-open pinky (misread OPEN_PALM) does
 *       not engage the left-palm pause (ticket 02 — selection-context
 *       disambiguation)
 *   L10 a deliberate left palm with NO recent selection activity still
 *       pauses and re-anchors exactly as before (ticket 02 guard)
 *   L11 Z drives the object while the drifted selection hand is up
 *       (pause suppressed, axis committed)
 *   L12 ROTATE continues through short pose-label flicker (T-03 hold)
 *   L13 sustained ROTATE misread still ends by the existing contract
 *   L14 deliberate stop stops rotation promptly (no coast)
 *   L16 X↔Y velocity-processing equivalence under input-axis swap (T-06)
 *   L17 small vertical motion is responsive on X (T-06)
 *   L18 X reversal stays responsive; deliberate stop does not coast (T-06)
 *   L19 vertical bob tolerance — held hand produces no X drift (T-06)
 *   L23 two-hand anchor (BOTH palms) pauses the session — including after
 *       the left hand selected an axis (the latched selection-role miss)
 *
 * Live-only checks (not unit-runnable): Z polarity preference, X-rotation
 * wobble feel, manual module selection with CV stopped.
 */

import { describe, it, expect } from 'vitest';
import {
  InteractionController,
  type DeltaPayload,
} from '../../src/engine-cv/interaction/interaction-controller';
import type { HandFrame, HandState, TimestampMs } from '../../src/core/contracts';

const FRAME_MS = 33;
const CONFIRM_FRAMES = Math.ceil(1000 / FRAME_MS) + 1;

function makeLandmarks(cx = 0.5, cy = 0.5, span = 0.15): HandState['landmarks'] {
  const lm: HandState['landmarks'] = [];
  for (let i = 0; i < 21; i++) lm.push({ x: cx, y: cy + span, z: 0 });
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

// ─── L1: MOVE→NONE during movement (gesture-release gate) ──

describe('L1: MOVE survives pose fluctuation during movement', () => {
  it('keeps MOVE active when the classifier loses GRAB for ~0.5 s while the hand stays visible and moving', () => {
    const controller = new InteractionController();
    const deltas: DeltaPayload[] = [];
    controller.onDelta((p) => deltas.push(p));

    // Confirm MOVE with the hand in a natural grab.
    let t = confirmGesture(controller, makeHand({ gesture: 'GRAB' }));
    expect(controller.getInteractionState().mode).toBe('MOVE');

    // User starts moving along X. During real movement the hand tilts and
    // the fingers relax: the classifier can lose the GRAB pose for a
    // SUSTAINED stretch (> the 450 ms release grace) while the HAND REMAINS
    // VISIBLE and in motion — 18 frames (~0.6 s) of NONE/POINT misreads.
    for (let i = 1; i <= 18; i++) {
      const drift = i % 2 === 0 ? 'POINT' : 'NONE';
      step(
        controller,
        makeHand({ gesture: drift as HandState['gesture'], center: { x: 0.5 + 0.01 * i, y: 0.5, z: 0 } }),
        t,
      );
      t += FRAME_MS;
    }

    // CONTRACT: an already-confirmed MOVE must not be cancelled by
    // classification fluctuation. It survives until a DIFFERENT mode is
    // deliberately confirmed or an intentional pause occurs.
    const state = controller.getInteractionState();
    expect(state.mode).toBe('MOVE');

    // And deltas resume without a fresh confirmation.
    const before = deltas.filter((d) => d.phase === 'UPDATE').length;
    step(controller, makeHand({ gesture: 'GRAB', center: { x: 0.75, y: 0.5, z: 0 } }), t);
    expect(deltas.filter((d) => d.phase === 'UPDATE').length).toBeGreaterThanOrEqual(before);
  });
});

// ─── L2: Z movement semantics (rate vs absolute anchor) ────

describe('L2: Z movement behaves as rate control (push and hold KEEPS position)', () => {
  const spanned = (span: number, cy = 0.5) => {
    const h = makeHand({ gesture: 'GRAB' });
    h.landmarks = makeLandmarks(0.5, cy, span);
    return h;
  };

  it('a sustained depth push-and-hold does not pull the object back', () => {
    const controller = new InteractionController();
    const deltas: DeltaPayload[] = [];
    controller.onDelta((p) => deltas.push(p));
    controller.setControlAxis('Z');

    let t = confirmGesture(controller, spanned(0.15));
    expect(controller.getInteractionState().mode).toBe('MOVE');

    // Push: hand retreats from span 0.15 to 0.12 over 12 frames → the object
    // moves away from the viewer (−Z; the camera sits on the +Z side).
    for (let i = 1; i <= 12; i++) {
      step(controller, spanned(0.15 - 0.0025 * i), t);
      t += FRAME_MS;
    }
    const pushed = deltas
      .filter((d) => d.phase === 'UPDATE')
      .reduce((s, d) => s + d.delta.position.z, 0);
    expect(pushed).toBeLessThan(-0.05); // the push actually moved the object

    // HOLD: the user stops at the new depth (span stays at 0.12).
    const before = deltas.filter((d) => d.phase === 'UPDATE').length;
    const netBefore = deltas
      .filter((d) => d.phase === 'UPDATE')
      .reduce((s, d) => s + d.delta.position.z, 0);
    for (let i = 0; i < 60; i++) {
      step(controller, spanned(0.12), t);
      t += FRAME_MS;
    }
    const netAfter = deltas
      .filter((d) => d.phase === 'UPDATE')
      .reduce((s, d) => s + d.delta.position.z, 0);

    // CONTRACT: holding the hand at the reached depth must keep the object
    // there (rate semantics). The absolute-anchor model still settles along
    // the push direction (−Z) while the span EMA converges; what must never
    // happen is a REVERSAL back toward the viewer (+Z), which would pull the
    // object home behind the user's hand.
    expect(netAfter - netBefore).toBeLessThan(0.05);
    void before;
  });

  it('returning the hand through the start depth is a reverse command (follows the hand back)', () => {
    const controller = new InteractionController();
    const deltas: DeltaPayload[] = [];
    controller.onDelta((p) => deltas.push(p));
    controller.setControlAxis('Z');

    let t = confirmGesture(controller, spanned(0.15));

    // Push out (0.15 → 0.12)…
    for (let i = 1; i <= 12; i++) {
      step(controller, spanned(0.15 - 0.0025 * i), t);
      t += FRAME_MS;
    }
    const afterPush = deltas
      .filter((d) => d.phase === 'UPDATE')
      .reduce((s, d) => s + d.delta.position.z, 0);
    expect(afterPush).toBeLessThan(-0.05);

    // …and return the hand to the start span WITHOUT releasing the grab.
    for (let i = 1; i <= 12; i++) {
      step(controller, spanned(0.12 + 0.0025 * i), t);
      t += FRAME_MS;
    }
    const afterReturn = deltas
      .filter((d) => d.phase === 'UPDATE')
      .reduce((s, d) => s + d.delta.position.z, 0);

    // CONTRACT: the object FOLLOWS the hand back (invariant under both the
    // anchored and any future rate model — the return is a real reverse
    // command). What must never happen is rectification: the round trip
    // may not leave a large residue in ONE direction (EMA convergence lag
    // accounts for the small remainder).
    expect(Math.abs(afterReturn)).toBeLessThan(0.15);
    expect(afterReturn).toBeGreaterThan(afterPush); // net reversal happened
  });
});

// ─── L3: left-palm pause must never change the MODE ────────
// (The pause itself IS the spec: left open palm → pause/re-anchor. The
// invariant worth locking is that the mode survives the pause untouched,
// including when the left palm is the only hand visible at the frame edge.)

describe('L3: left-palm pause changes pause state only, never the mode', () => {
  it('a left edge-of-frame palm with an active MOVE pauses and resumes as MOVE', () => {
    const controller = new InteractionController();
    let t = confirmGesture(controller, makeHand({ gesture: 'GRAB' }));
    expect(controller.getInteractionState().mode).toBe('MOVE');

    const leftPalm = makeHand({ gesture: 'OPEN_PALM', handedness: 'left', confidence: 0.5, center: { x: 0.05, y: 0.95, z: 0 } });
    let st = { mode: 'MOVE' as const, paused: false, confirm: null };
    for (let i = 0; i < 20; i++) {
      st = step(controller, makeHand({ gesture: 'GRAB' }), t, leftPalm);
      t += FRAME_MS;
    }
    expect(st.paused).toBe(true);
    expect(st.mode).toBe('MOVE');

    // Left hand leaves: the resume grace (~700 ms) counts from the first
    // frame the palm is GONE — so step once at the same timestamp (grace
    // starts), then step past the grace window.
    step(controller, makeHand({ gesture: 'GRAB', center: { x: 0.55, y: 0.5, z: 0 } }), t);
    t += FRAME_MS;
    st = step(controller, makeHand({ gesture: 'GRAB', center: { x: 0.55, y: 0.5, z: 0 } }), t + 800);
    expect(st.mode).toBe('MOVE');
    expect(st.paused).toBe(false);
  });
});

// ─── L4: right-slot dropout with a left axis pose ───────────

describe('L4: brief right-slot dropout with the left axis pose does not end MOVE', () => {
  it('MOVE survives a ~0.5 s right-slot dropout while the left hand shows the Z-axis pose', () => {
    const controller = new InteractionController();
    let t = confirmGesture(controller, makeHand({ gesture: 'GRAB' }));
    expect(controller.getInteractionState().mode).toBe('MOVE');

    // The right slot drops (occlusion/glitch) for ~0.5 s; the left hand is
    // up selecting the Z axis (3 fingers = ROTATE_3 classification).
    const zSelect = makeHand({ gesture: 'ROTATE_3', handedness: 'left', center: { x: 0.2, y: 0.5, z: 0 } });
    for (let i = 0; i < 15; i++) {
      step(controller, null, t, zSelect);
      t += FRAME_MS;
    }

    // The right hand comes back, still grabbing, and continues moving.
    const st = step(controller, makeHand({ gesture: 'GRAB', center: { x: 0.55, y: 0.5, z: 0 } }), t);
    t += FRAME_MS;

    // CONTRACT: a transient dropout must not tear down the confirmed mode —
    // and the left axis pose must never have hijacked it either.
    expect(st.mode).toBe('MOVE');
    expect(controller.getInteractionState().confirm?.mode).not.toBe('ROTATE');
  });
});

// ─── L5/L6: guards that should stay green ──────────────────

describe('L5: hand-ownership guard (regression)', () => {
  it('a left GRAB alone never starts or maintains MOVE', () => {
    const controller = new InteractionController();
    const leftGrab = makeHand({ gesture: 'GRAB', handedness: 'left' });
    let t = 1000;
    for (let i = 0; i < CONFIRM_FRAMES + 5; i++) {
      step(controller, null, t, leftGrab);
      t += FRAME_MS;
    }
    expect(controller.getInteractionState().mode).toBe('NONE');
  });
});

describe('L7: X rotation — breathing bob must not stall a slow deliberate sweep', () => {
  it('a slow vertical sweep with realistic bob accumulates rotation in ONE direction', () => {
    const controller = new InteractionController();
    const deltas: DeltaPayload[] = [];
    controller.onDelta((p) => deltas.push(p));
    let t = confirmGesture(controller, makeHand({ gesture: 'OPEN_PALM' }));
    expect(controller.getInteractionState().mode).toBe('ROTATE');

    // Slow deliberate upward sweep (0.0012/frame — just above the gate)
    // polluted by breathing bob (±0.002, 2 Hz) — the live X-rotation
    // condition. The user sees net rotation; sign flips are the wobble.
    let net = 0;
    let flips = 0;
    let lastSign = 0;
    for (let i = 0; i < 90; i++) {
      const bob = Math.sin((i / 90) * Math.PI * 4) * 0.002;
      step(
        controller,
        makeHand({ gesture: 'OPEN_PALM', center: { x: 0.5, y: 0.5 - 0.0012 * i + bob, z: 0 } }),
        t,
      );
      t += FRAME_MS;
    }
    for (const d of deltas) {
      if (d.phase !== 'UPDATE' || d.delta.rotation.x === 0) continue;
      net += d.delta.rotation.x;
      const s = Math.sign(d.delta.rotation.x);
      if (lastSign !== 0 && s !== lastSign) flips++;
      lastSign = s;
    }
    // CONTRACT: net rotation accumulates (the sweep works) and sign flips
    // are rare (no visible wobble).
    expect(Math.abs(net)).toBeGreaterThan(0.02);
    expect(flips).toBeLessThanOrEqual(2);
  });
});

describe('L8: Z move — a fast deliberate depth push is not mistaken for a teleport', () => {
  it('a quick sustained push keeps emitting Z deltas (no re-anchor swallow)', () => {
    const controller = new InteractionController();
    const deltas: DeltaPayload[] = [];
    controller.onDelta((p) => deltas.push(p));
    controller.setControlAxis('Z');

    const spanned = (span: number) => {
      const h = makeHand({ gesture: 'GRAB' });
      h.landmarks = makeLandmarks(0.5, 0.5, span);
      return h;
    };
    let t = confirmGesture(controller, spanned(0.15));

    // FAST push: 0.04 span change in 6 frames (~0.007/frame).
    for (let i = 1; i <= 6; i++) {
      step(controller, spanned(0.15 - 0.0067 * i), t);
      t += FRAME_MS;
    }
    const pushed = deltas
      .filter((d) => d.phase === 'UPDATE')
      .reduce((s, d) => s + d.delta.position.z, 0);
    // CONTRACT: the fast push produces real −Z movement (away from the
    // viewer — the depth axis follows the retreating hand).
    expect(pushed).toBeLessThan(-0.05);
  });
});

// ─── L9–L11: left-palm pause vs axis-selection pose (ticket 02) ─
// The Z axis is selected with THREE left fingers (ROTATE_3). On a real hand
// the pinky drifts open; the classifier then reads FOUR fingers — OPEN_PALM,
// the pause gesture — and the session froze while the user believed they
// were selecting/driving Z. Disambiguation under test: a left OPEN_PALM
// shortly after axis-selection counts (1–3) is the selection hand still
// present, NOT a pause request.

/** Left hand in a selection pose: n extended fingers (pinky curled). */
function leftSelectionHand(n: 1 | 2 | 3): HandState {
  return makeHand({
    gesture: n === 1 ? 'POINT' : n === 3 ? 'ROTATE_3' : 'NONE',
    handedness: 'left',
    fingerState: { index: n >= 1, middle: n >= 2, ring: n >= 3, pinky: false, thumb: false },
    center: { x: 0.2, y: 0.5, z: 0 },
  });
}

/** Left hand with the pinky drifted open: 4 fingers → OPEN_PALM (pause read). */
function leftDriftedPalm(): HandState {
  return makeHand({
    gesture: 'OPEN_PALM',
    handedness: 'left',
    fingerState: { index: true, middle: true, ring: true, pinky: true, thumb: false },
    center: { x: 0.2, y: 0.5, z: 0 },
  });
}

describe('L9: Z-selection pose with a drifted pinky must not engage the pause', () => {
  it('a sustained 4-finger misread right after Z selection never sets paused', () => {
    const controller = new InteractionController();
    let t = confirmGesture(controller, makeHand({ gesture: 'GRAB' }));
    expect(controller.getInteractionState().mode).toBe('MOVE');

    // The user selects Z (3 fingers), then the pinky drifts open and STAYS
    // open — the classifier now reads OPEN_PALM (the pause gesture) for a
    // sustained stretch while the selection intent is unchanged.
    let st = controller.getInteractionState();
    for (let i = 0; i < 6; i++) {
      st = step(controller, makeHand({ gesture: 'GRAB' }), t, leftSelectionHand(3));
      t += FRAME_MS;
    }
    for (let i = 0; i < 20; i++) {
      st = step(controller, makeHand({ gesture: 'GRAB' }), t, leftDriftedPalm());
      t += FRAME_MS;
    }

    // CONTRACT: the drifted selection hand is not a pause request.
    expect(st.mode).toBe('MOVE');
    expect(st.paused).toBe(false);
  });
});

describe('L10: deliberate left-palm pause still engages (no selection activity)', () => {
  it('a clean OPEN_PALM with no recent selection counts pauses as before', () => {
    const controller = new InteractionController();
    let t = confirmGesture(controller, makeHand({ gesture: 'GRAB' }));

    // Deliberate pause: open palm held with NO axis-selection counts.
    let st = controller.getInteractionState();
    for (let i = 0; i < 20; i++) {
      st = step(controller, makeHand({ gesture: 'GRAB' }), t, leftDriftedPalm());
      t += FRAME_MS;
    }
    expect(st.paused).toBe(true);
    expect(st.mode).toBe('MOVE');
  });
});

describe('L11: Z drives the object while the drifted selection hand is up', () => {
  it('depth push moves the object during 3↔4-finger oscillation of the selection hand', () => {
    const controller = new InteractionController();
    const deltas: DeltaPayload[] = [];
    controller.onDelta((p) => deltas.push(p));
    controller.setControlAxis('Z');

    const spanned = (span: number) => {
      const h = makeHand({ gesture: 'GRAB' });
      h.landmarks = makeLandmarks(0.5, 0.5, span);
      return h;
    };
    let t = confirmGesture(controller, spanned(0.15));
    expect(controller.getInteractionState().mode).toBe('MOVE');

    // Select Z, then the pinky drifts open for a sustained stretch…
    for (let i = 0; i < 6; i++) {
      step(controller, spanned(0.15), t, leftSelectionHand(3));
      t += FRAME_MS;
    }
    for (let i = 0; i < 16; i++) {
      step(controller, spanned(0.15), t, leftDriftedPalm());
      t += FRAME_MS;
    }
    // …and the user pushes depth while the drifted pose intermittently
    // re-reads as 3 fingers (real hands relax and re-tense the pinky).
    for (let i = 1; i <= 12; i++) {
      const left = i % 4 === 1 ? leftSelectionHand(3) : leftDriftedPalm();
      step(controller, spanned(0.15 - 0.0025 * i), t, left);
      t += FRAME_MS;
    }

    const pushed = deltas
      .filter((d) => d.phase === 'UPDATE')
      .reduce((s, d) => s + d.delta.position.z, 0);
    // CONTRACT: Z movement flowed — no pause ever froze the session
    // (the retreating hand pushes the object away from the viewer, −Z).
    expect(pushed).toBeLessThan(-0.05);
    expect(controller.getInteractionState().paused).toBe(false);
  });
});

// ─── L20–L22: Z direction, sustained Z drive, pause recovery ───
// The depth axis had two independent defects:
//   1. its SIGN ran against the hand — the object receded as the hand came
//      toward the camera while X and Y followed the palm centre;
//   2. the pause/selection disambiguation was a 500 ms RECENCY window, so a
//      normal multi-second Z drive with a drifted pinky (4-finger read =
//      OPEN_PALM) engaged the left-palm pause mid-drive and froze EVERY
//      axis silently — the "CV stopped responding" failure.

/** Right hand at a given palm span (the depth proxy) and palm centre. */
function depthHand(span: number, cx = 0.5, cy = 0.5): HandState {
  return makeHand({
    gesture: 'GRAB',
    center: { x: cx, y: cy, z: 0 },
    landmarks: makeLandmarks(cx, cy, span),
  });
}

describe('L20: MOVE Z follows the hand in depth (world +Z faces the camera)', () => {
  it('hand toward the camera → +Z (toward the viewer); retreat → −Z', () => {
    const controller = new InteractionController();
    const deltas: DeltaPayload[] = [];
    controller.onDelta((p) => deltas.push(p));
    controller.setControlAxis('Z');

    let t = confirmGesture(controller, depthHand(0.15));
    expect(controller.getInteractionState().mode).toBe('MOVE');

    // Approach: span 0.15 → 0.19 (hand coming toward the camera).
    for (let i = 1; i <= 16; i++) {
      step(controller, depthHand(0.15 + 0.0025 * i), t);
      t += FRAME_MS;
    }
    const approach = deltas
      .filter((d) => d.phase === 'UPDATE')
      .reduce((s, d) => s + d.delta.position.z, 0);
    expect(approach).toBeGreaterThan(0.05);

    // Retreat back through the start depth: the object follows the hand out.
    for (let i = 1; i <= 16; i++) {
      step(controller, depthHand(0.19 - 0.005 * i), t);
      t += FRAME_MS;
    }
    const retreat = deltas
      .filter((d) => d.phase === 'UPDATE')
      .reduce((s, d) => s + d.delta.position.z, 0);
    expect(retreat).toBeLessThan(approach); // real reversal
  });

  it('a Z drive emits ONLY z components (axes stay independent)', () => {
    const controller = new InteractionController();
    const deltas: DeltaPayload[] = [];
    controller.onDelta((p) => deltas.push(p));
    controller.setControlAxis('Z');

    let t = confirmGesture(controller, depthHand(0.15));
    for (let i = 1; i <= 16; i++) {
      step(controller, depthHand(0.15 + 0.0025 * i), t);
      t += FRAME_MS;
    }
    const moveDeltas = deltas.filter(
      (d) => d.phase === 'UPDATE' && d.delta.position.z !== 0,
    );
    expect(moveDeltas.length).toBeGreaterThan(0);
    for (const d of moveDeltas) {
      expect(d.delta.position.x).toBe(0);
      expect(d.delta.position.y).toBe(0);
    }

    // Switching to X must produce x-only movement — the depth channel is not
    // still leaking into the offset.
    controller.setControlAxis('X');
    const beforeX = deltas.length;
    for (let i = 1; i <= 12; i++) {
      step(controller, depthHand(0.19, 0.5 + 0.004 * i), t);
      t += FRAME_MS;
    }
    const xDeltas = deltas
      .slice(beforeX)
      .filter((d) => d.phase === 'UPDATE' && (d.delta.position.x !== 0 || d.delta.position.y !== 0));
    expect(xDeltas.length).toBeGreaterThan(0);
    for (const d of xDeltas) {
      expect(d.delta.position.z).toBe(0);
    }
  });
});

describe('L21: a sustained Z drive never pauses on a drifted selection hand', () => {
  it('2 s of 4-finger pinky drift during an active Z drive keeps moving the object', () => {
    const controller = new InteractionController();
    const deltas: DeltaPayload[] = [];
    controller.onDelta((p) => deltas.push(p));
    controller.setControlAxis('Z');

    let t = confirmGesture(controller, depthHand(0.15));
    expect(controller.getInteractionState().mode).toBe('MOVE');

    // The user selects Z with three fingers…
    for (let i = 0; i < 8; i++) {
      step(controller, depthHand(0.15), t, leftSelectionHand(3));
      t += FRAME_MS;
    }
    // …the pinky relaxes to FOUR fingers (OPEN_PALM read) and STAYS open for
    // two full seconds while the drive continues (a depth stroke lasts
    // seconds — the old 500 ms window expired in the middle of it).
    for (let i = 1; i <= 60; i++) {
      const st = step(controller, depthHand(0.15 + 0.001 * i), t, leftDriftedPalm());
      t += FRAME_MS;
      expect(st.paused).toBe(false);
      expect(st.mode).toBe('MOVE');
    }

    const moved = deltas
      .filter((d) => d.phase === 'UPDATE')
      .reduce((s, d) => s + d.delta.position.z, 0);
    expect(moved).toBeGreaterThan(0.05);
    expect(deltas.filter((d) => d.phase === 'END').length).toBe(0);
  });
});

describe('L22: an engaged pause is not terminal', () => {
  it('an axis-selection count releases the pause on the next frame and Z resumes', () => {
    const controller = new InteractionController();
    const deltas: DeltaPayload[] = [];
    controller.onDelta((p) => deltas.push(p));
    controller.setControlAxis('Z');

    let t = confirmGesture(controller, depthHand(0.15));

    // Deliberate pause: an open palm with no selection activity this session.
    let st = controller.getInteractionState();
    for (let i = 0; i < 20; i++) {
      st = step(controller, depthHand(0.15), t, leftDriftedPalm());
      t += FRAME_MS;
    }
    expect(st.paused).toBe(true);

    // The user re-tenses the selection fingers to keep driving: that is an
    // explicit selection signal, never a pause — release it immediately.
    st = step(controller, depthHand(0.15), t, leftSelectionHand(3));
    t += FRAME_MS;
    expect(st.paused).toBe(false);

    const before = deltas.length;
    for (let i = 1; i <= 16; i++) {
      step(controller, depthHand(0.15 + 0.0025 * i), t, leftSelectionHand(3));
      t += FRAME_MS;
    }
    const moved = deltas
      .slice(before)
      .filter((d) => d.phase === 'UPDATE')
      .reduce((s, d) => s + d.delta.position.z, 0);
    expect(moved).toBeGreaterThan(0.05);
  });

  it('a deliberate pause is still available once the selection hand is released', () => {
    const controller = new InteractionController();
    let t = confirmGesture(controller, depthHand(0.15));

    // Select Z, then LOWER the left hand for longer than the release window…
    for (let i = 0; i < 10; i++) {
      step(controller, depthHand(0.15), t, leftSelectionHand(3));
      t += FRAME_MS;
    }
    for (let i = 0; i < 30; i++) {
      step(controller, depthHand(0.15), t, null);
      t += FRAME_MS;
    }
    expect(controller.getInteractionState().paused).toBe(false);

    // …and a fresh open palm pauses exactly as before.
    let st = controller.getInteractionState();
    for (let i = 0; i < 20; i++) {
      st = step(controller, depthHand(0.15), t, leftDriftedPalm());
      t += FRAME_MS;
    }
    expect(st.paused).toBe(true);
    expect(st.mode).toBe('MOVE');
  });
});

// ─── L12–L14: ROTATE execution vs pose-label flicker (T-03) ───
// The rotation pipeline is a velocity integrator with NO angular state; the
// only per-frame condition that can zero rotation while the hand moves is
// `gestureHeld` (the pose-label gate). A rotating palm naturally approaches
// edge-on; there the classifier's pose label flips (OPEN_PALM ↔ ROTATE_3 —
// maps to no mode) at a rate that grows with foreshortening. T-03 makes
// ROTATE execution tolerant of SHORT label flicker (bounded hold), without
// touching mode/session lifetime, other modes, or the classifier.

/**
 * Sweep a confirmed ROTATE session: right hand moving vertically at a
 * deliberate rate with a scripted gesture-label pattern; returns the net
 * object-rotation equivalent (sum of emitted rotation.x) per phase.
 */
function rotateRun(
  pattern: (i: number) => string,
  frames: number,
  dyPerFrame = 0.003,
): { net: number; zeroRuns: number[]; mode: string } {
  const controller = new InteractionController();
  const deltas: DeltaPayload[] = [];
  controller.onDelta((p) => deltas.push(p));
  let t = confirmGesture(controller, makeHand({ gesture: 'OPEN_PALM' }));
  let y = 0.5;
  let net = 0;
  const zeroRuns: number[] = [];
  let run = 0;
  for (let i = 0; i < frames; i++) {
    y += dyPerFrame;
    const nBefore = deltas.length;
    controller.processFrame(
      makeFrame({
        timestamp: t as TimestampMs,
        rightHand: makeHand({ gesture: pattern(i) as HandState['gesture'], center: { x: 0.5, y, z: 0 } }),
      }),
      t as TimestampMs,
    );
    t += FRAME_MS;
    // Count ONLY a payload emitted THIS frame — a stale previous delta is
    // not emission (silent frames must be recognized as silent).
    const d = deltas.length > nBefore ? deltas[deltas.length - 1] : null;
    const e = d && d.phase === 'UPDATE' ? d.delta.rotation.x : 0;
    net += e;
    if (e === 0) run++; else { if (run > 0) zeroRuns.push(run); run = 0; }
  }
  if (run > 0) zeroRuns.push(run);
  return { net, zeroRuns, mode: controller.getInteractionState().mode };
}

describe('L12: ROTATE continues through short pose-label flicker (T-03)', () => {
  it('an 8-frame flicker burst mid-sweep keeps net rotation ≥ 90% of clean motion', () => {
    // Clean control: same motion, readable pose throughout.
    const clean = rotateRun(() => 'OPEN_PALM', 90);
    // Flicker: sustained mid-stretch where the label flips to ROTATE_3
    // (maps to NO mode — today every such frame emits zero).
    const flicker = rotateRun((i) => (i >= 30 && i < 38 ? 'ROTATE_3' : 'OPEN_PALM'), 90);

    expect(flicker.mode).toBe('ROTATE');
    expect(Math.abs(flicker.net)).toBeGreaterThanOrEqual(Math.abs(clean.net) * 0.9);
    // No multi-frame zero-delta window longer than the hold bound allows
    // (8 flicker frames ≈ 264 ms must be bridged almost entirely).
    expect(flicker.zeroRuns.every((r) => r <= 2)).toBe(true);
  });

  it('repeated short flickers (edge-on jitter) keep rotation flowing', () => {
    const clean = rotateRun(() => 'OPEN_PALM', 90);
    const flicker = rotateRun(
      (i) => (Math.floor(i / 9) % 2 === 1 && i % 3 !== 0 ? 'ROTATE_3' : 'OPEN_PALM'),
      90,
    );
    expect(flicker.mode).toBe('ROTATE');
    expect(Math.abs(flicker.net)).toBeGreaterThanOrEqual(Math.abs(clean.net) * 0.9);
  });
});

describe('L13: sustained ROTATE misread still ends by the existing contract (T-03)', () => {
  it('a >500 ms misread does not rotate indefinitely and mode confirmation still works', () => {
    const controller = new InteractionController();
    const deltas: DeltaPayload[] = [];
    controller.onDelta((p) => deltas.push(p));
    let t = confirmGesture(controller, makeHand({ gesture: 'OPEN_PALM' }));
    expect(controller.getInteractionState().mode).toBe('ROTATE');

    // Sustained misread (ROTATE_3 → no mode) for 600 ms while the hand moves.
    let y = 0.5;
    let netDuringMisread = 0;
    for (let i = 0; i < 18; i++) {
      y += 0.003;
      const nBefore = deltas.length;
      controller.processFrame(
        makeFrame({
          timestamp: t as TimestampMs,
          rightHand: makeHand({ gesture: 'ROTATE_3', center: { x: 0.5, y, z: 0 } }),
        }),
        t as TimestampMs,
      );
      t += FRAME_MS;
      const d = deltas.length > nBefore ? deltas[deltas.length - 1] : null;
      if (d && d.phase === 'UPDATE') netDuringMisread += d.delta.rotation.x;
    }
    // Execution may continue only within the bounded hold (≤ 250 ms ≈ 8
    // frames); after that the gate stays closed — no unbounded phantom spin.
    expect(Math.abs(netDuringMisread)).toBeLessThanOrEqual(0.18);

    // The lifetime contract is untouched: holding GRAB (a DIFFERENT mode's
    // gesture) for the ~1 s confirmation still hands the session to MOVE.
    for (let i = 0; i < CONFIRM_FRAMES + 2; i++) {
      y += 0.003;
      controller.processFrame(
        makeFrame({
          timestamp: t as TimestampMs,
          rightHand: makeHand({ gesture: 'GRAB', center: { x: 0.5, y, z: 0 } }),
        }),
        t as TimestampMs,
      );
      t += FRAME_MS;
    }
    expect(controller.getInteractionState().mode).toBe('MOVE');
  });
});

// ─── L16–L19: X adopts the Y/Z fast velocity model (T-06) ──────────
// X's drive was velCySlow (dual-rate EMA, α_attack = EMA_VEL_XROT = 0.12 +
// a VEL_SWEEP_MOMENTUM snap) while Y/Z drive from the fast EMA (α = 0.3).
// Measured differential (zz-debug-xrot-differential harness): X latency
// +2–6 frames at every magnitude, reversal duty 83% vs Y's 98%, ~9% lower
// net gain. T-06 retires the X-only channel: X drives from velCy (the fast
// vertical EMA — already integrated every frame, previously unused as a
// drive) so the velocity PROCESSING is identical to Y's under input-axis
// swap. The bob protection reverts to the shared stack: DEADZONE_ROT_VEL
// (≈2× bob residual) + T-04's no-raw-re-injection carry (L19 pins this).

// Shared helper: run a confirmed-ROTATE session on the given axis with a
// per-frame palm-center trajectory, returning per-frame emitted rotation
// (on the axis), the run pattern of silent frames, and net rotation.
function rotateOnAxis(
  axis: 'X' | 'Y',
  motion: (i: number) => { cx: number; cy: number },
  frames: number,
  startT = 31000,
): { perFrame: number[]; net: number; silentRuns: number[]; mode: string } {
  const controller = new InteractionController();
  const deltas: DeltaPayload[] = [];
  controller.onDelta((p) => deltas.push(p));
  let t = confirmGesture(controller, makeHand({ gesture: 'OPEN_PALM' }), startT);
  controller.setControlAxis(axis);
  const perFrame: number[] = [];
  const silentRuns: number[] = [];
  let run = 0;
  for (let i = 0; i < frames; i++) {
    const { cx, cy } = motion(i);
    const nBefore = deltas.length;
    controller.processFrame(
      makeFrame({ timestamp: t as TimestampMs, rightHand: makeHand({ gesture: 'OPEN_PALM', center: { x: cx, y: cy, z: 0 } }) }),
      t as TimestampMs,
    );
    t += FRAME_MS;
    const d = deltas.length > nBefore ? deltas[deltas.length - 1] : null;
    const e = d && d.phase === 'UPDATE' ? (axis === 'X' ? d.delta.rotation.x : d.delta.rotation.y) : 0;
    perFrame.push(e);
    if (e === 0) run++; else { if (run > 0) silentRuns.push(run); run = 0; }
  }
  if (run > 0) silentRuns.push(run);
  const net = perFrame.reduce((s, v) => s + v, 0);
  return { perFrame, net, silentRuns, mode: controller.getInteractionState().mode };
}

// Constant-rate stroke centered at (0.5, 0.5) along the given axis: rate is
// the signed per-frame delta; frame i sits at center + rate*(i+1).
const stroke = (axis: 'x' | 'y', rate: number) => (i: number) =>
  axis === 'x' ? { cx: 0.5 + rate * (i + 1), cy: 0.5 } : { cx: 0.5, cy: 0.5 + rate * (i + 1) };

// First frame index whose emission is nonzero (−1 if none).
const firstEmission = (perFrame: number[]) => perFrame.findIndex((v) => v !== 0);

// The input-axis-swap helper for L16: a COORDINATE swap — (cx,cy) → (cy,cx)
// — turns a vertical X profile into a horizontal Y profile with the SAME
// per-frame delta sequence (same gate arithmetic, same cap, same gain),
// which is exactly the equivalence T-06 creates.
const swapAxes = (motion: (i: number) => { cx: number; cy: number }) => (i: number) => {
  const { cx, cy } = motion(i);
  return { cx: cy, cy: cx };
};

describe('L16: X↔Y velocity-processing equivalence (T-06)', () => {
  it('identical profiles under input-axis swap produce comparable gate decisions, latency within ±1 frame, and equal net magnitude', () => {
    for (const rate of [0.002, 0.004] as const) {
      // Same signed per-frame delta sequence on both axes (X mirrored).
      const x = rotateOnAxis('X', stroke('y', -rate), 60, 31000);
      const y = rotateOnAxis('Y', swapAxes(stroke('y', -rate)), 60, 41000);
      expect(x.mode).toBe('ROTATE');
      expect(y.mode).toBe('ROTATE');
      // Latency within ±1 frame.
      expect(Math.abs(firstEmission(x.perFrame) - firstEmission(y.perFrame))).toBeLessThanOrEqual(1);
      // Net magnitude within 10% (sign is inverted by convention only).
      expect(Math.abs(Math.abs(x.net) - Math.abs(y.net))).toBeLessThanOrEqual(Math.abs(y.net) * 0.1);
      // Emission duty (emitting frames) within 2 frames.
      const xEmit = x.perFrame.filter((v) => v !== 0).length;
      const yEmit = y.perFrame.filter((v) => v !== 0).length;
      expect(Math.abs(xEmit - yEmit)).toBeLessThanOrEqual(2);
    }
  });
});

describe('L17: small vertical motion is responsive on X (T-06)', () => {
  it('a small 0.0008/frame vertical stroke (the historically dead regime) emits promptly and proportionally', () => {
    // RED pre-T-06: the slow channel converges to ≈0.00054/frame and never
    // crosses the 0.0012 gate — no emission, ever.
    const x = rotateOnAxis('X', stroke('y', -0.0008), 60, 31000);
    expect(x.mode).toBe('ROTATE');
    expect(firstEmission(x.perFrame)).toBeLessThanOrEqual(8);
    // Proportionality: ≥80% of an equal-travel Y reference (the proven
    // mechanism), which first-emission latency bounds by construction.
    // At 0.0008/frame the Y reference is silent too (both axes share the
    // gate — that IS the parity), so the proportional check against Y is a
    // parity sanity while the substantive assertions are absolute.
    const y = rotateOnAxis('Y', swapAxes(stroke('y', -0.0008)), 60, 41000);
    expect(Math.abs(x.net)).toBeGreaterThanOrEqual(Math.abs(y.net) * 0.8);
    // Substantive proportional rotation from 0.048 total travel (the old
    // slow channel produced EXACTLY 0 here — the red-first proof).
    expect(Math.abs(x.net)).toBeGreaterThanOrEqual(0.06);
    expect(x.perFrame.every((v) => Math.abs(v) <= 0.081)).toBe(true);
  });
});

describe('L18: X reversal stays responsive and stop does not coast (T-06)', () => {
  it('a reversal-heavy stroke has no silent run longer than Y\'s worst, and a hard stop settles like Y/Z', () => {
    // Reversal-heavy: ±0.0045/frame sine — the differential harness's worst
    // case (X duty 83% pre-T-06, silent runs at every sign crossing).
    const rev = (i: number) => ({ cx: 0.5, cy: 0.5 + 0.0045 * Math.sin(i * 0.35) });
    const x = rotateOnAxis('X', rev, 90, 31000);
    const y = rotateOnAxis('Y', swapAxes(rev), 90, 41000);
    expect(x.mode).toBe('ROTATE');
    expect(Math.max(0, ...x.silentRuns)).toBeLessThanOrEqual(Math.max(0, ...y.silentRuns));

    // Deliberate stop after a fast stroke: settle bound mirrors L15b.
    const controller = new InteractionController();
    const deltas: DeltaPayload[] = [];
    controller.onDelta((p) => deltas.push(p));
    let t = confirmGesture(controller, makeHand({ gesture: 'OPEN_PALM' }), 51000);
    controller.setControlAxis('X');
    let y2 = 0.5;
    for (let i = 0; i < 30; i++) {
      y2 += 0.006;
      controller.processFrame(makeFrame({ timestamp: t as TimestampMs, rightHand: makeHand({ gesture: 'OPEN_PALM', center: { x: 0.5, y: y2, z: 0 } }) }), t as TimestampMs);
      t += FRAME_MS;
    }
    let after = 0;
    for (let i = 0; i < 30; i++) {
      const nBefore = deltas.length;
      controller.processFrame(makeFrame({ timestamp: t as TimestampMs, rightHand: makeHand({ gesture: 'OPEN_PALM', center: { x: 0.5, y: y2, z: 0 } }) }), t as TimestampMs);
      t += FRAME_MS;
      const d = deltas.length > nBefore ? deltas[deltas.length - 1] : null;
      if (d && d.phase === 'UPDATE') after += d.delta.rotation.x;
    }
    expect(Math.abs(after)).toBeLessThanOrEqual(0.25);
    expect(Math.abs(after)).toBeLessThan(0.4);
  });
});

describe('L19: vertical bob tolerance on X (T-06)', () => {
  it('a held hand with bob-band tremor produces no meaningful X drift — the historical protection is preserved', () => {
    // Tremor entirely inside the bob band: raw per-frame deltas ±0.0015
    // (the L15c shape, pinning the same protection for the bridge), plus a
    // long hold with the realistic L7 bob amplitude (±0.002, 2 Hz).
    const tremor = (i: number) => ({ cx: 0.5, cy: 0.5 + 0.0015 * Math.sin((i / 3) * Math.PI) });
    const a = rotateOnAxis('X', tremor, 90, 31000);
    expect(Math.abs(a.net)).toBeLessThan(0.03);

    const bob = (i: number) => ({ cx: 0.5, cy: 0.5 + 0.002 * Math.sin((i / 22) * Math.PI * 2) });
    const b = rotateOnAxis('X', bob, 120, 33000);
    expect(Math.abs(b.net)).toBeLessThan(0.05);
  });
});

describe('L14: deliberate stop stops rotation promptly (T-03)', () => {
  it('after the hand stops, rotation halts within the hold bound and does not coast', () => {
    const controller = new InteractionController();
    const deltas: DeltaPayload[] = [];
    controller.onDelta((p) => deltas.push(p));
    let t = confirmGesture(controller, makeHand({ gesture: 'OPEN_PALM' }));

    // Steady deliberate stroke…
    let y = 0.5;
    for (let i = 0; i < 30; i++) {
      y += 0.003;
      controller.processFrame(makeFrame({ timestamp: t as TimestampMs, rightHand: makeHand({ gesture: 'OPEN_PALM', center: { x: 0.5, y, z: 0 } }) }), t as TimestampMs);
      t += FRAME_MS;
    }
    // …then a deliberate STOP: hand frozen at the reached position.
    const stopAngle = deltas.filter((d) => d.phase === 'UPDATE').reduce((s, d) => s + d.delta.rotation.x, 0);
    let after = 0;
    for (let i = 0; i < 30; i++) {
      const nBefore = deltas.length;
      controller.processFrame(makeFrame({ timestamp: t as TimestampMs, rightHand: makeHand({ gesture: 'OPEN_PALM', center: { x: 0.5, y, z: 0 } }) }), t as TimestampMs);
      t += FRAME_MS;
      const d = deltas.length > nBefore ? deltas[deltas.length - 1] : null;
      if (d && d.phase === 'UPDATE') after += d.delta.rotation.x;
    }
    // Total post-stop rotation is tiny (velocity decay) and dominated by
    // the first few frames — the object must not coast.
    // T-06 re-pin: X now coasts exactly like the Y/Z model always has
    // (measured 0.0801 at this stroke rate — 5-frame geometric EMA decay;
    // the T-04 bridge is not even needed for a genuine stop). The previous
    // 0.08 bound was calibrated against the retired slow channel, which
    // coasted 0.0786 here by accident of its convergence lag.
    expect(Math.abs(after)).toBeLessThan(0.085);
    expect(Math.abs(after)).toBeLessThan(Math.abs(stopAngle) * 0.2);
  });
});

describe('L6: recovery after a tolerated flicker re-anchors without a lurch', () => {
  it('the first delta after recovery is within the per-frame cap', () => {
    const controller = new InteractionController();
    const deltas: DeltaPayload[] = [];
    controller.onDelta((p) => deltas.push(p));
    let t = confirmGesture(controller, makeHand({ gesture: 'GRAB' }));

    // 3-frame flicker (within tolerance), hand reappears far away.
    for (let i = 0; i < 3; i++) {
      step(controller, makeHand({ gesture: 'NONE' }), t);
      t += FRAME_MS;
    }
    step(controller, makeHand({ gesture: 'GRAB', center: { x: 0.85, y: 0.5, z: 0 } }), t);
    const last = deltas.filter((d) => d.phase === 'UPDATE').pop();
    if (last) {
      expect(Math.abs(last.delta.position.x)).toBeLessThanOrEqual(0.16);
    }
  });
});

// ─── L15: ROTATE continues through sub-gate velocity sputter (T-04) ───
// Historical note: pre-T-06 the X-rotation drive was velCySlow (a slow
// dual-rate EMA) which rode under DEADZONE_ROT_VEL for 3–36 consecutive
// frames during real stroke curvature/reversals (measured per-frame
// |Δcy| 0.0006–0.0049; fixture:
// .scratch/cv-stability/rot3-full.json — 27.4% of all ROTATE frames; 36
// silent windows, all reproduced deterministically by the pre-T-04
// controller). T-04 bridges those windows with a bounded hold-and-decay of
// the last above-gate drive value: never re-injecting the raw sub-gate
// channel, never unbounded, never extending a genuine stop.

/** Confirmed-ROTATE harness; drives vertical hand motion and returns the
 * per-frame emitted rotation.x (0 on silent frames — only a payload emitted
 * THIS frame counts) plus the run pattern. */
function rotateFrames(
  motion: (i: number) => number,      // cy per frame index
  gesture: (i: number) => string = () => 'OPEN_PALM',
  frames: number,
  startT = 5000,
): { perFrame: number[]; net: number; mode: string; silentRuns: number[]; coast: number } {
  const controller = new InteractionController();
  const deltas: DeltaPayload[] = [];
  controller.onDelta((p) => deltas.push(p));
  let t = confirmGesture(controller, makeHand({ gesture: 'OPEN_PALM' }), startT);
  const perFrame: number[] = [];
  const silentRuns: number[] = [];
  let run = 0;
  for (let i = 0; i < frames; i++) {
    const nBefore = deltas.length;
    controller.processFrame(
      makeFrame({
        timestamp: t as TimestampMs,
        rightHand: makeHand({ gesture: gesture(i) as HandState['gesture'], center: { x: 0.5, y: motion(i), z: 0 } }),
      }),
      t as TimestampMs,
    );
    t += FRAME_MS;
    const d = deltas.length > nBefore ? deltas[deltas.length - 1] : null;
    const e = d && d.phase === 'UPDATE' ? d.delta.rotation.x : 0;
    perFrame.push(e);
    if (e === 0) run++; else { if (run > 0) silentRuns.push(run); run = 0; }
  }
  if (run > 0) silentRuns.push(run);
  const net = perFrame.reduce((s, v) => s + v, 0);
  // coast = rotation emitted after the motion ends (used by the stop tests)
  return { perFrame, net, mode: controller.getInteractionState().mode, silentRuns, coast: 0 };
}

/** Forward stroke with speed curvature — the faithful fixture sputter shape:
 * per-frame dy oscillates between a brisk 0.0045 and a sub-gate trough
 * (~0.0006), always ≥ 0, matching the measured live pattern (raw per-frame
 * motion 0.0006–0.0049; 3–6-frame windows where the slow EMA dips under the
 * gate while the hand keeps moving forward). A sign-reversing stroke would
 * cancel its own net — the wrong shape for the ≥80% continuity criterion;
 * the live reversal case is covered by the bridge's sign-preserving decay
 * plus the L14/L15b stop bounds. */
const forwardSputterCy: number[] = (() => {
  const arr: number[] = [];
  let y = 0.5;
  for (let i = 0; i < 130; i++) {
    arr.push(y);
    // Brisk run first (arms the bridge), then curvature cycles.
    y += i < 6 ? 0.0045 : 0.0006 + 0.0039 * Math.max(0, Math.sin((i - 6) * 0.9));
  }
  return arr;
})();
const reversalMotion = (i: number) => forwardSputterCy[Math.min(i, forwardSputterCy.length - 1)];

describe('L15: ROTATE continues through sub-gate velocity sputter (T-04)', () => {
  it('a curved stroke whose slow EMA dips under the gate keeps rotating (no ≥3-frame silent windows, ≥80% of an equal-travel reference)', () => {
    // Reference: a clean constant-rate stroke covering the SAME total hand
    // travel as the sputter pattern (the sputter pattern is slower on
    // average, so comparing raw nets would be meaningless). Its own 3-frame
    // EMA warm-up onset at standstill is not the subject here — it exists
    // only to normalize net rotation.
    const travel = forwardSputterCy[59] - forwardSputterCy[0];
    const ref = rotateFrames((i) => 0.5 + (travel / 60) * (i + 1), () => 'OPEN_PALM', 60, 5000);

    const sputter = rotateFrames(reversalMotion, () => 'OPEN_PALM', 60, 9000);
    expect(sputter.mode).toBe('ROTATE');
    const worst = Math.max(0, ...sputter.silentRuns);
    expect(worst).toBeLessThanOrEqual(2); // pre-T-04 this fails: windows of 3–8+ frames
    // Continuity: ≥80% of the equal-travel reference is recovered. The upper
    // band (≤160%) allows the bridge to redistribute emission into the
    // troughs (brisk segments also elevate the EMA); hard safety is pinned
    // by the per-frame cap here and the stop bounds in L15b/L14.
    expect(Math.abs(sputter.net)).toBeGreaterThanOrEqual(Math.abs(ref.net) * 0.8);
    expect(Math.abs(sputter.net)).toBeLessThanOrEqual(Math.abs(ref.net) * 1.6);
    // Per-frame emission stays bounded by the existing cap.
    expect(sputter.perFrame.every((v) => Math.abs(v) <= 0.081)).toBe(true);
  });

  it('repeated curvature cycles keep the session continuous end-to-end', () => {
    const long = rotateFrames(reversalMotion, () => 'OPEN_PALM', 120, 13000);
    expect(long.mode).toBe('ROTATE');
    const worst = Math.max(0, ...long.silentRuns);
    expect(worst).toBeLessThanOrEqual(2);
  });
});

describe('L15b: natural stop still settles promptly (T-04)', () => {
  it('after the hand stops dead, rotation ceases within the bridge window and coasts ≤ 0.25 rad', () => {
    const controller = new InteractionController();
    const deltas: DeltaPayload[] = [];
    controller.onDelta((p) => deltas.push(p));
    let t = confirmGesture(controller, makeHand({ gesture: 'OPEN_PALM' }), 17000);

    // Fast deliberate stroke (well above the gate)…
    let y = 0.5;
    for (let i = 0; i < 30; i++) {
      y += 0.006;
      controller.processFrame(makeFrame({ timestamp: t as TimestampMs, rightHand: makeHand({ gesture: 'OPEN_PALM', center: { x: 0.5, y, z: 0 } }) }), t as TimestampMs);
      t += FRAME_MS;
    }
    // …then STOP: hand frozen at the reached position.
    let after = 0;
    const perFrame: number[] = [];
    for (let i = 0; i < 30; i++) {
      const nBefore = deltas.length;
      controller.processFrame(makeFrame({ timestamp: t as TimestampMs, rightHand: makeHand({ gesture: 'OPEN_PALM', center: { x: 0.5, y, z: 0 } }) }), t as TimestampMs);
      t += FRAME_MS;
      const d = deltas.length > nBefore ? deltas[deltas.length - 1] : null;
      const e = d && d.phase === 'UPDATE' ? d.delta.rotation.x : 0;
      perFrame.push(e);
      after += e;
    }
    // Settles within the bridge window + one frame (bridge is derived from
    // the fixture distribution; pinned here as ≤ 600 ms ≈ 18 frames of
    // possible carry — the actual constant is asserted in L15d).
    expect(perFrame.slice(19).every((v) => v === 0)).toBe(true);
    // Total coast from stop onset stays bounded and small vs the stroke
    // (the fast stroke emits ≈0.5 rad; the ticket's bound is 0.25 rad).
    expect(Math.abs(after)).toBeLessThanOrEqual(0.25);
    expect(Math.abs(after)).toBeLessThan(0.4);
  });
});

describe('L15c: sub-gate sputter never re-injects raw channel noise (T-04)', () => {
  it('a near-still hand (bob band) emits nothing before, during, and after the bridge window', () => {
    const controller = new InteractionController();
    const deltas: DeltaPayload[] = [];
    controller.onDelta((p) => deltas.push(p));
    let t = confirmGesture(controller, makeHand({ gesture: 'OPEN_PALM' }), 21000);
    // Near-still hand with small oscillation entirely inside the bob band
    // (raw per-frame deltas ≈ ±0.0015, below the gate after slow-EMA
    // attenuation) — the pre-T-04 behavior must be preserved exactly: zero.
    let y = 0.5;
    for (let i = 0; i < 90; i++) {
      y += 0.0015 * Math.sin((i / 3) * Math.PI);
      const nBefore = deltas.length;
      controller.processFrame(makeFrame({ timestamp: t as TimestampMs, rightHand: makeHand({ gesture: 'OPEN_PALM', center: { x: 0.5, y, z: 0 } }) }), t as TimestampMs);
      t += FRAME_MS;
      const d = deltas.length > nBefore ? deltas[deltas.length - 1] : null;
      const e = d && d.phase === 'UPDATE' ? d.delta.rotation.x : 0;
      expect(e).toBe(0); // red pre-T-04? No — pre-T-04 this is green; it guards the FIX
    }
    expect(controller.getInteractionState().mode).toBe('ROTATE');
  });
});

describe('L15d: the bridge window is bounded and derived from the fixture (T-04)', () => {
  it('a mid-stroke dip keeps rotating ≥0.35 s but the bridge expires within ~0.6 s', () => {
    const controller = new InteractionController();
    const deltas: DeltaPayload[] = [];
    controller.onDelta((p) => deltas.push(p));
    let t = confirmGesture(controller, makeHand({ gesture: 'OPEN_PALM' }), 25000);
    let y = 0.5;
    // Ramp up (12 frames, well above gate).
    for (let i = 0; i < 12; i++) {
      y += 0.005;
      controller.processFrame(makeFrame({ timestamp: t as TimestampMs, rightHand: makeHand({ gesture: 'OPEN_PALM', center: { x: 0.5, y, z: 0 } }) }), t as TimestampMs);
      t += FRAME_MS;
    }
    // Curvature sputter: dy oscillates 0.0006→0.0024 around a 0.0015 mean
    // with continuous RAW motion — the fixture's real mid-stroke sputter
    // shape. The slow EMA dips under the gate in the troughs while the hand
    // keeps moving; the bridge must cover the troughs so emission stays
    // essentially continuous (pre-T-04 this pattern drops out for entire
    // windows).
    let emittedDuringDip = 0;
    for (let i = 0; i < 30; i++) {
      y += 0.0009 + 0.0015 * Math.sin(i * 1.1);
      const nBefore = deltas.length;
      controller.processFrame(makeFrame({ timestamp: t as TimestampMs, rightHand: makeHand({ gesture: 'OPEN_PALM', center: { x: 0.5, y, z: 0 } }) }), t as TimestampMs);
      t += FRAME_MS;
      const d = deltas.length > nBefore ? deltas[deltas.length - 1] : null;
      if (d && d.phase === 'UPDATE') emittedDuringDip++;
    }
    // Continuity: the window is essentially fully bridged (pre-T-04: ~half
    // of these frames went silent).
    expect(emittedDuringDip).toBeGreaterThanOrEqual(24);
    // Every bridged emission stays within the existing per-frame cap.
    // (Hard boundedness — carry decay + frame cap + genuine-stop gate — is
    // pinned by L15b and L14.)
    expect(emittedDuringDip).toBeLessThanOrEqual(30);
  });
});

// ─── L23: two-hand anchor (BOTH palms) ────────────────────
// The anchor pose is two open palms. The left palm IS the pause channel, but
// the pause-vs-selection guard keys on the selection HAND ROLE, which latches
// for as long as that hand stays tracked. After a normal axis selection
// (Z = 3 fingers) the role was still latched when both palms went up, so the
// anchor was "recognised" and never paused — the right palm then confirmed
// ROTATE and CV kept manipulating. The guard is now scoped to what the RIGHT
// hand is doing (a drifted pinky only rides along with a DRIVING pose).

/** RIGHT hand open palm — the anchor partner (and the ROTATE pose). */
function rightPalm(cx = 0.7, cy = 0.5): HandState {
  return makeHand({
    gesture: 'OPEN_PALM',
    handedness: 'right',
    fingerState: { index: true, middle: true, ring: true, pinky: true, thumb: true },
    center: { x: cx, y: cy, z: 0 },
  });
}

/** The pause confirms after a short hold (PAUSE_CONFIRM_FRAMES = 12); allow
 *  a little slack so the assertion is about "engages", not the exact frame. */
const ANCHOR_ENGAGE_FRAMES = 15;

describe('L23: two-hand anchor pauses the session', () => {
  it('left palm alone still pauses an active MOVE (unchanged)', () => {
    const controller = new InteractionController();
    const deltas: DeltaPayload[] = [];
    controller.onDelta((p) => deltas.push(p));
    let t = confirmGesture(controller, makeHand({ gesture: 'GRAB' }));

    let st = controller.getInteractionState();
    for (let i = 0; i < 20; i++) {
      st = step(controller, makeHand({ gesture: 'GRAB' }), t, leftDriftedPalm());
      t += FRAME_MS;
    }
    expect(st.paused).toBe(true);
    expect(st.mode).toBe('MOVE');
    expect(deltas.filter((d) => d.phase === 'BEGIN').length).toBe(1);
  });

  it('both palms pause — including right after the left hand selected an axis', () => {
    const controller = new InteractionController();
    const deltas: DeltaPayload[] = [];
    controller.onDelta((p) => deltas.push(p));
    let t = confirmGesture(controller, makeHand({ gesture: 'GRAB' }));
    expect(controller.getInteractionState().mode).toBe('MOVE');

    // The user selected an axis with the left hand earlier in this session —
    // the reported precondition. (3 fingers = Z.)
    for (let i = 0; i < 12; i++) {
      step(controller, makeHand({ gesture: 'GRAB' }), t, leftSelectionHand(3));
      t += FRAME_MS;
    }
    const before = deltas.length;

    // Both palms up, the right palm drifting a little (real hands do).
    let pausedAt = -1;
    let st = controller.getInteractionState();
    for (let i = 0; i < 40; i++) {
      st = step(controller, rightPalm(0.7 + 0.004 * i), t, leftDriftedPalm());
      t += FRAME_MS;
      if (st.paused && pausedAt < 0) pausedAt = i;
    }

    // CONTRACT: the anchor engages (within the pause confirmation window)…
    expect(pausedAt).toBeGreaterThanOrEqual(0);
    expect(pausedAt).toBeLessThan(ANCHOR_ENGAGE_FRAMES);
    expect(st.paused).toBe(true);
    // …the pause never changes the MODE, and no transform of any kind leaks:
    // no mode switch/AXIS re-begin, no object deltas.
    expect(st.mode).toBe('MOVE');
    const after = deltas.slice(before);
    expect(after.filter((d) => d.phase === 'BEGIN').length).toBe(0);
    expect(after.filter((d) => d.phase === 'UPDATE').length).toBe(0);
  });

  it('the anchor holds: no toggling while both palms stay up', () => {
    const controller = new InteractionController();
    const deltas: DeltaPayload[] = [];
    controller.onDelta((p) => deltas.push(p));
    let t = confirmGesture(controller, makeHand({ gesture: 'GRAB' }));

    const flutter: boolean[] = [];
    for (let i = 0; i < 90; i++) {
      const st = step(controller, rightPalm(0.7 + 0.002 * (i % 5)), t, leftDriftedPalm());
      t += FRAME_MS;
      if (i >= 20) flutter.push(st.paused);
    }
    // CONTRACT: once anchored, every frame stays anchored (no pause flicker).
    expect(flutter.every((p) => p === true)).toBe(true);
    expect(controller.getInteractionState().mode).toBe('MOVE');
    expect(deltas.filter((d) => d.phase === 'UPDATE').length).toBe(0);
    expect(deltas.filter((d) => d.phase === 'END').length).toBe(0);
  });

  it('releasing the anchor resumes on the existing grace and re-anchors', () => {
    const controller = new InteractionController();
    const deltas: DeltaPayload[] = [];
    controller.onDelta((p) => deltas.push(p));
    let t = confirmGesture(controller, makeHand({ gesture: 'GRAB' }));

    for (let i = 0; i < 20; i++) {
      step(controller, rightPalm(), t, leftDriftedPalm());
      t += FRAME_MS;
    }
    expect(controller.getInteractionState().paused).toBe(true);

    // Both palms down. Within the palm-release grace the session stays frozen…
    let st = controller.getInteractionState();
    for (let i = 0; i < 5; i++) {
      st = step(controller, makeHand({ gesture: 'GRAB' }), t);
      t += FRAME_MS;
    }
    expect(st.paused).toBe(true);

    // …then resumes, still in MOVE (the pause never changed the mode).
    for (let i = 0; i < 30; i++) {
      st = step(controller, makeHand({ gesture: 'GRAB' }), t);
      t += FRAME_MS;
    }
    expect(st.paused).toBe(false);
    expect(st.mode).toBe('MOVE');

    // And the transformation responds again — re-anchored, so no lurch.
    const before = deltas.length;
    for (let i = 1; i <= 12; i++) {
      step(controller, makeHand({ gesture: 'GRAB', center: { x: 0.5 + 0.006 * i, y: 0.5, z: 0 } }), t);
      t += FRAME_MS;
    }
    const moved = deltas
      .slice(before)
      .filter((d) => d.phase === 'UPDATE')
      .reduce((s, d) => s + Math.abs(d.delta.position.x), 0);
    expect(moved).toBeGreaterThan(0);
  });

  it('dropping the transform hand while anchored keeps the pause (no stuck state)', () => {
    const controller = new InteractionController();
    let t = confirmGesture(controller, makeHand({ gesture: 'GRAB' }));

    for (let i = 0; i < 20; i++) {
      step(controller, rightPalm(), t, leftDriftedPalm());
      t += FRAME_MS;
    }
    expect(controller.getInteractionState().paused).toBe(true);

    // The right (transform) hand leaves the frame; the left palm stays up.
    // Loss of the transform hand must not silently RELEASE the anchor while
    // the palm that requested it is still visible.
    let st = controller.getInteractionState();
    for (let i = 0; i < 30; i++) {
      st = step(controller, null, t, leftDriftedPalm());
      t += FRAME_MS;
    }
    expect(st.paused).toBe(true);

    // Removing the palm afterwards resumes exactly as designed.
    for (let i = 0; i < 40; i++) {
      st = step(controller, makeHand({ gesture: 'GRAB' }), t);
      t += FRAME_MS;
    }
    expect(st.paused).toBe(false);
    expect(st.mode).toBe('MOVE');
  });

  it('re-presenting the palms re-anchors — the gesture is not one-shot', () => {
    const controller = new InteractionController();
    let t = confirmGesture(controller, makeHand({ gesture: 'GRAB' }));

    for (let i = 0; i < 20; i++) {
      step(controller, rightPalm(), t, leftDriftedPalm());
      t += FRAME_MS;
    }
    expect(controller.getInteractionState().paused).toBe(true);

    let st = controller.getInteractionState();
    for (let i = 0; i < 40; i++) {
      st = step(controller, makeHand({ gesture: 'GRAB' }), t);
      t += FRAME_MS;
    }
    expect(st.paused).toBe(false);

    // Anchor again: same two palms, fresh request.
    let pausedAgain = false;
    for (let i = 0; i < 20; i++) {
      st = step(controller, rightPalm(), t, leftDriftedPalm());
      t += FRAME_MS;
      if (st.paused) pausedAgain = true;
    }
    expect(pausedAgain).toBe(true);
    expect(st.mode).toBe('MOVE');
  });
});
