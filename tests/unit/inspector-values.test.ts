/**
 * Inspector numeric-edit accuracy
 *
 * The Inspector had two accuracy defects:
 *  1. every value was rendered with `toFixed(2)`, so a module sitting at
 *     scale 1.2345 (CV session, imported GLB, Scale All) showed "1.23" — the
 *     bar displayed a value the scene did not hold, and one spinner press
 *     from that display rewrote the real 1.2345 as 1.24;
 *  2. `parseFloat(value) || 0` turned an emptied / unparseable field into the
 *     number 0, silently collapsing the axis to the origin.
 *
 * These tests drive the real SceneManager → TransformService → DisplayAdapter
 * → Inspector stack through a jsdom DOM and assert on the actual Object3D,
 * not on implementation details.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { EventBus } from '../../src/core/event-bus';
import { HistoryManager } from '../../src/core/history-manager';
import { TransformHistory } from '../../src/core/transform-history';
import type { TransformCommand, SelectionChangedEvent } from '../../src/core/contracts';
import { SceneManager } from '../../src/engine-3d/scene-manager';
import { TransformService } from '../../src/engine-3d/transform-service';
import { DisplayAdapter } from '../../src/engine-3d/display-adapter';
import { Inspector } from '../../src/engine-ui/inspector';

type Axis = 'x' | 'y' | 'z';
type Property = 'position' | 'scale' | 'rotation';

function setup() {
  const scene = new THREE.Scene();
  const sceneManager = new SceneManager(scene);
  const eventBus = new EventBus();
  const transformService = new TransformService(eventBus, sceneManager);
  const displayAdapter = new DisplayAdapter(sceneManager);
  const history = new HistoryManager(eventBus, () => {}, () => {});
  const transformHistory = new TransformHistory(eventBus, history, (id) =>
    transformService.getTransform(id),
  );

  eventBus.on('ui:transform-command', (cmd: TransformCommand) => {
    transformHistory.apply(cmd, (command) => transformService.apply(command));
  });

  const region = document.createElement('div');
  document.body.appendChild(region);
  new Inspector(eventBus, displayAdapter, region, transformService);

  const addModule = (): THREE.Mesh => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
    sceneManager.addObject(mesh, 'Cube');
    return mesh;
  };

  const select = (objectId: string | null): void => {
    eventBus.emit('selection:changed', {
      objectId,
      displayName: null,
      previousObjectId: null,
      timestamp: Date.now(),
    } as SelectionChangedEvent);
  };

  const input = (property: Property, axis: Axis): HTMLInputElement => {
    const el = region.querySelector(
      `.inspector-input[data-property="${property}"][data-axis="${axis}"]`,
    );
    if (!el) throw new Error(`missing ${property}.${axis}`);
    return el as HTMLInputElement;
  };

  /** Simulate a committed edit (what blurring / Enter does in the browser). */
  const commit = (property: Property, axis: Axis, text: string): void => {
    const el = input(property, axis);
    el.value = text;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  return { scene, sceneManager, eventBus, transformService, region, addModule, select, input, commit };
}

let h: ReturnType<typeof setup>;

beforeEach(() => {
  h = setup();
});

afterEach(() => {
  h.region.remove();
});

// ─── Position ────────────────────────────────────────────

