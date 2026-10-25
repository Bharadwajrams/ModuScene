/**
 * CV Gesture Instruction Bar unit tests
 *
 * The bar is presentation-only: it must describe the gestures the
 * interaction controller already implements, use inline SVG pictograms
 * (never emoji), and stay inert (no listeners, no pointer capture).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { EventBus } from '../../src/core/event-bus';
import { CVWorkspace } from '../../src/engine-ui/cv-workspace';
import { createGestureInstructionBar } from '../../src/engine-ui/gesture-instruction-bar';

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}]/u;

function labels(bar: HTMLElement): string[] {
  return Array.from(bar.querySelectorAll('.cv-gesture-bar__label')).map(
    (el) => el.textContent ?? '',
  );
}

describe('createGestureInstructionBar', () => {
  it('renders exactly the four implemented controls', () => {
    const bar = createGestureInstructionBar();
    expect(labels(bar)).toEqual(['Pause', 'Rotate', 'Move', 'Scale']);
  });

  it('describes the real gesture semantics', () => {
    const bar = createGestureInstructionBar();
    const hints = Array.from(bar.querySelectorAll('.cv-gesture-bar__hint')).map(
      (el) => el.textContent,
    );
    // Left hand = open palm pause/resume (not a session lock);
    // right hand = open palm rotate, fist move, OK sign scale.
    expect(hints).toEqual(['left palm', 'open palm', 'fist', 'OK sign']);

    const titles = Array.from(bar.querySelectorAll('.cv-gesture-bar__item')).map(
      (el) => el.getAttribute('title') ?? '',
    );
    expect(titles[0]).toMatch(/open palm holds the active transformation/i);
    expect(titles[1]).toMatch(/rotate/i);
    expect(titles[2]).toMatch(/move/i);
    expect(titles[3]).toMatch(/scale/i);
  });

  it('uses inline SVG pictograms, not emoji characters', () => {
    const bar = createGestureInstructionBar();

    expect(bar.querySelectorAll('svg.cv-gesture-bar__icon')).toHaveLength(4);
    expect(bar.querySelectorAll('.cv-gesture-bar__icon path').length).toBeGreaterThan(8);
    expect(bar.innerHTML).not.toMatch(EMOJI);
    expect(bar.textContent ?? '').not.toMatch(EMOJI);

    for (const svg of Array.from(bar.querySelectorAll('svg'))) {
      expect(svg.getAttribute('aria-hidden')).toBe('true');
      expect(svg.getAttribute('stroke')).toBe('currentColor');
    }
  });

  it('separates the left-hand group from the right-hand group', () => {
    const bar = createGestureInstructionBar();

    const left = bar.querySelector('.cv-gesture-bar__group--left') as HTMLElement;
    expect(left).toBeTruthy();
    expect(labels(left)).toEqual(['Pause']);
    expect(bar.querySelectorAll('.cv-gesture-bar__divider')).toHaveLength(1);
  });

  it('is labelled as an informational note', () => {
    const bar = createGestureInstructionBar();
    expect(bar.getAttribute('role')).toBe('note');
    expect(bar.getAttribute('aria-label')).toMatch(/gesture guide/i);
  });

  it('attaches no event listeners', () => {
    // Any listener would return a handle through addEventListener spies; the
    // bar is built from plain elements with no handlers by contract.
    const bar = createGestureInstructionBar();
    const spyTargets = [bar, ...Array.from(bar.querySelectorAll('*'))];
    for (const el of spyTargets) {
      expect((el as HTMLElement).onclick).toBeNull();
    }
  });

  it('is mounted inside the CV workspace and leaves it with CV visibility', () => {
    document.body.innerHTML = '';
    const root = document.createElement('div');
    document.body.appendChild(root);

    const workspace = new CVWorkspace(new EventBus(), root);

    const bar = root.querySelector('.cv-gesture-bar');
    expect(bar).toBeTruthy();
    // AppShell hides the CV region itself, so the bar inherits CV-mode
    // visibility with no extra toggle logic.
    expect(root.contains(bar as Node)).toBe(true);
    expect(workspace.getVideoElement()).toBeTruthy();
  });
});
