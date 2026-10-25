/**
 * Module Builder V2.0 — Pointer Processor
 *
 * CV index-fingertip pointer → floating-UI interaction.
 *
 * Interaction model (per the V2.0 spec):
 *   - HOVER over tabs = immediate action (open the tab's panel instantly).
 *   - HOVER over a module row = highlight only.
 *   - HOLD the pointer over a module row ~1 second = select it
 *     (with a progress ring rendered by the workspace UI).
 *   - Leaving a tab/panel area collapses it again.
 *
 * Stability: jitter spikes reset dwell; the pointer going away cancels
 * hover + hold cleanly.
 */

import type { PointerState, PointerTarget, TimestampMs } from '../../core/contracts';

// ─── Configuration ───────────────────────────────────────

const HOLD_MS = 1000;       // Module-row selection hold (~1 s)
const JITTER_THRESHOLD = 0.045; // Normalized coordinates
const PROGRESS_EMIT_MS = 50;    // Progress-update throttle for the ring

// ─── Pointer Processor ──────────────────────────────────

interface HoverEvents {
  /** Immediate: pointer entered a tab (open its panel). */
  onTabEnter: (tabId: 'MODULE_SELECTION' | 'VIEWPORT_CONTROL') => void;
  /** Immediate: pointer left a tab/panel area (collapse panels). */
  onTabLeave: (tabId: 'MODULE_SELECTION' | 'VIEWPORT_CONTROL' | null) => void;
  /** Hover highlight for module rows. */
  onModuleHover: (objectId: string | null) => void;
  /** 1-second hold satisfied → select the module. */
  onModuleSelect: (objectId: string) => void;
  /** Hold progress 0..1 for the active hold ring (throttled). */
  onModuleHoldProgress: (objectId: string, progress: number) => void;
}

export class PointerProcessor {
  private targets: PointerTarget[] = [];
  private hoverTabId: 'MODULE_SELECTION' | 'VIEWPORT_CONTROL' | null = null;
  private hoverModuleId: string | null = null;
  private holdTargetId: string | null = null;
  private holdStart: TimestampMs | null = null;
  private holdFired = false;
  private lastProgressEmit = 0;
  private lastPointerPos = { x: 0, y: 0 };

  private events: HoverEvents | null = null;

  /** Register UI targets for hit-testing. */
  setTargets(targets: PointerTarget[]): void {
    this.targets = targets;
  }

  /** Register interaction callbacks. */
  setEventHandlers(events: HoverEvents): void {
    this.events = events;
  }

  /** Process a pointer state update. */
  processPointer(pointer: PointerState | null, now: TimestampMs): void {
    if (!pointer || !pointer.active) {
      this.clearAll();
      return;
    }

    const { x, y } = pointer;

    // Jitter guard: a large jump cancels any active hold (can't be intentional).
    const dx = Math.abs(x - this.lastPointerPos.x);
    const dy = Math.abs(y - this.lastPointerPos.y);
    if (dx > JITTER_THRESHOLD || dy > JITTER_THRESHOLD) {
      this.cancelHold();
    }
    this.lastPointerPos = { x, y };

    // Hit-test against registered targets (tabs + panels + module rows).
    const hit = this.hitTest(x, y);

    // ── Context area = tab OR its open panel OR its module rows ──
    // While the pointer is anywhere inside the tab, its panel, or a module
    // row, that context stays open. The panel only collapses when the
    // pointer exits ALL of them — so moving tab → rows never closes the
    // list mid-navigation.
    const hitTab =
      hit?.type === 'tab'
        ? hit.id === 'tab:MODULE_SELECTION'
          ? 'MODULE_SELECTION'
          : 'VIEWPORT_CONTROL'
        : hit?.type === 'panel'
          ? hit.id === 'panel:MODULE_SELECTION'
            ? 'MODULE_SELECTION'
            : 'VIEWPORT_CONTROL'
          : hit?.type === 'module-row'
            // Rows only exist inside the module-selection panel.
            ? 'MODULE_SELECTION'
            : null;
    if (hitTab !== this.hoverTabId) {
      const prevTab = this.hoverTabId;
      this.hoverTabId = hitTab;
      if (hitTab && this.events) this.events.onTabEnter(hitTab);
      if (!hitTab && prevTab && this.events) this.events.onTabLeave(null);
    }

    // ── Module row hover / hold ──────────────────────────
    const hitModule = hit?.type === 'module-row'
      ? hit.id.replace('module:', '')
      : null;

    if (hitModule !== this.hoverModuleId) {
      // Target changed — cancel any hold, update highlight.
      this.cancelHold();
      const prev = this.hoverModuleId;
      this.hoverModuleId = hitModule;
      if (this.events) this.events.onModuleHover(hitModule);
      void prev;
    }

    if (hitModule) {
      if (this.holdTargetId !== hitModule) {
        // Start a fresh hold.
        this.holdTargetId = hitModule;
        this.holdStart = now;
        this.holdFired = false;
      } else if (!this.holdFired && this.holdStart !== null) {
        const held = now - this.holdStart;
        if (held >= HOLD_MS) {
          this.holdFired = true;
          if (this.events) this.events.onModuleSelect(hitModule);
          if (this.events) this.events.onModuleHoldProgress(hitModule, 1);
        } else if (now - this.lastProgressEmit >= PROGRESS_EMIT_MS && this.events) {
          this.lastProgressEmit = now;
          this.events.onModuleHoldProgress(hitModule, held / HOLD_MS);
        }
      }
    } else if (this.holdTargetId !== null) {
      this.cancelHold();
    }

    // ── Leaving the tab/panel area collapses open panels ──
    // (Handled above via hitTab transitions; nothing extra needed.)
  }

  /** Hit-test a point against registered targets.
   * Priority: module rows (most specific, inside panels) > tabs > panels,
   * so a row inside its panel is always reported as the row. */
  private hitTest(x: number, y: number): PointerTarget | null {
    let row: PointerTarget | null = null;
    let tab: PointerTarget | null = null;
    let panel: PointerTarget | null = null;
    for (const target of this.targets) {
      if (
        x >= target.x &&
        x <= target.x + target.width &&
        y >= target.y &&
        y <= target.y + target.height
      ) {
        if (target.type === 'module-row' && !row) row = target;
        else if (target.type === 'tab' && !tab) tab = target;
        else if (target.type === 'panel' && !panel) panel = target;
      }
    }
    return row ?? tab ?? panel;
  }

  private cancelHold(): void {
    this.holdTargetId = null;
    this.holdStart = null;
    this.holdFired = false;
  }

  /** Clear all hover/hold state (pointer gone). */
  private clearAll(): void {
    if (this.hoverTabId !== null && this.events) {
      this.events.onTabLeave(null);
    }
    this.hoverTabId = null;
    if (this.hoverModuleId !== null && this.events) {
      this.events.onModuleHover(null);
    }
    this.hoverModuleId = null;
    this.cancelHold();
  }

  /** Current hover target ids (for testing). */
  get hoverTab(): 'MODULE_SELECTION' | 'VIEWPORT_CONTROL' | null {
    return this.hoverTabId;
  }

  get hoverModule(): string | null {
    return this.hoverModuleId;
  }

  /** Reset state. */
  reset(): void {
    this.clearAll();
    this.lastPointerPos = { x: 0, y: 0 };
  }
}
