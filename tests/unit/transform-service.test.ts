/**
 * Transform Service unit tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';
import { TransformService } from '../../src/engine-3d/transform-service';
import { SceneManager } from '../../src/engine-3d/scene-manager';
import { EventBus } from '../../src/core/event-bus';
import type { TransformCommand } from '../../src/core/contracts';

describe('TransformService', () => {
  let eventBus: EventBus;
  let scene: THREE.Scene;
  let sceneManager: SceneManager;
  let transformService: TransformService;
  let objectId: string;
  let testObject: THREE.Object3D;

  beforeEach(() => {
    eventBus = new EventBus();
    scene = new THREE.Scene();
    sceneManager = new SceneManager(scene);
    transformService = new TransformService(eventBus, sceneManager);

    // Create a test object
    testObject = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial(),
    );
    objectId = sceneManager.addObject(testObject, 'Test Cube');
  });

  it('should set position via SET operation', () => {
    const cmd: TransformCommand = {
      commandId: 'cmd-1',
      source: 'INSPECTOR',
      objectId,
      operation: 'SET',
      property: 'POSITION',
      values: { x: 5, y: 3, z: -2 },
      history: 'RECORD',
    };

    const result = transformService.apply(cmd);
    expect(result).toBe(true);
    expect(testObject.position.x).toBe(5);
    expect(testObject.position.y).toBe(3);
    expect(testObject.position.z).toBe(-2);
  });

  it('should set rotation via SET operation', () => {
    const cmd: TransformCommand = {
      commandId: 'cmd-1',
      source: 'INSPECTOR',
      objectId,
      operation: 'SET',
      property: 'ROTATION',
      values: { x: Math.PI / 4, y: 0, z: 0 },
      history: 'RECORD',
    };

    const result = transformService.apply(cmd);
    expect(result).toBe(true);
    expect(testObject.rotation.x).toBeCloseTo(Math.PI / 4);
  });

  it('should set scale via SET operation', () => {
    const cmd: TransformCommand = {
      commandId: 'cmd-1',
      source: 'INSPECTOR',
      objectId,
      operation: 'SET',
      property: 'SCALE',
      values: { x: 2, y: 2, z: 2 },
      history: 'RECORD',
    };

    const result = transformService.apply(cmd);
    expect(result).toBe(true);
    expect(testObject.scale.x).toBe(2);
    expect(testObject.scale.y).toBe(2);
    expect(testObject.scale.z).toBe(2);
  });

  it('should apply delta position', () => {
    testObject.position.set(1, 0, 0);

    const cmd: TransformCommand = {
      commandId: 'cmd-1',
      source: 'CV',
      objectId,
      operation: 'DELTA',
      property: 'POSITION',
      values: { x: 0.5, y: 0, z: 0 },
      history: 'RECORD',
    };

    transformService.apply(cmd);
    expect(testObject.position.x).toBeCloseTo(1.5);
  });

  it('should emit transform:changed event', () => {
    const handler = vi.fn();
    eventBus.on('transform:changed', handler);

    const cmd: TransformCommand = {
      commandId: 'cmd-1',
      source: 'INSPECTOR',
      objectId,
      operation: 'SET',
      property: 'POSITION',
      values: { x: 5, y: 0, z: 0 },
      history: 'RECORD',
    };

    transformService.apply(cmd);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        objectId,
        source: 'INSPECTOR',
        transform: expect.objectContaining({
          position: { x: 5, y: 0, z: 0 },
        }),
      }),
    );
  });

  it('should return false for non-existent object', () => {
    const cmd: TransformCommand = {
      commandId: 'cmd-1',
      source: 'INSPECTOR',
      objectId: 'obj-nonexistent',
      operation: 'SET',
      property: 'POSITION',
      values: { x: 1, y: 0, z: 0 },
      history: 'RECORD',
    };

    const result = transformService.apply(cmd);
    expect(result).toBe(false);
  });

  it('should set transform from snapshot (for undo/redo)', () => {
    transformService.setTransform(objectId, {
      position: { x: 10, y: 20, z: 30 },
      rotationRadians: { x: 1, y: 2, z: 3 },
      scale: { x: 5, y: 5, z: 5 },
    });

    expect(testObject.position.x).toBe(10);
    expect(testObject.position.y).toBe(20);
    expect(testObject.position.z).toBe(30);
    expect(testObject.rotation.x).toBe(1);
    expect(testObject.scale.x).toBe(5);
  });

  it('should get current transform snapshot', () => {
    testObject.position.set(3, 4, 5);
    testObject.rotation.set(0.5, 0, 0);
    testObject.scale.set(2, 2, 2);

    const snapshot = transformService.getTransform(objectId);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.position).toEqual({ x: 3, y: 4, z: 5 });
    expect(snapshot!.scale).toEqual({ x: 2, y: 2, z: 2 });
  });
});
