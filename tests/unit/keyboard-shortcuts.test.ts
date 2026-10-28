/**
 * Keyboard shortcut resolution — Shift+D → Duplicate
 *
 * The bootstrap keydown handler in src/main.ts is a thin switch over
 * `resolveAppShortcut()`; these tests pin the mapping itself:
 *   - Shift+D duplicates, whether the event carries `code` or only `key`
 *   - plain d / D keeps its existing +X movement behaviour (null here)
 *   - browser/OS modifier combinations are never claimed
 */

import { describe, it, expect } from 'vitest';
import { resolveAppShortcut, type ShortcutEventLike } from '../../src/core/keyboard-shortcuts';

const key = (overrides: Partial<ShortcutEventLike> = {}): ShortcutEventLike => ({
  key: '',
  code: '',
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...overrides,
});

describe('resolveAppShortcut — Shift+D', () => {
  it('resolves Shift+D to DUPLICATE', () => {
    expect(resolveAppShortcut(key({ key: 'D', code: 'KeyD', shiftKey: true }))).toBe('DUPLICATE');
  });

  it('binds the physical D key even when the character is reported lower-case', () => {
    // Caps Lock + Shift reports 'd' on some layouts
    expect(resolveAppShortcut(key({ key: 'd', code: 'KeyD', shiftKey: true }))).toBe('DUPLICATE');
  });

  it('still resolves when the event carries no code (synthetic events)', () => {
    expect(resolveAppShortcut(key({ key: 'D', shiftKey: true }))).toBe('DUPLICATE');
  });

  it('does not claim plain D — that stays the +X movement nudge', () => {
    expect(resolveAppShortcut(key({ key: 'd', code: 'KeyD' }))).toBeNull();
  });

  it('does not claim unshifted upper-case D (Caps Lock) either', () => {
    expect(resolveAppShortcut(key({ key: 'D', code: 'KeyD' }))).toBeNull();
  });
});

describe('resolveAppShortcut — other keys', () => {
  it('ignores Shift + WASD letters that are not D', () => {
    for (const letter of ['W', 'A', 'S', 'F', 'E']) {
      expect(resolveAppShortcut(key({ key: letter, code: `Key${letter}`, shiftKey: true }))).toBeNull();
    }
  });

  it('ignores Shift + non-letter keys', () => {
    for (const [k, code] of [
      ['Delete', 'Delete'],
      ['ArrowUp', 'ArrowUp'],
      ['1', 'Digit1'],
      [' ', 'Space'],
    ]) {
      expect(resolveAppShortcut(key({ key: k, code, shiftKey: true }))).toBeNull();
    }
  });
});

describe('resolveAppShortcut — never steals browser shortcuts', () => {
  it('ignores Ctrl/Cmd/Alt combinations', () => {
    expect(resolveAppShortcut(key({ key: 'D', code: 'KeyD', shiftKey: true, ctrlKey: true }))).toBeNull();
    expect(resolveAppShortcut(key({ key: 'D', code: 'KeyD', shiftKey: true, metaKey: true }))).toBeNull();
    expect(resolveAppShortcut(key({ key: 'D', code: 'KeyD', shiftKey: true, altKey: true }))).toBeNull();
  });

  it('leaves plain modifiers-only events alone', () => {
    expect(resolveAppShortcut(key({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }))).toBeNull();
  });
});
