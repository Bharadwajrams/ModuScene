/**
 * Module Builder V2.0 — Transform History
 *
 * Captures the "before" snapshot BEFORE a transform is executed and turns the
 * resulting `transform:changed` event into exactly one undo entry.
 *
 * Order matters: the before-state must be read before the transform is
 * applied. Capturing it from an event listener is unreliable because listener
 * registration order decides whether the scene has already moved (the original
 * bug: the first Inspector transform was recorded with an already-moved
 * "before" and could therefore never be undone). Execution goes through
 * apply(), which guarantees capture-before-execute.
 *
 * CV gestures are multi-frame: the caller captures once with begin() at
 * session BEGIN, and the first applied frame produces the single entry.
 *
 * GROUP movement (several checked modules moved together) goes through
 * applyGroup(): every affected module's before/after is captured around one
 * execution and recorded as ONE logical undo step, so a single Undo restores
 * the whole group while each module keeps its own identity.
 *
 * Source of truth: Doc 05 §10, Doc 03 §13
 */

import type {
  GroupTransformEntry,
  ObjectId,
  TransformChangedEvent,
  TransformCommand,
  TransformSnapshot,
} from './contracts';
import { EventBus } from './event-bus';
import { HistoryManager } from './history-manager';

export type TransformReader = (objectId: ObjectId) => TransformSnapshot | null;
export type TransformExecutor = (cmd: TransformCommand) => boolean;

// ─── Transform History ───────────────────────────────────

export class TransformHistory {
  private eventBus: EventBus;
  private history: HistoryManager;
  private readTransform: TransformReader;
  private pendingBefore = new Map<ObjectId, TransformSnapshot>();
  /** >0 while a group transaction executes — per-object recording is paused. */
  private suppressed = 0;

  constructor(
    eventBus: EventBus,
    history: HistoryManager,
    readTransform: TransformReader,
  ) {
    this.eventBus = eventBus;
    this.history = history;
    this.readTransform = readTransform;

    this.eventBus.on('transform:changed', (event) => this.complete(event));
  }

  /**
   * Execute a transform command, capturing its before-state first when the
   * command is an undoable UI edit. Every other command (keyboard nudges,
   * CV frames) executes unchanged.
   */
  apply(cmd: TransformCommand, execute: TransformExecutor): boolean {
    if (this.isRecordable(cmd)) {
      this.begin(cmd.objectId);
    }
    return execute(cmd);
  }

  /**
   * Capture the before-state of a multi-frame session (CV) once, at BEGIN,
   * before the first frame is applied. `groupIds` are the modules checked for
   * group movement — captured alongside the primary so the session records
   * one entry covering the whole group.
   */
  begin(objectId: ObjectId, groupIds: ObjectId[] = []): void {
    this.captureBefore(objectId);
    for (const id of groupIds) {
      this.captureBefore(id);
    }
  }

  /**
   * Execute a group movement and record ONE undo entry covering every
   * affected module (its own before/after, its own identity).
   *
   * Per-object `transform:changed` recording is suppressed while the group
   * executes, so the members cannot split into separate undo steps. Keyboard
   * group moves (history NONE) simply execute. CV sessions rely on the capture
   * made by begin() at session start, so frames after the first never create
   * additional entries.
   */
  applyGroup(cmd: TransformCommand, objectIds: ObjectId[], execute: () => void): void {
    const recordable = this.isRecordable(cmd);
    const fromCv = cmd.source === 'CV';

    if (!recordable && !fromCv) {
      execute(); // keyboard nudges: never recorded
      return;
    }

    if (recordable) {
      for (const id of objectIds) this.captureBefore(id);
    } else if (this.pendingBefore.has(cmd.objectId)) {
      // First CV frame after BEGIN: any module joined mid-session is captured
      // now (it cannot have moved between BEGIN and this frame).
      for (const id of objectIds) {
        if (!this.pendingBefore.has(id)) this.captureBefore(id);
      }
    }

    this.suppressed += 1;
    try {
      execute();
    } finally {
      this.suppressed -= 1;
    }

    const members: GroupTransformEntry[] = [];
    for (const id of objectIds) {
      const before = this.pendingBefore.get(id);
      if (!before) continue;
      const after = this.readTransform(id);
      if (!after) continue;
      members.push({ objectId: id, before, after });
      this.pendingBefore.delete(id);
    }
    if (members.length === 0) return;

    const primary = members.find((m) => m.objectId === cmd.objectId) ?? members[0];
    this.history.record({
      commandId: this.history.generateCommandId(),
      actionType: 'TRANSFORM',
      targetObjectId: primary.objectId,
      source: fromCv ? 'CV' : 'UI',
      before: primary.before,
      after: primary.after,
      group: members.length > 1 ? members : undefined,
      timestamp: this.history.now(),
    });
  }

  /** Clear pending capture state (teardown). */
  dispose(): void {
    this.pendingBefore.clear();
  }

  // ─── Private ─────────────────────────────────────────

  private isRecordable(cmd: TransformCommand): boolean {
    return cmd.source === 'INSPECTOR' && cmd.history === 'RECORD';
  }

  /** Read and remember the pre-transform state of one module. */
  private captureBefore(objectId: ObjectId): void {
    const before = this.readTransform(objectId);
    if (before) {
      this.pendingBefore.set(objectId, before);
    }
  }

  /**
   * Record exactly one entry for the transform that just changed the object.
   * The pending capture is consumed here, so a CV session cannot flood the
   * undo stack with one entry per frame.
   */
  private complete(event: TransformChangedEvent): void {
    if (this.suppressed > 0) return; // group transaction records as one entry
    if (event.source !== 'INSPECTOR' && event.source !== 'CV') return;

    const before = this.pendingBefore.get(event.objectId);
    if (!before) return;

    this.history.record({
      commandId: this.history.generateCommandId(),
      actionType: 'TRANSFORM',
      targetObjectId: event.objectId,
      source: event.source === 'INSPECTOR' ? 'UI' : 'CV',
      before,
      after: event.transform,
      timestamp: event.timestamp,
    });
    this.pendingBefore.delete(event.objectId);
  }
}
