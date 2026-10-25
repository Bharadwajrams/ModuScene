/**
 * Module Builder V2.0 — Shared Type Contracts
 *
 * This module defines the plain-data interfaces exchanged between subsystems.
 * It contains no subsystem behavior — only types and constants.
 *
 * V2.0 CV interaction contracts:
 *   ONE active transformation mode (NONE | MOVE | ROTATE | SCALE).
 *   Gesture recognition always runs; transformation execution is locked
 *   to the active mode. Mode changes require a 1-second gesture hold.
 */

// ─── Identifiers ───────────────────────────────────────────

/** Stable scene-instance identifier */
export type ObjectId = string;

/** Imported asset identifier */
export type AssetId = string;

/** CV transformation session identifier */
export type SessionId = string;

/** Optional tracing / history correlation */
export type CommandId = string;

/** Monotonically comparable timestamp */
export type TimestampMs = number;

// ─── Core Value Types ─────────────────────────────────────

export interface Vector3Value {
  x: number;
  y: number;
  z: number;
}

export interface TransformSnapshot {
  position: Vector3Value;
  rotationRadians: Vector3Value;
  scale: Vector3Value;
}

export interface Dimensions {
  width: number;
  height: number;
  depth: number;
}

// ─── Selection Contracts ──────────────────────────────────

/** Read-only snapshot of current selection state */
export interface SelectionState {
  objectId: ObjectId | null;
  displayName: string | null;
  isSelected: boolean;
}

/** Request selection change */
export interface SelectionCommand {
  commandId: CommandId;
  objectId: ObjectId | null;
  source: 'VIEWPORT' | 'MODULE_SELECTION_UI' | 'OTHER_UI';
}

/** Emitted when selection changes */
export interface SelectionChangedEvent {
  objectId: ObjectId | null;
  displayName: string | null;
  previousObjectId: ObjectId | null;
  timestamp: TimestampMs;
}

// ─── Object Display Data ──────────────────────────────────

/** Presentation-safe data for UI consumption (no raw Object3D) */
export interface ObjectDisplayData {
  objectId: ObjectId;
  name: string;
  transform: TransformSnapshot;
  dimensions?: Dimensions;
  visible: boolean;
}

// ─── Transform Contracts ──────────────────────────────────

/** Common route for object transforms from any source */
export interface TransformCommand {
  commandId: CommandId;
  source: 'INSPECTOR' | 'CV' | 'OTHER_UI';
  objectId: ObjectId;
  operation: 'SET' | 'DELTA' | 'SCALE_FACTOR';
  property: 'POSITION' | 'ROTATION' | 'SCALE';
  values: Vector3Value;
  history: 'RECORD' | 'NONE';
}

/** Emitted when an object transform changes */
export interface TransformChangedEvent {
  objectId: ObjectId;
  transform: TransformSnapshot;
  source: 'INSPECTOR' | 'CV' | 'OTHER_UI';
  timestamp: TimestampMs;
}

// ─── CV Data Contracts ────────────────────────────────────

/** Recognized gesture types */
export type Gesture =
  | 'POINT'
  | 'GRAB'
  | 'PINCH'
  | 'ROTATE_3'
  | 'OPEN_PALM'
  | 'SCALE_POSE'
  | 'NONE';

// ─── Hand-Tracking Contracts (working layer — kept as-is) ──

/** One MediaPipe hand landmark, normalized [0..1] camera space. */
export interface HandLandmark {
  x: number;
  y: number;
  z: number;
}

/** Per-finger extension state (true = extended). */
export interface FingerState {
  thumb: boolean;
  index: boolean;
  middle: boolean;
  ring: boolean;
  pinky: boolean;
}

/** One tracked hand: landmarks + derived gesture + palm signals. */
export interface HandState {
  active: boolean;
  handedness: 'left' | 'right';
  landmarks: HandLandmark[];
  /** Rigid palm center (wrist + MCP knuckle block) — finger-curl invariant. */
  center: Vector3Value;
  wrist: Vector3Value;
  indexTip: Vector3Value;
  /** 2D thumb-tip ↔ index-tip distance, normalized frame units. */
  pinchDistance: number;
  fingerState: FingerState;
  gesture: Gesture;
  confidence: number;
}

/** Everything the transformation layer sees, once per frame. */
export interface HandFrame {
  timestamp: TimestampMs;
  leftHand: HandState | null;
  rightHand: HandState | null;
  trackingConfidence: number;
  pointer: PointerState | null;
}

/**
 * The SINGLE active transformation mode. Exactly one controller may be
 * active at any time; every other controller is inactive.
 */
export type CVMode = 'NONE' | 'MOVE' | 'ROTATE' | 'SCALE';

/** One transformed axis of a per-axis delta. */
export interface CVTransformDelta {
  mode: 'MOVE' | 'ROTATE' | 'SCALE';
  /** World-space deltas; only the axis under control is non-zero. */
  position: Vector3Value;
  rotation: Vector3Value;
  /** Multiplicative scale factors; identity (1,1,1) when inactive. */
  scale: Vector3Value;
}

