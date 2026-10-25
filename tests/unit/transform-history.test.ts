/**
 * Transform History — undo capture tests
 *
 * Regression guard for the "first Inspector transform is never recorded"
 * defect: the before-state must be read BEFORE the transform executes, so a
 * single Inspector edit is already undoable (previously it took a second edit
 * to push an entry, and the last edit could never be undone).
 *
 * Wired exactly like the application: EventBus + CommandRouter → TransformHistory
 * → TransformService, with HistoryManager restoring through setTransform.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { EventBus } from '../../src/core/event-bus';
import { CommandRouter } from '../../src/core/command-router';
import { HistoryManager } from '../../src/core/history-manager';
import { TransformHistory } from '../../src/core/transform-history';
import { SceneManager } from '../../src/engine-3d/scene-manager';
import { TransformService } from '../../src/engine-3d/transform-service';
import type { ObjectId, TransformCommand } from '../../src/core/contracts';

// ─── Harness ─────────────────────────────────────────────

function setup() {
  const eventBus = new EventBus();
  const scene = new THREE.Scene();
  const sceneManager = new SceneManager(scene);
  const transformService = new TransformService(eventBus, sceneManager);

  const history = new HistoryManager(
    eventBus,
    (record) => {
      // Mirrors main.ts applyHistoryRecord: a group entry restores every member
      if (record.group && record.group.length > 0) {
        for (const member of record.group) transformService.setTransform(member.objectId, member.after);
      } else if (record.after) {
        transformService.setTransform(record.targetObjectId, record.after);
      }
    },
    (record) => {
      // Mirrors main.ts revertHistoryRecord
      if (record.group && record.group.length > 0) {
        for (const member of record.group) transformService.setTransform(member.objectId, member.before);
      } else if (record.before) {
        transformService.setTransform(record.targetObjectId, record.before);
      }
    },
  );

  const transformHistory = new TransformHistory(
    eventBus,
    history,
    (objectId) => transformService.getTransform(objectId),
  );

  const objectId = sceneManager.addObject(
    new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()),
    'cube',
  );

  const addModule = (name: string): ObjectId =>
    sceneManager.addObject(
      new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()),
      name,
    );

  // Stands in for the Manual Module Selector's checked boxes
  let checked: ObjectId[] = [];
  const setChecked = (ids: ObjectId[]): void => {
    checked = ids;
  };

  /** Mirrors main.ts applyTransformCommand: single path vs group path. */
  const executeCommand = (cmd: TransformCommand): void => {
    const targets =
      cmd.property !== 'POSITION' || checked.length === 0
        ? [cmd.objectId]
        : [cmd.objectId, ...checked.filter((id) => id !== cmd.objectId)];

    if (targets.length <= 1) {
      transformHistory.apply(cmd, (command) => transformService.apply(command));
      return;
    }

    const before = cmd.operation === 'SET' ? transformService.getTransform(cmd.objectId) : null;
    transformHistory.applyGroup(cmd, targets, () => {
      targets.forEach((id, index) => {
        if (index === 0) {
          transformService.apply(cmd);
          return;
        }
        const groupCmd: TransformCommand = {
          ...cmd,
          commandId: `${cmd.commandId}-group-${index}`,
          objectId: id,
        };
        if (cmd.operation === 'SET' && before) {
          groupCmd.operation = 'DELTA';
          groupCmd.values = {
            x: cmd.values.x - before.position.x,
            y: cmd.values.y - before.position.y,
            z: cmd.values.z - before.position.z,
          };
        }
        transformService.apply(groupCmd);
      });
    });
  };

  // Same route as main.ts: CommandRouter → TransformHistory → TransformService
  new CommandRouter(eventBus).onTransform((cmd) => {
    executeCommand(cmd);
  });

  let seq = 0;
  const inspectorSet = (x: number, overrides: Partial<TransformCommand> = {}): TransformCommand => ({
    commandId: `inspector-${++seq}`,
    source: 'INSPECTOR',
    objectId,
    operation: 'SET',
    property: 'POSITION',
    values: { x, y: 0, z: 0 },
    history: 'RECORD',
    ...overrides,
  });

  const emit = (cmd: TransformCommand): void => eventBus.emit('ui:transform-command', cmd);
  const positionX = (): number => +(sceneManager.getObject(objectId)!.position.x.toFixed(4));
  const positionXOf = (id: ObjectId): number => +(sceneManager.getObject(id)!.position.x.toFixed(4));

  return {
    eventBus,
    sceneManager,
    transformService,
    history,
    transformHistory,
    objectId,
    inspectorSet,
    emit,
    positionX,
    positionXOf,
    addModule,
    setChecked,
    executeCommand,
  };
}

