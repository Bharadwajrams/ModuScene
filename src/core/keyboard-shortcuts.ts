/**
 * Module Builder — Keyboard Shortcuts
 *
 * App-level key bindings resolved as pure data, so the bootstrap keydown
 * handler stays a thin switch and the mapping itself is unit-testable.
 *
 * Source of truth: Doc 02 §4 (toolbar commands)
 */

export type AppShortcut = 'DUPLICATE';

/** The parts of a KeyboardEvent that a binding looks at. */
export interface ShortcutEventLike {
  key: string;
  code: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

/**
 * Resolve an application shortcut from a keydown, or null when the event does
 * not belong to the application.
 *
 *   Shift + D → DUPLICATE (same code path as the toolbar button)
 *
 * Plain `d` / `D` keeps its existing +X movement nudge — only the shifted form
 * is claimed. Ctrl / Cmd / Alt combinations are never claimed, so browser and
 * OS shortcuts keep working.
 *
 * Auto-repeat is deliberately NOT filtered here: the caller must still claim a
 * repeated keydown (otherwise the held keys would fall through to the movement
 * nudge) and check `event.repeat` before running the command.
 */
export function resolveAppShortcut(event: ShortcutEventLike): AppShortcut | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  if (!event.shiftKey) return null;

  // Bind the physical D key so the shortcut survives Shift changing the
  // reported character; accept `key` too for synthetic events without a code.
  const isD = event.code === 'KeyD' || event.key === 'D' || event.key === 'd';
  return isD ? 'DUPLICATE' : null;
}
