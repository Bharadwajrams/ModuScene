/**
 * CV engine — the two-palm anchor must freeze the CAMERA too.
 *
 * In VIEWPORT context the right open palm is the orbit gesture. The session
 * pause (the anchor) is owned by the interaction controller, so without an
 * explicit gate the camera kept orbiting while the UI reported the session
 * anchored: the object was frozen, the view was not.
 *
 * These tests drive the engine's viewport path directly with mock pose frames
 * — they do NOT simulate a webcam or MediaPipe's tracker.
 */

import { describe, it, expect } from 'vitest';
import { CVEngine } from '../../src/engine-cv/cv-engine';
import { EventBus } from '../../src/core/event-bus';
import type {
  HandFrame,
  HandState,
  TimestampMs,
  ViewportIntent,
} from '../../src/core/contracts';

const FRAME_MS = 33;

function landmarks(cx: number, cy: number, span = 0.15): HandState['landmarks'] {
  const lm: HandState['landmarks'] = [];
  for (let i = 0; i < 21; i++) lm.push({ x: cx, y: cy + span, z: 0 });
  lm[0] = { x: cx, y: cy + span, z: 0 };
  lm[9] = { x: cx, y: cy, z: 0 };
  return lm;
}

function palm(handedness: 'left' | 'right', cx: number, cy = 0.5): HandState {
  return {
    active: true,
    handedness,
    landmarks: landmarks(cx, cy),
    center: { x: cx, y: cy, z: 0 },
    wrist: { x: cx, y: cy + 0.15, z: 0 },
    indexTip: { x: cx, y: cy - 0.1, z: 0 },
    pinchDistance: 0.1,
    fingerState: { index: true, middle: true, ring: true, pinky: true, thumb: true },
    gesture: 'OPEN_PALM',
    confidence: 0.9,
  };
}

function frame(right: HandState | null, left: HandState | null, t: number): HandFrame {
  return {
    timestamp: t as TimestampMs,
    leftHand: left,
    rightHand: right,
    trackingConfidence: 0.9,
    pointer: null,
  };
}

interface Harness {
  engine: CVEngine;
  intents: ViewportIntent[];
  /** Drive one viewport frame at the given time. */
  push: (right: HandState | null, left: HandState | null, t: number) => void;
}

function makeHarness(): Harness {
  const eventBus = new EventBus();
  const engine = new CVEngine(eventBus);
  const intents: ViewportIntent[] = [];
  eventBus.on('cv:viewport-intent', (intent) => intents.push(intent));
  engine.setCameraAccessor(() => ({
    position: { x: 5, y: 5, z: 10 },
    target: { x: 0, y: 0, z: 0 },
  }));
  engine.setUIContext('VIEWPORT');
  const push = (right: HandState | null, left: HandState | null, t: number) => {
    // The viewport path is internal; the engine only reaches it through its
    // own processing loop (webcam + MediaPipe), which a unit test cannot run.
    (engine as unknown as {
      processViewportControl: (f: HandFrame, now: TimestampMs) => void;
    }).processViewportControl(frame(right, left, t), t as TimestampMs);
  };
  return { engine, intents, push };
}

describe('CVEngine: two-palm anchor freezes viewport orbit', () => {
  it('orbits normally with a single palm (the gate does not break VIEWPORT)', () => {
    const { intents, push } = makeHarness();
    let t = 1000;
    for (let i = 1; i <= 8; i++) {
      push(palm('right', 0.4 + 0.02 * i), null, t);
      t += FRAME_MS;
    }
    expect(intents.length).toBeGreaterThan(0);
  });

  it('stops orbiting while both palms are anchored, and resumes after release', () => {
    const { engine, intents, push } = makeHarness();
    let t = 1000;

    // Right palm alone: the camera follows it.
    for (let i = 1; i <= 8; i++) {
      push(palm('right', 0.4 + 0.02 * i), null, t);
      t += FRAME_MS;
    }
    expect(intents.length).toBeGreaterThan(0);

    // Both palms up → the anchor engages; the palm keeps drifting (a held
    // pose is never perfectly still — that drift must NOT move the camera).
    let pausedAt = -1;
    const intentsBeforeAnchor = intents.length;
    for (let i = 0; i < 30; i++) {
      push(palm('right', 0.6 + 0.01 * i), palm('left', 0.2), t);
      t += FRAME_MS;
      if (pausedAt < 0 && engine.getInteractionState().paused) pausedAt = i;
    }
    expect(pausedAt).toBeGreaterThanOrEqual(0);
    expect(engine.getInteractionState().paused).toBe(true);
    // CONTRACT: nothing reached the camera after the anchor engaged.
    const afterAnchor = intents.slice(intentsBeforeAnchor + pausedAt + 1);
    expect(afterAnchor.filter((i) => i.phase === 'UPDATE').length).toBe(0);

    // Release: the palm orbits again from a FRESH anchor (no jump across the
    // ground the hand covered while anchored).
    const beforeRelease = intents.length;
    for (let i = 1; i <= 40; i++) {
      push(palm('right', 0.9 + 0.002 * i), null, t);
      t += FRAME_MS;
    }
    expect(engine.getInteractionState().paused).toBe(false);
    expect(intents.length).toBeGreaterThan(beforeRelease);
  });
});
