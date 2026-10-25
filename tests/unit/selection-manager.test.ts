/**
 * Selection Manager unit tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';
import { SelectionManager } from '../../src/engine-3d/selection-manager';
import { EventBus } from '../../src/core/event-bus';

describe('SelectionManager', () => {
  let eventBus: EventBus;
  let scene: THREE.Scene;
  let selection: SelectionManager;
  let mockObject: THREE.Object3D;

  beforeEach(() => {
    eventBus = new EventBus();
    scene = new THREE.Scene();
    mockObject = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial(),
    );
    mockObject.name = 'Test Object';

    selection = new SelectionManager(
      eventBus,
      scene,
      (id) => (id === 'obj-1' ? mockObject : null),
      (id) => (id === 'obj-1' ? 'Test Object' : 'Unknown'),
    );
  });

  it('should start with no selection', () => {
    const state = selection.getState();
    expect(state.objectId).toBeNull();
    expect(state.isSelected).toBe(false);
  });

  it('should select an object', () => {
    const handler = vi.fn();
    eventBus.on('selection:changed', handler);

    selection.select('obj-1');

    expect(selection.selectedId).toBe('obj-1');
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        objectId: 'obj-1',
        displayName: 'Test Object',
        previousObjectId: null,
      }),
    );
  });

  it('should deselect an object', () => {
    selection.select('obj-1');
    selection.select(null);

    expect(selection.selectedId).toBeNull();
  });

  it('should emit changed event with previous selection', () => {
    const handler = vi.fn();
    eventBus.on('selection:changed', handler);

    selection.select('obj-1');
    selection.select(null);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenLastCalledWith(
      expect.objectContaining({
        objectId: null,
        previousObjectId: 'obj-1',
      }),
    );
  });

  it('should not emit event when selecting same object', () => {
    const handler = vi.fn();
    eventBus.on('selection:changed', handler);

    selection.select('obj-1');
    selection.select('obj-1');

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('should report selection state correctly', () => {
    expect(selection.isSelected('obj-1')).toBe(false);

    selection.select('obj-1');

    expect(selection.isSelected('obj-1')).toBe(true);
    expect(selection.isSelected('obj-2')).toBe(false);
  });
});
