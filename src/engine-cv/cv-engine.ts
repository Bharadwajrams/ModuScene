/**
 * Module Builder V2.0 — CV Engine
 *
 * Orchestrates: Webcam → MediaPipe → HandFrame → InteractionController → deltas.
 * One pipeline, one webcam, one MediaPipe instance.
 * CV never imports or mutates Three.js objects.
 *
 * V2.0: the transformation pipeline is the new InteractionController
 * (single ACTIVE_MODE, 1 s confirm, pause/re-anchor). The old
 * SessionController and its axis/intent model are removed.
 *
 * UI CONTEXT separation:
 *   - MODULE context: transformations affect the selected object.
 *   - VIEWPORT context: GRAB→pan, PINCH→zoom, OPEN_PALM→orbit the camera.
 * Context is set via setUIContext() when the user's pointer hovers a
 * floating tab/panel (wired in main.ts).
 */

import type {
  CVInteractionState,
  HandFrame,
  TimestampMs,
  ViewportIntent,
} from '../core/contracts';
import { EventBus } from '../core/event-bus';
import { WebcamSource } from './tracking/webcam-source';
import { HandFrameProducer } from './tracking/hand-frame-producer';
import { InteractionController, type DeltaPayload } from './interaction/interaction-controller';
import { PointerProcessor } from './pointer/pointer-processor';

// ─── CV Engine ──────────────────────────────────────────

export class CVEngine {
  private eventBus: EventBus;
  private webcamSource: WebcamSource;
  private handFrameProducer: HandFrameProducer;
  private interactionController: InteractionController;
  private pointerProcessor: PointerProcessor;

  private processingLoopId: number | null = null;
  private isRunning = false;
  private selectedObjectId: string | null = null;
  /** UI context: which surface the transformations apply to. */
  private uiContext: 'MODULE' | 'VIEWPORT' = 'MODULE';

  /** Viewport-context control state (context-local, never touches objects). */
  private view: {
    lastPalm: { x: number; y: number } | null;
  } = {
    lastPalm: null,
  };

  /** Camera accessor for VIEWPORT context (set by main.ts). */
  private cameraAccessor: (() => { position: { x: number; y: number; z: number }; target: { x: number; y: number; z: number } }) | null = null;

  // MediaPipe hand landmarker (lazy-loaded)
  private handLandmarker: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  private mediapipeReady = false;

  // Frame timestamp guard for monotonically increasing MediaPipe timestamps
  private lastFrameTimestamp = 0;
  // Selection snapshot while a transform session is live
  private sessionSelectionId: string | null = null;

  // Skeleton overlay redraw throttle (30 fps is plenty for visualization)
  private lastSkeletonEmitMs = 0;
  // Callback for visual updates
  private onHandLandmarks: ((right: import('../core/contracts').HandLandmark[] | null, left: import('../core/contracts').HandLandmark[] | null) => void) | null = null;

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
    this.webcamSource = new WebcamSource();
    this.handFrameProducer = new HandFrameProducer();
    this.interactionController = new InteractionController();
    this.pointerProcessor = new PointerProcessor();

    // Wire interaction-controller delta output
    this.interactionController.onDelta((payload) => {
      this.handleFrameDelta(payload);
    });

    // Listen for selection changes
    this.eventBus.on('selection:changed', (event) => {
      this.selectedObjectId = event.objectId;
    });

