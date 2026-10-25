/**
 * History Manager unit tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HistoryManager } from '../../src/core/history-manager';
import { EventBus } from '../../src/core/event-bus';
import type { HistoryRecord, TransformSnapshot } from '../../src/core/contracts';

describe('HistoryManager', () => {
  let eventBus: EventBus;
  let history: HistoryManager;
  let onApply: ReturnType<typeof vi.fn>;
  let onRevert: ReturnType<typeof vi.fn>;

  const makeRecord = (overrides: Partial<HistoryRecord> = {}): HistoryRecord => ({
    commandId: 'test-cmd-1',
    actionType: 'TRANSFORM',
    targetObjectId: 'obj-1',
    source: 'INSPECTOR',
    before: {
      position: { x: 0, y: 0, z: 0 },
      rotationRadians: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    },
    after: {
      position: { x: 1, y: 0, z: 0 },
      rotationRadians: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    },
    timestamp: 1000,
    ...overrides,
  });

  beforeEach(() => {
    eventBus = new EventBus();
    onApply = vi.fn();
    onRevert = vi.fn();
    history = new HistoryManager(eventBus, onApply, onRevert);
  });

  it('should record actions', () => {
    history.record(makeRecord());
    expect(history.canUndo()).toBe(true);
    expect(history.undoDepth).toBe(1);
  });

  it('should undo to restore previous state', () => {
    const record = makeRecord();
    history.record(record);

    const undone = history.undo();
    expect(undone).toEqual(record);
    expect(onRevert).toHaveBeenCalledWith(record);
    expect(history.canRedo()).toBe(true);
  });

  it('should redo to reapply state', () => {
    const record = makeRecord();
    history.record(record);
    history.undo();

    const redone = history.redo();
    expect(redone).toEqual(record);
    expect(onApply).toHaveBeenCalledWith(record);
  });

  it('should clear redo stack on new action', () => {
    history.record(makeRecord());
    history.undo();
    expect(history.canRedo()).toBe(true);

    history.record(makeRecord({ commandId: 'cmd-2' }));
    expect(history.canRedo()).toBe(false);
  });

  it('should not create empty records', () => {
    history.record(makeRecord({ before: undefined, after: undefined }));
    expect(history.canUndo()).toBe(false);
  });

  it('should enforce max size', () => {
    const smallHistory = new HistoryManager(eventBus, onApply, onRevert, 3);

    smallHistory.record(makeRecord({ commandId: 'cmd-1' }));
    smallHistory.record(makeRecord({ commandId: 'cmd-2' }));
    smallHistory.record(makeRecord({ commandId: 'cmd-3' }));
    smallHistory.record(makeRecord({ commandId: 'cmd-4' }));

    expect(smallHistory.undoDepth).toBe(3);
  });

  it('should return null when nothing to undo', () => {
    expect(history.undo()).toBeNull();
  });

  it('should return null when nothing to redo', () => {
    expect(history.redo()).toBeNull();
  });

  it('should clear all history', () => {
    history.record(makeRecord());
    history.record(makeRecord());
    history.clear();

    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(false);
    expect(history.undoDepth).toBe(0);
  });

  it('should generate unique command IDs', () => {
    const id1 = history.generateCommandId();
    const id2 = history.generateCommandId();
    expect(id1).not.toBe(id2);
  });

  it('should undo and redo in sequence (mixed sources)', () => {
    const inspectorRecord = makeRecord({ commandId: 'inspector-1', source: 'INSPECTOR' });
    const cvRecord = makeRecord({ commandId: 'cv-1', source: 'CV' });

    history.record(inspectorRecord);
    history.record(cvRecord);

    // Undo CV action
    const undone1 = history.undo();
    expect(undone1?.commandId).toBe('cv-1');

    // Undo Inspector action
    const undone2 = history.undo();
    expect(undone2?.commandId).toBe('inspector-1');

    // Redo Inspector action
    const redone1 = history.redo();
    expect(redone1?.commandId).toBe('inspector-1');

    // Redo CV action
    const redone2 = history.redo();
    expect(redone2?.commandId).toBe('cv-1');
  });
});
