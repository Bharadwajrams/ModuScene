/**
 * Module Builder V1.1 — Command Router
 *
 * Routes commands from UI and CV to the appropriate engine authority.
 * The 3D Engine executes transforms and selection changes.
 * The Core layer coordinates but does NOT duplicate state.
 *
 * Source of truth: Doc 04 §7, Doc 05 §12
 */

import type {
  SelectionCommand,
  TransformCommand,
  ViewportIntent,
} from './contracts';
import { EventBus } from './event-bus';

// ─── Command Handler Types ────────────────────────────────

export type SelectionHandler = (cmd: SelectionCommand) => void;
export type TransformHandler = (cmd: TransformCommand) => void;
export type ViewportHandler = (intent: ViewportIntent) => void;

// ─── Command Router ──────────────────────────────────────

export class CommandRouter {
  private eventBus: EventBus;
  private selectionHandler: SelectionHandler | null = null;
  private transformHandler: TransformHandler | null = null;
  private viewportHandler: ViewportHandler | null = null;

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    // Route UI selection commands
    this.eventBus.on('ui:selection-command', (cmd) => {
      if (this.selectionHandler) {
        this.selectionHandler(cmd);
      }
    });

    // Route UI transform commands
    this.eventBus.on('ui:transform-command', (cmd) => {
      if (this.transformHandler) {
        this.transformHandler(cmd);
      }
    });

    // Route UI viewport intents
    this.eventBus.on('ui:viewport-intent', (intent) => {
      if (this.viewportHandler) {
        this.viewportHandler(intent);
      }
    });

    // Route CV viewport intents
    this.eventBus.on('cv:viewport-intent', (intent) => {
      if (this.viewportHandler) {
        this.viewportHandler(intent);
      }
    });
  }

  /** Register the 3D Engine's selection handler */
  onSelection(handler: SelectionHandler): void {
    this.selectionHandler = handler;
  }

  /** Register the 3D Engine's transform handler */
  onTransform(handler: TransformHandler): void {
    this.transformHandler = handler;
  }

  /** Register the 3D Engine's viewport handler */
  onViewport(handler: ViewportHandler): void {
    this.viewportHandler = handler;
  }

  /** Clean up */
  dispose(): void {
    this.selectionHandler = null;
    this.transformHandler = null;
    this.viewportHandler = null;
  }
}