    // Listen for workspace toggle
    this.eventBus.on('cv:workspace-toggle', (state) => {
      if (state === 'CLOSED') {
        this.stop();
      }
    });
  }

  /**
   * Start the CV pipeline: webcam + MediaPipe + processing loop.
   */
  async start(videoElement: HTMLVideoElement): Promise<boolean> {
    if (this.isRunning) return true;

    const webcamOk = await this.webcamSource.start(videoElement);
    if (!webcamOk) {
      console.error('[CVEngine] Webcam failed to start');
      return false;
    }

    try {
      await this.initMediaPipe();
    } catch (error) {
      console.error('[CVEngine] MediaPipe init failed:', error);
      this.webcamSource.stop();
      return false;
    }

    this.isRunning = true;
    this.startProcessingLoop();
    console.log('[CVEngine] Started');
    return true;
  }

  /**
   * Stop the CV pipeline.
   */
  stop(): void {
    this.isRunning = false;
    this.stopProcessingLoop();
    this.interactionController.reset();
    this.webcamSource.stop();
    this.handFrameProducer.reset();
    this.pointerProcessor.reset();
    this.resetViewState();
    this.lastFrameTimestamp = 0;
    this.sessionSelectionId = null;
    console.log('[CVEngine] Stopped');
  }

  /**
   * Set the UI context: which surface hand transformations apply to.
   * MODULE = selected object; VIEWPORT = camera.
   */
  setUIContext(context: 'MODULE' | 'VIEWPORT'): void {
    if (this.uiContext === context) return;
    this.uiContext = context;
    // Context switch resets viewport-control state (context separation) and
    // freezes any active object transformation (the controller ends its
    // session — object and camera can never be driven simultaneously).
    this.interactionController.setUIContext(context);
    this.resetViewState();
  }

  getUIContext(): 'MODULE' | 'VIEWPORT' {
    return this.uiContext;
  }

  /** Provide camera access for VIEWPORT-context control. */
  setCameraAccessor(
    accessor: () => { position: { x: number; y: number; z: number }; target: { x: number; y: number; z: number } },
  ): void {
    this.cameraAccessor = accessor;
  }

  /**
   * Initialize MediaPipe Hand Landmarker.
   */
  private async initMediaPipe(): Promise<void> {
    if (this.mediapipeReady) return;

    try {
      const vision = await import('@mediapipe/tasks-vision');
      const { HandLandmarker, FilesetResolver } = vision;

      const filesetResolver = await FilesetResolver.forVisionTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm',
      );

      this.handLandmarker = await HandLandmarker.createFromOptions(filesetResolver, {
        baseOptions: {
          modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.3,
        minHandPresenceConfidence: 0.3,
        minTrackingConfidence: 0.3,
      });

      this.mediapipeReady = true;
      console.log('[CVEngine] MediaPipe initialized');
    } catch (error) {
      console.error('[CVEngine] MediaPipe import/init failed:', error);
      throw error;
    }
  }

  /**
   * Main processing loop — runs at video frame rate.
   */
  private startProcessingLoop(): void {
    const processFrame = () => {
      if (!this.isRunning) return;

      const video = this.webcamSource.getVideoElement();
      if (video && video.readyState >= 2 && this.handLandmarker) {
        try {
          // Capture fresh timestamp; ensure monotonically increasing
          // for MediaPipe's VIDEO mode (it skips frames with duplicate timestamps)
          let now = Date.now();
          if (now <= this.lastFrameTimestamp) {
            now = this.lastFrameTimestamp + 1;
          }
          this.lastFrameTimestamp = now;

          const mpResult = this.handLandmarker.detectForVideo(video, now);

          // Process into HandFrame (hand tracking layer — untouched)
          const handFrame = this.handFrameProducer.processFrame(
            mpResult,
            now as TimestampMs,
          );

          // Left-hand finger count → control axis (1=X, 2=Y, 3=Z)
          this.detectAxisFromLeftHand(handFrame);

          // Route by UI context
          if (this.uiContext === 'VIEWPORT') {
            this.processViewportControl(handFrame, now as TimestampMs);
          } else {
            this.processModuleContext(handFrame, now as TimestampMs);
          }

          // Publish interaction state (mode indicator, confirm ring, pause)
          const interaction = this.interactionController.getInteractionState();
          this.eventBus.emit('cv:interaction-state', interaction);

          // Emit pointer for visual cursor
          this.eventBus.emit('cv:pointer', handFrame.pointer ?? null);

          // Emit hand landmarks for skeleton visualization (throttled)
          if (this.onHandLandmarks && now - this.lastSkeletonEmitMs >= 33) {
            this.lastSkeletonEmitMs = now;
            this.onHandLandmarks(
              handFrame.rightHand?.landmarks ?? null,
              handFrame.leftHand?.landmarks ?? null,
            );
          }

          // Process pointer for UI interaction
          this.pointerProcessor.processPointer(handFrame.pointer ?? null, now as TimestampMs);
        } catch (error) {
          console.warn('[CVEngine] Frame processing error:', error);
        }
      }

      this.processingLoopId = requestAnimationFrame(processFrame);
    };

    this.processingLoopId = requestAnimationFrame(processFrame);
  }

  private stopProcessingLoop(): void {
    if (this.processingLoopId !== null) {
      cancelAnimationFrame(this.processingLoopId);
      this.processingLoopId = null;
    }
  }

  // ── MODULE context: object transformation ───────────────

  private processModuleContext(handFrame: HandFrame, now: TimestampMs): void {
    this.interactionController.processFrame(handFrame, now);
    // Selection binding is owned by handleFrameDelta: the session keeps its
    // original target and UPDATE deltas for a changed selection are dropped
    // there — the object can never silently re-target mid-gesture.
  }

  // ── VIEWPORT context: camera control (never touches objects) ──

  private processViewportControl(handFrame: HandFrame, now: TimestampMs): void {
    // Feed the interaction controller so the mode indicator stays live in
    // this context too, but ignore its object deltas (context separation).
    this.interactionController.processFrame(handFrame, now);

    const right = handFrame.rightHand;
    const cam = this.cameraAccessor?.();
    if (!cam) {
      this.resetViewState();
      return;
    }

    if (!right || !right.active) {
      this.resetViewState();
      return;
    }

    // ── VIEWPORT CONTROL = ROTATION ONLY ──
    // Per the simplified design, the viewport context responds ONLY to the
    // rotate gesture (open palm). GRAB (pan) and PINCH (zoom) were removed:
    // viewport movement/zoom is done with the mouse (OrbitControls), and
    // gestures here must never move/scale the scene — object or camera.
    switch (right.gesture) {
      case 'OPEN_PALM': {
        // Palm-drag orbit: horizontal → yaw, vertical → pitch.
        // Vertical is negated: image Y grows DOWNWARD, so an un-negated
        // (c.y - last.y) made hand-UP produce a negative pitch → camera rose
        // → the view tilted the WRONG way. With the flip, hand-UP → view up.
        const c = right.center;
        if (this.view.lastPalm) {
          const dyaw = (c.x - this.view.lastPalm.x) * Math.PI * 1.5;
          const dpitch = -(c.y - this.view.lastPalm.y) * Math.PI * 1.0;
          if (Math.abs(dyaw) > 0.004 || Math.abs(dpitch) > 0.004) {
            const intent: ViewportIntent = {
              source: 'CV',
              action: 'ORBIT',
              orbitYaw: Math.max(-0.12, Math.min(0.12, dyaw)),
              orbitPitch: Math.max(-0.1, Math.min(0.1, dpitch)),
              phase: 'UPDATE',
              timestamp: now,
            };
            this.eventBus.emit('cv:viewport-intent', intent);
          }
        }
        this.view.lastPalm = { x: c.x, y: c.y };
        break;
      }
      default:
        // GRAB / PINCH / POINT / NONE: no viewport action (deliberately).
        this.resetGestureState();
        break;
    }
  }

  private resetGestureState(): void {
    this.view.lastPalm = null;
  }

  private resetViewState(): void {
    this.resetGestureState();
  }

  // ── Frame-delta handling (MODULE context) ───────────────

  private handleFrameDelta(payload: DeltaPayload): void {
    const { delta, phase, timestamp, sessionId } = payload;

    // Context separation (defense in depth — the controller already freezes
    // in VIEWPORT context): object deltas can never originate there.
    if (this.uiContext === 'VIEWPORT') return;

    if (phase === 'BEGIN') {
      if (this.selectedObjectId) {
        this.sessionSelectionId = this.selectedObjectId;
      }
      this.eventBus.emit('cv:transform-delta', {
        sessionId,
        objectId: this.selectedObjectId ?? '',
        delta,
        phase,
        timestamp,
      });
      return;
    }

    if (phase === 'END') {
      const endedObjectId = this.sessionSelectionId ?? this.selectedObjectId ?? '';
      this.sessionSelectionId = null;
      this.eventBus.emit('cv:transform-delta', {
        sessionId,
        objectId: endedObjectId,
        delta,
        phase,
        timestamp,
      });
      return;
    }

    // UPDATE: the session is bound to its starting selection. If the
    // selection changed mid-gesture, drop the delta instead of silently
    // transforming the new object.
    const objectId = this.sessionSelectionId ?? this.selectedObjectId;
    if (!objectId) return;
    if (this.selectedObjectId !== null && this.selectedObjectId !== objectId) return;

    this.eventBus.emit('cv:transform-delta', {
      sessionId,
      objectId,
      delta,
      phase,
      timestamp,
    });
  }

  /**
   * Detect axis from left hand finger count (with debounce):
   * 1 finger = X, 2 fingers = Y, 3 fingers = Z. Otherwise retain.
   *
   * A single miscounted MediaPipe frame used to call setControlAxis()
   * immediately, which re-anchors the active session — that made Z-move
   * impossible to accumulate (axis silently flipped away mid-gesture) and
   * rocked the object between axes (the "rotation wobble"). The count must
   * now hold steady for AXIS_DEBOUNCE_MS before the axis changes.
   */
  private detectAxisFromLeftHand(handFrame: HandFrame): void {
    const leftHand = handFrame.leftHand;
    if (!leftHand || !leftHand.active) {
      // Left-hand dropout: keep the pending/committed axis (dropouts are
      // momentary — resetting here would prevent a stable count from ever
      // committing when the hands partially overlap).
      return;
    }
    // ── Hand-ownership rule ──
    // The LEFT hand is the UI POINTER. But POINT (index extended) is ALSO
    // the 1-finger "X axis" pose — the same physical gesture. Disambiguate
    // by what the pointer is doing:
    //   • Pointer over/near UI (tab or module list hovered) → the POINT is
    //     pointer duty; skip axis selection (previously this skipped ALL
    //     left-hand POINTs, which made X permanently unselectable — Y/Z
    //     (2/3 fingers) worked, X silently fell through to the old axis).
    //   • Pointer NOT over UI → the left index is a deliberate X request.
    const pointerOverUI =
      this.pointerProcessor.hoverTab !== null ||
      this.pointerProcessor.hoverModule !== null;
    if (leftHand.gesture === 'POINT' && pointerOverUI) {
      return;
    }

    const fs = leftHand.fingerState;
    const count = (fs.index ? 1 : 0) + (fs.middle ? 1 : 0) + (fs.ring ? 1 : 0) + (fs.pinky ? 1 : 0);
    const axis = detectAxisStable(count, Date.now() as TimestampMs);
    if (axis) {
      this.interactionController.setControlAxis(axis);
    }
  }

  /** Register callback for hand landmark visualization */
  onHandLandmarksUpdate(callback: (right: import('../core/contracts').HandLandmark[] | null, left: import('../core/contracts').HandLandmark[] | null) => void): void {
    this.onHandLandmarks = callback;
  }

  /** Get pointer processor for UI target registration */
  getPointerProcessor(): PointerProcessor {
    return this.pointerProcessor;
  }

  /** Get the current interaction state */
  getInteractionState(): CVInteractionState {
    return this.interactionController.getInteractionState();
  }

  /** Check if CV is running */
  get running(): boolean {
    return this.isRunning;
  }

}

