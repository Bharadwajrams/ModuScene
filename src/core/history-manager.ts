/**
 * Module Builder V1.1 — History Manager
 *
 * Single authoritative undo/redo system for all object transformations.
 * Both Inspector edits and CV sessions enter this same system.
 * Transition lock states and pointing do NOT create history entries.
 *
 * Source of truth: Doc 05 §10, Doc 03 §13
 */

import type { HistoryRecord, CommandId, TimestampMs } from './contracts';

// ─── Undo Callback ────────────────────────────────────────

export type UndoCallback = (record: HistoryRecord) => void;
export type RedoCallback = (record: HistoryRecord) => void;

// ─── History Manager ─────────────────────────────────────

export class HistoryManager {
  private undoStack: HistoryRecord[] = [];
  private redoStack: HistoryRecord[] = [];
  private maxSize: number;
  private onApply: UndoCallback;
  private onRevert: RedoCallback;

  constructor(
    _eventBus: import('./event-bus').EventBus,
    onApply: UndoCallback,
    onRevert: RedoCallback,
    maxSize: number = 100,
  ) {
    this.onApply = onApply;
    this.onRevert = onRevert;
    this.maxSize = maxSize;
  }

  /**
   * Record a transform action that can be undone.
   * This should be called ONCE per coherent session, not per frame.
   */
  record(record: HistoryRecord): void {
    // Prevent duplicate/empty records
    if (!record.before && !record.after) return;

    this.undoStack.push(record);
    this.redoStack = []; // Clear redo on new action

    // Enforce max size
    if (this.undoStack.length > this.maxSize) {
      this.undoStack.shift();
    }
  }

  /**
   * Generate a new command ID for tracking.
   */
  generateCommandId(): CommandId {
    return `cmd-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  }

  /**
   * Generate a timestamp.
   */
  now(): TimestampMs {
    return Date.now() as TimestampMs;
  }

  /**
   * Undo the last action.
   * Returns the record that was undone, or null if nothing to undo.
   */
  undo(): HistoryRecord | null {
    const record = this.undoStack.pop();
    if (!record) return null;

    this.redoStack.push(record);
    this.onRevert(record);

    return record;
  }

  /**
   * Redo the last undone action.
   * Returns the record that was redone, or null if nothing to redo.
   */
  redo(): HistoryRecord | null {
    const record = this.redoStack.pop();
    if (!record) return null;

    this.undoStack.push(record);
    this.onApply(record);

    return record;
  }

  /**
   * Record without requiring before/after (for CREATE/DELETE).
   */
  recordAction(record: HistoryRecord): void {
    this.undoStack.push(record);
    this.redoStack = [];

    if (this.undoStack.length > this.maxSize) {
      this.undoStack.shift();
    }
  }

  /** Check if undo is available */
  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  /** Check if redo is available */
  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Clear all history — for testing and scene reset */
  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  /** Get current stack depth (for testing) */
  get undoDepth(): number {
    return this.undoStack.length;
  }

  /** Get current redo depth (for testing) */
  get redoDepth(): number {
    return this.redoStack.length;
  }
}
