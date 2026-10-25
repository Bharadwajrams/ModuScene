/**
 * Module Builder V1.1 — Camera Controller
 *
 * Authority for camera/viewport state. Viewport Control gestures and
 * UI camera commands converge here. Object transforms never leak
 * into camera state and camera commands never affect objects.
 *
 * Source of truth: Doc 04 §5, D-005, Doc 05 §8
 */

import type { ViewportIntent, ViewportChangedEvent, TimestampMs } from '../core/contracts';
import { EventBus } from '../core/event-bus';

// ─── Simplified Camera Reference ─────────────────────────

interface CameraRef {
  position: { x: number; y: number; z: number };
  update: () => void;
}

interface ControlsRef {
  target: { x: number; y: number; z: number };
  update: () => void;
}

// ─── Camera Controller ───────────────────────────────────

export class CameraController {
  private eventBus: EventBus;
  private camera: CameraRef;
  private controls: ControlsRef;
  private zoomSpeed = 0.01;
  private panSpeed = 0.005;

  constructor(eventBus: EventBus, camera: CameraRef, controls: ControlsRef) {
    this.eventBus = eventBus;
    this.camera = camera;
    this.controls = controls;
  }

  /**
   * Apply a viewport intent — pan or zoom.
   * NEVER modifies object transforms.
   */
  applyIntent(intent: ViewportIntent): boolean {
    let changed = false;

    switch (intent.action) {
      case 'PAN':
        changed = this.applyPan(intent);
        break;
      case 'ZOOM':
        changed = this.applyZoom(intent);
        break;
      case 'ORBIT':
        changed = this.applyOrbit(intent);
        break;
    }

    if (changed) {
      this.controls.update();

      // Emit viewport changed event
      const event: ViewportChangedEvent = {
        timestamp: Date.now() as TimestampMs,
      };
      this.eventBus.emit('viewport:changed', event);
    }

    return changed;
  }

  /**
   * Get current camera position (read-only snapshot).
   */
  getCameraPosition(): { x: number; y: number; z: number } {
    return {
      x: this.camera.position.x,
      y: this.camera.position.y,
      z: this.camera.position.z,
    };
  }

  /**
   * Get the current orbit target (read-only snapshot).
   */
  getCameraTarget(): { x: number; y: number; z: number } {
    return {
      x: this.controls.target.x,
      y: this.controls.target.y,
      z: this.controls.target.z,
    };
  }

  // ─── Private ──────────────────────────────────────────

  private applyPan(intent: ViewportIntent): boolean {
    const deltaX = (intent.deltaX ?? 0) * this.panSpeed;
    const deltaY = (intent.deltaY ?? 0) * this.panSpeed;

    if (deltaX === 0 && deltaY === 0) return false;

    // Pan relative to camera orientation
    this.camera.position.x -= deltaX;
    this.camera.position.y += deltaY;
    this.controls.target.x -= deltaX;
    this.controls.target.y += deltaY;

    return true;
  }

  private applyZoom(intent: ViewportIntent): boolean {
    const zoomDelta = (intent.zoomDelta ?? 0) * this.zoomSpeed;

    if (zoomDelta === 0) return false;

    // Move camera forward/backward along its view direction
    const direction = {
      x: this.controls.target.x - this.camera.position.x,
      y: this.controls.target.y - this.camera.position.y,
      z: this.controls.target.z - this.camera.position.z,
    };

    const length = Math.sqrt(
      direction.x * direction.x + direction.y * direction.y + direction.z * direction.z,
    );

    if (length === 0) return false;

    const factor = zoomDelta / length;
    this.camera.position.x += direction.x * factor;
    this.camera.position.y += direction.y * factor;
    this.camera.position.z += direction.z * factor;

    return true;
  }

  /**
   * Orbit the camera around the current target (yaw around world Y,
   * pitch clamped to avoid flipping over the poles).
   */
  private applyOrbit(intent: ViewportIntent): boolean {
    const yaw = intent.orbitYaw ?? 0;
    const pitch = intent.orbitPitch ?? 0;

    if (yaw === 0 && pitch === 0) return false;

    const offset = {
      x: this.camera.position.x - this.controls.target.x,
      y: this.camera.position.y - this.controls.target.y,
      z: this.camera.position.z - this.controls.target.z,
    };

    const radius = Math.sqrt(
      offset.x * offset.x + offset.y * offset.y + offset.z * offset.z,
    );
    if (radius === 0) return false;

    // Spherical angles of the current offset
    const theta = Math.atan2(offset.x, offset.z);          // yaw
    const phi = Math.acos(Math.max(-1, Math.min(1, offset.y / radius))); // pitch from +Y

    const nextTheta = theta + yaw;
    const nextPhi = Math.max(0.15, Math.min(Math.PI - 0.15, phi + pitch));

    const sinPhi = Math.sin(nextPhi);
    this.camera.position.x =
      this.controls.target.x + radius * sinPhi * Math.sin(nextTheta);
    this.camera.position.y =
      this.controls.target.y + radius * Math.cos(nextPhi);
    this.camera.position.z =
      this.controls.target.z + radius * sinPhi * Math.cos(nextTheta);

    return true;
  }
}