// ─── Axis-selection debounce (module-level, exported for tests) ──

const AXIS_DEBOUNCE_MS = 300;

interface AxisStabilityState {
  pendingAxis: 'X' | 'Y' | 'Z' | null;
  sinceMs: number | null;
  committedAxis: 'X' | 'Y' | 'Z' | null;
}

let axisStability: AxisStabilityState = {
  pendingAxis: null,
  sinceMs: null,
  committedAxis: null,
};

/**
 * Commit an axis only after the finger count has held steady for
 * AXIS_DEBOUNCE_MS. Single miscounted frames can never flip the axis
 * (and therefore can never re-anchor the active transformation).
 */
export function detectAxisStable(
  count: number,
  nowMs: TimestampMs,
): 'X' | 'Y' | 'Z' | null {
  const n = count === 1 ? 'X' : count === 2 ? 'Y' : count === 3 ? 'Z' : null;
  if (!n) {
    // Open palm / fist on the left hand = no axis request; keep the last one.
    return axisStability.committedAxis;
  }
  if (axisStability.pendingAxis !== n) {
    axisStability.pendingAxis = n;
    axisStability.sinceMs = nowMs;
    return axisStability.committedAxis;
  }
  if (axisStability.sinceMs !== null && nowMs - axisStability.sinceMs >= AXIS_DEBOUNCE_MS) {
    axisStability.committedAxis = n;
  }
  return axisStability.committedAxis;
}

/**
 * Feed a raw finger count with dropout tolerance: a `null` count (hand lost
 * for a frame) neither resets the pending window nor commits anything.
 */
export function detectAxisFromCountStable(
  count: number | null,
  nowMs: TimestampMs,
): 'X' | 'Y' | 'Z' | null {
  if (count === null) return axisStability.committedAxis;
  return detectAxisStable(count, nowMs);
}

/** Reset the debounce state (per engine instance / tests). */
export function resetAxisStability(): void {
  axisStability = { pendingAxis: null, sinceMs: null, committedAxis: null };
}