let h: ReturnType<typeof setup>;

beforeEach(() => {
  h = setup();
});

// ─── Inspector edits ─────────────────────────────────────

describe('TransformHistory — Inspector edits', () => {
  it('records the FIRST Inspector transform so it can be undone (regression)', () => {
    h.emit(h.inspectorSet(1));

    expect(h.history.undoDepth).toBe(1);
    expect(h.positionX()).toBe(1);

    const undone = h.history.undo();
    expect(undone).not.toBeNull();
    expect(h.positionX()).toBe(0);
  });

  it('records every edit with its own pre-edit before-state', () => {
    h.emit(h.inspectorSet(1));
    h.emit(h.inspectorSet(2));
    h.emit(h.inspectorSet(3));

    expect(h.history.undoDepth).toBe(3);

    h.history.undo();
    expect(h.positionX()).toBe(2);
    h.history.undo();
    expect(h.positionX()).toBe(1);
    h.history.undo();
    expect(h.positionX()).toBe(0);
    expect(h.history.canUndo()).toBe(false);
  });

  it('redo reapplies the recorded after-state', () => {
    h.emit(h.inspectorSet(2.5));
    h.history.undo();
    expect(h.positionX()).toBe(0);

    h.history.redo();
    expect(h.positionX()).toBe(2.5);
  });

  it('records rotation and scale edits too', () => {
    h.emit({
      commandId: 'inspector-rot',
      source: 'INSPECTOR',
      objectId: h.objectId,
      operation: 'SET',
      property: 'ROTATION',
      values: { x: 0, y: Math.PI / 2, z: 0 },
      history: 'RECORD',
    });
    h.emit({
      commandId: 'inspector-scale',
      source: 'INSPECTOR',
      objectId: h.objectId,
      operation: 'SCALE_FACTOR',
      property: 'SCALE',
      values: { x: 1.1, y: 1.1, z: 1.1 },
      history: 'RECORD',
    });

    expect(h.history.undoDepth).toBe(2);
    h.history.undo();
    expect(+h.sceneManager.getObject(h.objectId)!.scale.x.toFixed(4)).toBe(1);
    h.history.undo();
    expect(+h.sceneManager.getObject(h.objectId)!.rotation.y.toFixed(4)).toBe(0);
  });

  it('does not record keyboard nudges (history NONE)', () => {
    h.emit({
      commandId: 'keyboard-1',
      source: 'OTHER_UI',
      objectId: h.objectId,
      operation: 'DELTA',
      property: 'POSITION',
      values: { x: 0.1, y: 0, z: 0 },
      history: 'NONE',
    });

    expect(h.positionX()).toBe(0.1);
    expect(h.history.undoDepth).toBe(0);
  });
});

// ─── CV sessions ─────────────────────────────────────────

describe('TransformHistory — CV sessions', () => {
  const cvMove = (x: number, timestamp: number): TransformCommand => ({
    commandId: `cv-${timestamp}`,
    source: 'CV',
    objectId: h.objectId,
    operation: 'DELTA',
    property: 'POSITION',
    values: { x, y: 0, z: 0 },
    history: 'RECORD',
  });

  const applyCv = (cmd: TransformCommand): void => {
    h.transformHistory.apply(cmd, (command) => h.transformService.apply(command));
  };

  it('records one entry per session, not one per frame', () => {
    // main.ts captures at session BEGIN (before the first frame)
    h.transformHistory.begin(h.objectId);

    applyCv(cvMove(0.5, 1));
    applyCv(cvMove(0.5, 2));
    applyCv(cvMove(0.5, 3));

    expect(h.positionX()).toBe(1.5);
    expect(h.history.undoDepth).toBe(1);

    h.history.undo();
    expect(h.positionX()).toBe(0);
  });

  it('a second session after END adds its own entry', () => {
    h.transformHistory.begin(h.objectId);
    applyCv(cvMove(0.5, 1));
    h.transformHistory.begin(h.objectId);
    applyCv(cvMove(0.25, 2));

    expect(h.history.undoDepth).toBe(2);
    h.history.undo();
    expect(h.positionX()).toBe(0.5);
    h.history.undo();
    expect(h.positionX()).toBe(0);
  });
});

