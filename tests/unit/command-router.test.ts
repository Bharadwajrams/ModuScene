/**
 * Command Router unit tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CommandRouter } from '../../src/core/command-router';
import { EventBus } from '../../src/core/event-bus';
import type { SelectionCommand, TransformCommand, ViewportIntent } from '../../src/core/contracts';

describe('CommandRouter', () => {
  let eventBus: EventBus;
  let router: CommandRouter;

  beforeEach(() => {
    eventBus = new EventBus();
    router = new CommandRouter(eventBus);
  });

  it('should route selection commands', () => {
    const handler = vi.fn();
    router.onSelection(handler);

    const cmd: SelectionCommand = {
      commandId: 'sel-1',
      objectId: 'obj-1',
      source: 'MODULE_SELECTION_UI',
    };

    eventBus.emit('ui:selection-command', cmd);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(cmd);
  });

  it('should route transform commands', () => {
    const handler = vi.fn();
    router.onTransform(handler);

    const cmd: TransformCommand = {
      commandId: 't-1',
      source: 'INSPECTOR',
      objectId: 'obj-1',
      operation: 'SET',
      property: 'POSITION',
      values: { x: 5, y: 0, z: 0 },
      history: 'RECORD',
    };

    eventBus.emit('ui:transform-command', cmd);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(cmd);
  });

  it('should route viewport intents from UI', () => {
    const handler = vi.fn();
    router.onViewport(handler);

    const intent: ViewportIntent = {
      source: 'VIEWPORT_UI',
      action: 'PAN',
      deltaX: 10,
      deltaY: 0,
      phase: 'UPDATE',
      timestamp: 1000,
    };

    eventBus.emit('ui:viewport-intent', intent);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(intent);
  });

  it('should route viewport intents from CV', () => {
    const handler = vi.fn();
    router.onViewport(handler);

    const intent: ViewportIntent = {
      source: 'CV',
      action: 'ZOOM',
      zoomDelta: 5,
      phase: 'UPDATE',
      timestamp: 1000,
    };

    eventBus.emit('cv:viewport-intent', intent);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('should not route when no handler registered', () => {
    // Should not throw
    const cmd: SelectionCommand = {
      commandId: 'sel-1',
      objectId: 'obj-1',
      source: 'VIEWPORT',
    };

    expect(() => {
      eventBus.emit('ui:selection-command', cmd);
    }).not.toThrow();
  });

  it('should dispose handlers', () => {
    const handler = vi.fn();
    router.onSelection(handler);
    router.dispose();

    const cmd: SelectionCommand = {
      commandId: 'sel-1',
      objectId: 'obj-1',
      source: 'VIEWPORT',
    };

    eventBus.emit('ui:selection-command', cmd);

    expect(handler).not.toHaveBeenCalled();
  });
});