describe('Inspector position edits are absolute and axis-exact', () => {
  it('sets X to the typed value instead of adding to the current one', () => {
    const mesh = h.addModule();
    mesh.position.set(2, 3, 4);
    h.select(h.sceneManager.getAllObjects()[0].objectId);

    h.commit('position', 'x', '5');

    expect(mesh.position.x).toBe(5); // not 2 + 5
    expect(mesh.position.y).toBe(3);
    expect(mesh.position.z).toBe(4);
  });

  it('edits Y and Z independently, leaving the other axes alone', () => {
    const mesh = h.addModule();
    mesh.position.set(1, 1, 1);
    h.select(h.sceneManager.getAllObjects()[0].objectId);

    h.commit('position', 'y', '-7.25');
    expect(mesh.position.toArray()).toEqual([1, -7.25, 1]);

    h.commit('position', 'z', '0.5');
    expect(mesh.position.toArray()).toEqual([1, -7.25, 0.5]);
  });

  it('keeps decimal precision in the scene (1.2345 is not truncated)', () => {
    const mesh = h.addModule();
    h.select(h.sceneManager.getAllObjects()[0].objectId);

    h.commit('position', 'x', '1.2345');

    expect(mesh.position.x).toBeCloseTo(1.2345, 10);
    expect(h.input('position', 'x').value).toBe('1.2345');
  });

  it('shows the familiar 2-decimal form for values that sit on that grid', () => {
    const mesh = h.addModule();
    h.select(h.sceneManager.getAllObjects()[0].objectId);

    h.commit('position', 'x', '5');

    expect(h.input('position', 'x').value).toBe('5.00');
  });
});

// ─── Rotation (degrees ↔ radians) ────────────────────────

describe('Inspector rotation edits use degrees and never mix up axes', () => {
  it('converts degrees to radians on X', () => {
    const mesh = h.addModule();
    h.select(h.sceneManager.getAllObjects()[0].objectId);

    h.commit('rotation', 'x', '45');

    expect(mesh.rotation.x).toBeCloseTo(Math.PI / 4, 10);
    expect(mesh.rotation.y).toBe(0);
    expect(mesh.rotation.z).toBe(0);
    expect(h.input('rotation', 'x').value).toBe('45.00');
  });

  it('handles negative degrees on Y and Z independently', () => {
    const mesh = h.addModule();
    h.select(h.sceneManager.getAllObjects()[0].objectId);

    h.commit('rotation', 'y', '-90');
    h.commit('rotation', 'z', '180');

    expect(mesh.rotation.x).toBe(0);
    expect(mesh.rotation.y).toBeCloseTo(-Math.PI / 2, 10);
    expect(mesh.rotation.z).toBeCloseTo(Math.PI, 10);
    expect(h.input('rotation', 'y').value).toBe('-90.00');
    expect(h.input('rotation', 'z').value).toBe('180.00');
  });

  it('does not lose the other axes when one rotation is edited', () => {
    const mesh = h.addModule();
    h.select(h.sceneManager.getAllObjects()[0].objectId);

    h.commit('rotation', 'x', '30');
    h.commit('rotation', 'y', '60');

    expect(mesh.rotation.x).toBeCloseTo(Math.PI / 6, 10);
    expect(mesh.rotation.y).toBeCloseTo(Math.PI / 3, 10);
  });
});

// ─── Scale ───────────────────────────────────────────────

describe('Inspector scale edits hit the right axis with exact values', () => {
  it('sets a non-uniform scale without touching the other axes', () => {
    const mesh = h.addModule();
    mesh.scale.set(2, 1.5, 0.5);
    h.select(h.sceneManager.getAllObjects()[0].objectId);

    h.commit('scale', 'z', '2.5');

    expect(mesh.scale.toArray()).toEqual([2, 1.5, 2.5]);
  });

  it('displays a value the scene really holds instead of rounding it away', () => {
    const mesh = h.addModule();
    h.select(h.sceneManager.getAllObjects()[0].objectId);

    h.commit('scale', 'x', '1.2345');

    expect(mesh.scale.x).toBeCloseTo(1.2345, 10);
    // Regression: this used to read "1.23", so the next spinner press rewrote
    // the real 1.2345 as 1.24.
    expect(h.input('scale', 'x').value).toBe('1.2345');
  });

  it('never shows a tiny non-zero scale as flat zero', () => {
    const mesh = h.addModule();
    h.select(h.sceneManager.getAllObjects()[0].objectId);

    h.commit('scale', 'y', '0.00001');

    expect(mesh.scale.y).toBeCloseTo(0.00001, 12);
    expect(h.input('scale', 'y').value).toBe('0.00001');
  });
});

// ─── Empty / invalid input ───────────────────────────────