/** Full interaction state published to the UI every frame. */
export interface CVInteractionState {
  /** Currently ACTIVE transformation mode (the source of truth). */
  mode: CVMode;
  /** Which surface transformations apply to (drives the UI badge). */
  context: 'MODULE' | 'VIEWPORT';
  /** Whether transformation execution is currently paused (left palm). */
  paused: boolean;
  /** A mode-change confirmation in progress (progress 0..1). */
  confirm: { gesture: Gesture; mode: CVMode; progress: number } | null;
}

/** CV per-frame transformation output (already axis-resolved). */
export interface CVFrameDelta {
  sessionId: SessionId;
  objectId: ObjectId;
  delta: CVTransformDelta;
  phase: 'BEGIN' | 'UPDATE' | 'END';
  timestamp: TimestampMs;
}

// ─── Pointer / UI Contracts ───────────────────────────────

export interface PointerState {
  active: boolean;
  sourceHand: 'left' | 'right';
  /** Index fingertip (landmark 8), normalized [0..1] camera space. */
  x: number;
  y: number;
  /** Target currently under the pointer (hover). */
  hoveredTargetId: string | null;
  /** Target accumulating hold-confirm progress. */
  candidateTargetId: string | null;
  /** When the pointer became stable over the candidate. */
  stableSinceMs: TimestampMs | null;
}

/** A hover target for the CV UI pointer (tabs, panels, module rows). */
export interface PointerTarget {
  id: string;
  type: 'tab' | 'panel' | 'module-row';
  x: number;
  y: number;
  width: number;
  height: number;
}

// ─── Viewport Contracts ───────────────────────────────────

/** Camera navigation intent (never contains object transform fields) */
export interface ViewportIntent {
  source: 'VIEWPORT_UI' | 'CV';
  action: 'PAN' | 'ZOOM' | 'ORBIT';
  deltaX?: number;
  deltaY?: number;
  zoomDelta?: number;
  /** Orbit angles in radians (yaw around Y, pitch around X). */
  orbitYaw?: number;
  orbitPitch?: number;
  phase: 'BEGIN' | 'UPDATE' | 'END';
  timestamp: TimestampMs;
}

/** Emitted when camera state changes (optional display sync) */
export interface ViewportChangedEvent {
  timestamp: TimestampMs;
}

// ─── UI State Contracts ───────────────────────────────────

/** Current CV tab state */
export interface UITabState {
  activeTab: 'MODULE_SELECTION' | 'VIEWPORT_CONTROL' | null;
  expanded: boolean;
  hoveredTargetId: string | null;
  selectedTargetId: string | null;
}

/** One row in the Module Selection list */
export interface ModuleListItem {
  objectId: ObjectId;
  displayName: string;
  isSelected: boolean;
  visible: boolean;
  enabled: boolean;
}

/** View model for the bottom Inspector */
export interface InspectorViewModel {
  objectId: ObjectId | null;
  name: string | null;
  move: Vector3Value | null;
  scale: Vector3Value | null;
  rotationDegrees: Vector3Value | null;
  additionalSections: InspectorSection[];
}

/** Scrollable secondary Inspector content */
export interface InspectorSection {
  label: string;
  content: string;
}

// ─── History Contracts ────────────────────────────────────

export type HistoryActionType = 'CREATE' | 'DELETE' | 'TRANSFORM' | 'RENAME';
export type HistorySource = 'UI' | 'CV' | 'SYSTEM';

/** Single reversible history entry */
export interface HistoryRecord {
  commandId: CommandId;
  actionType: HistoryActionType;
  targetObjectId: ObjectId;
  source: HistorySource;
  before?: TransformSnapshot;
  after?: TransformSnapshot;
  /**
   * Every module affected by a GROUP movement (checked modules moved
   * together). Present only for group moves: one logical undo step restores
   * all of them, each under its own identity. The top-level before/after
   * still describe `targetObjectId` so single-module paths keep working.
   */
  group?: GroupTransformEntry[];
  timestamp: TimestampMs;
}

/** One module's contribution to a group movement undo step. */
export interface GroupTransformEntry {
  objectId: ObjectId;
  before: TransformSnapshot;
  after: TransformSnapshot;
}

// ─── Asset Contracts ──────────────────────────────────────

export type TextureStatus = 'EMBEDDED' | 'RESOLVED' | 'MISSING' | 'NOT_APPLICABLE';
export type LoadStatus = 'AVAILABLE' | 'LOADING' | 'FAILED';

/** Imported asset record */
export interface AssetRecord {
  assetId: AssetId;
  name: string;
  /** 'PRIMITIVE' = built-in basic shape (Cube / Sphere / Cone). */
  sourceType: 'GLB' | 'GLTF' | 'PRIMITIVE';
  sourcePath?: string;
  textureStatus: TextureStatus;
  loadStatus: LoadStatus;
}

/** Instantiated scene object record */
export interface SceneObjectRecord {
  objectId: ObjectId;
  assetId: AssetId;
  name: string;
  visible: boolean;
  transform: TransformSnapshot;
}

// ─── Layout Constants ─────────────────────────────────────

export type CVWorkspaceState = 'CLOSED' | 'OPEN';
