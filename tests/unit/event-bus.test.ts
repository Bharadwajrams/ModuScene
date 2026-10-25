/**
 * EventBus unit tests
 */

import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '../../src/core/event-bus';
import type { SelectionChangedEvent, SelectionState } from '../../src/core/contracts';

describe('EventBus', () => {
  it('should deliver events to subscribers', () => {
    const bus = new EventBus();
    const handler = vi.fn();

    bus.on('selection:changed', handler);

    const event: SelectionChangedEvent = {
      objectId: 'obj-1',
      displayName: 'Test Object',
      previousObjectId: null,
      timestamp: 1000,
    };

    bus.emit('selection:changed', event);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(event);
  });

  it('should support multiple subscribers for the same event', () => {
    const bus = new EventBus();
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    bus.on('selection:changed', handler1);
    bus.on('selection:changed', handler2);

    const event: SelectionChangedEvent = {
      objectId: 'obj-1',
      displayName: 'Test',
      previousObjectId: null,
      timestamp: 1000,
    };

    bus.emit('selection:changed', event);

    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler2).toHaveBeenCalledTimes(1);
  });

  it('should unsubscribe correctly', () => {
    const bus = new EventBus();
    const handler = vi.fn();

    const unsubscribe = bus.on('selection:changed', handler);
    unsubscribe();

    const event: SelectionChangedEvent = {
      objectId: 'obj-1',
      displayName: 'Test',
      previousObjectId: null,
      timestamp: 1000,
    };

    bus.emit('selection:changed', event);

    expect(handler).not.toHaveBeenCalled();
  });

  it('should not deliver events of different types', () => {
    const bus = new EventBus();
    const handler = vi.fn();

    bus.on('selection:changed', handler);

    // Emit a different event type
    bus.emit('viewport:changed', { timestamp: 1000 });

    expect(handler).not.toHaveBeenCalled();
  });

  it('should clear all listeners', () => {
    const bus = new EventBus();
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    bus.on('selection:changed', handler1);
    bus.on('transform:changed', handler2);

    bus.clear();

    bus.emit('selection:changed', {
      objectId: null,
      displayName: null,
      previousObjectId: null,
      timestamp: 1000,
    });

    expect(handler1).not.toHaveBeenCalled();
    expect(handler2).not.toHaveBeenCalled();
  });
});