describe('empty or unparseable input never collapses an axis', () => {
  it('keeps the current position when the field is cleared', () => {
    const mesh = h.addModule();
    mesh.position.set(4, 5, 6);
    h.select(h.sceneManager.getAllObjects()[0].objectId);

    h.commit('position', 'x', '');

    expect(mesh.position.toArray()).toEqual([4, 5, 6]);
    expect(h.input('position', 'x').value).toBe('4.00');
  });

  it('keeps the current scale when the typed text is not a number', () => {
    const mesh = h.addModule();
    mesh.scale.set(2, 2, 2);
    h.select(h.sceneManager.getAllObjects()[0].objectId);

    h.commit('scale', 'x', 'abc');

    expect(mesh.scale.toArray()).toEqual([2, 2, 2]);
  });
});

// ─── Drift / selection / isolation ───────────────────────

describe('repeated edits and selection changes stay accurate', () => {
  it('does not drift when another axis is edited afterwards', () => {
    const mesh = h.addModule();
    h.select(h.sceneManager.getAllObjects()[0].objectId);

    h.commit('position', 'x', '1.2345');
    h.commit('position', 'y', '2');
    h.commit('position', 'z', '3');

    expect(mesh.position.x).toBeCloseTo(1.2345, 10);
    expect(mesh.position.y).toBe(2);
    expect(mesh.position.z).toBe(3);
  });

  it('shows the newly selected module and the value that was applied', () => {
    const first = h.addModule();
    const second = h.addModule();
    const [firstId, secondId] = h.sceneManager.getAllObjects().map((r) => r.objectId);

    first.position.set(1, 2, 3);
    second.position.set(-4, -5, -6);

    h.select(firstId);
    expect(h.input('position', 'x').value).toBe('1.00');

    h.select(secondId);
    expect(h.input('position', 'x').value).toBe('-4.00');

    h.commit('position', 'x', '9.5');
    expect(second.position.x).toBe(9.5);

    h.select(firstId);
    expect(h.input('position', 'x').value).toBe('1.00');
    expect(first.position.x).toBe(1);
  });

  it('edits only the selected module', () => {
    const first = h.addModule();
    const second = h.addModule();
    first.position.set(1, 1, 1);
    second.position.set(2, 2, 2);

    h.select(h.sceneManager.getAllObjects()[1].objectId);
    h.commit('position', 'x', '7');

    expect(second.position.x).toBe(7);
    expect(first.position.toArray()).toEqual([1, 1, 1]);
  });

  it('does not overwrite uncommitted text in the field being typed in', () => {
    const mesh = h.addModule();
    const id = h.sceneManager.getAllObjects()[0].objectId;

    h.select(id);
    const field = h.input('position', 'x');
    field.focus();
    field.value = '7'; // typed, not yet committed
    field.dispatchEvent(new Event('input', { bubbles: true }));

    // A transform lands on the same module (CV frame, group move, Scale All).
    h.transformService.apply({
      commandId: 'cv-1',
      source: 'CV',
      objectId: id,
      operation: 'DELTA',
      property: 'POSITION',
      values: { x: 0, y: 1, z: 0 },
      history: 'RECORD',
    });

    expect(field.value).toBe('7');
    expect(h.input('position', 'y').value).toBe('1.00');

    // Committing still applies exactly what was typed.
    field.dispatchEvent(new Event('change', { bubbles: true }));
    expect(mesh.position.x).toBe(7);
  });

  it('still follows Undo/Redo in a field that is focused but not being edited', () => {
    const mesh = h.addModule();
    const id = h.sceneManager.getAllObjects()[0].objectId;

    h.select(id);
    h.commit('position', 'x', '5');
    expect(h.input('position', 'x').value).toBe('5.00');

    const field = h.input('position', 'x');
    field.focus();

    // Undo/Redo restore through TransformService, exactly like main.ts does.
    h.transformService.setTransform(id, {
      position: { x: 0, y: 0, z: 0 },
      rotationRadians: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    });

    expect(mesh.position.x).toBe(0);
    expect(field.value).toBe('0.00');
  });
});