// ─── Group movement (checked modules) ─────────────────────

describe('TransformHistory — group movement', () => {
  let second: ObjectId;

  beforeEach(() => {
    second = h.addModule('second');
    h.sceneManager.getObject(second)!.position.x = 2;
  });

  it('records ONE entry covering every module, undoing the whole group at once', () => {
    h.setChecked([second]);

    h.emit(h.inspectorSet(1));

    // both modules moved by the same offset (0→1, 2→3), relative gap kept
    expect(h.positionX()).toBe(1);
    expect(h.positionXOf(second)).toBe(3);
    expect(h.history.undoDepth).toBe(1); // one logical entry, not two

    const record = h.history.undo();
    expect(record?.group).toHaveLength(2);
    expect(record?.group?.map((m) => m.objectId).sort()).toEqual([h.objectId, second].sort());
    expect(record?.targetObjectId).toBe(h.objectId);

    // both restored to their exact previous positions
    expect(h.positionX()).toBe(0);
    expect(h.positionXOf(second)).toBe(2);

    h.history.redo();
    expect(h.positionX()).toBe(1);
    expect(h.positionXOf(second)).toBe(3);
    expect(h.positionXOf(second) - h.positionX()).toBe(2); // identity kept
  });

  it('keeps each member\'s own before/after snapshot in the entry', () => {
    h.setChecked([second]);
    h.emit(h.inspectorSet(1));

    const record = h.history.undo();
    const primary = record!.group!.find((m) => m.objectId === h.objectId)!;
    const member = record!.group!.find((m) => m.objectId === second)!;

    expect(primary.before.position.x).toBe(0);
    expect(primary.after.position.x).toBe(1);
    expect(member.before.position.x).toBe(2);
    expect(member.after.position.x).toBe(3);
    // top-level fields still describe the selected module
    expect(record!.before!.position.x).toBe(0);
    expect(record!.after!.position.x).toBe(1);
  });

  it('single-module movement still records a plain entry (no group payload)', () => {
    h.setChecked([]);
    h.emit(h.inspectorSet(1));

    const record = h.history.undo();
    expect(record?.group).toBeUndefined();
    expect(record?.targetObjectId).toBe(h.objectId);
    expect(h.positionX()).toBe(0);
  });

  it('keyboard group moves are not recorded but still move both modules', () => {
    h.setChecked([second]);

    h.executeCommand({
      commandId: 'keyboard-group',
      source: 'OTHER_UI',
      objectId: h.objectId,
      operation: 'DELTA',
      property: 'POSITION',
      values: { x: 0.1, y: 0, z: 0 },
      history: 'NONE',
    });

    expect(h.positionX()).toBeCloseTo(0.1);
    expect(h.positionXOf(second)).toBeCloseTo(2.1);
    expect(h.history.undoDepth).toBe(0);
  });

  it('a CV session with checked modules records one group entry', () => {
    h.setChecked([second]);

    // main.ts captures the whole group at session BEGIN
    h.transformHistory.begin(h.objectId, [second]);

    const frame = (ts: number): TransformCommand => ({
      commandId: `cv-group-${ts}`,
      source: 'CV',
      objectId: h.objectId,
      operation: 'DELTA',
      property: 'POSITION',
      values: { x: 0.5, y: 0, z: 0 },
      history: 'RECORD',
    });
    h.executeCommand(frame(1));
    h.executeCommand(frame(2));

    expect(h.positionX()).toBe(1);
    expect(h.positionXOf(second)).toBe(3);
    expect(h.history.undoDepth).toBe(1); // frames did not flood the stack

    const record = h.history.undo();
    expect(record?.group).toHaveLength(2);
    expect(record?.source).toBe('CV');
    expect(h.positionX()).toBe(0);
    expect(h.positionXOf(second)).toBe(2);

    // redo reapplies the recorded after-state to every member
    h.history.redo();
    expect(h.positionX()).toBe(0.5);
    expect(h.positionXOf(second)).toBe(2.5);
  });
});
