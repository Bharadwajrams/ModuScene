/**
 * Module Builder V1.1 — Typed Event Bus
 *
 * Provides typed pub/sub for cross-engine communication.
 * No engine imports another engine's internals — they communicate
 * through this bus using the contracts defined in contracts.ts.
 */

import type {
  SelectionChangedEvent,
  TransformChangedEvent,
  ViewportChangedEvent,
  CVInteractionState,
  CVFrameDelta,
  PointerState,
  CVWorkspaceState,
} from './contracts';

// ─── Event Map ────────────────────────────────────────────

export interface EventMap {
  'selection:changed': SelectionChangedEvent;
  'transform:changed': TransformChangedEvent;
  'viewport:changed': ViewportChangedEvent;
  'cv:interaction-state': CVInteractionState;
  'cv:transform-delta': CVFrameDelta;
  'cv:pointer': PointerState | null;
  'cv:workspace-toggle': CVWorkspaceState;
  'ui:selection-command': import('./contracts').SelectionCommand;
  'ui:transform-command': import('./contracts').TransformCommand;
  'ui:viewport-intent': import('./contracts').ViewportIntent;
  'cv:viewport-intent': import('./contracts').ViewportIntent;
  'asset-library:toggle': boolean;
}

// ─── Listener Type ────────────────────────────────────────

type Listener<T> = (data: T) => void;

// ─── EventBus Implementation ─────────────────────────────

export class EventBus {
  private listeners = new Map<string, Set<Listener<unknown>>>();

  on<K extends keyof EventMap>(event: K, listener: Listener<EventMap[K]>): () => void {
    const key = event as string;
    if (!this.listeners.has(key)) {
      this.listeners.set(key, new Set());
    }
    this.listeners.get(key)!.add(listener as Listener<unknown>);

    // Return unsubscribe function
    return () => {
      this.listeners.get(key)?.delete(listener as Listener<unknown>);
    };
  }

  emit<K extends keyof EventMap>(event: K, data: EventMap[K]): void {
    const key = event as string;
    const set = this.listeners.get(key);
    if (set) {
      for (const listener of set) {
        listener(data);
      }
    }
  }

  /** Remove all listeners — for testing and teardown */
  clear(): void {
    this.listeners.clear();
  }
}
