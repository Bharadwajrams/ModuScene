/**
 * Module Builder V1.2 — CV Gesture Instruction Bar
 *
 * One slim, translucent strip along the bottom of the CV workspace that states
 * the controls the engine already implements. Presentation ONLY:
 *
 *   - no listeners, no state, no CV access — it explains, never controls
 *   - `pointer-events: none` (set in CSS) so it can never intercept the mouse
 *     or the CV pointer's tab/panel/row hit-testing
 *   - it lives inside the CV region, so the existing CV open/close visibility
 *     (AppShell hides that region) applies to it automatically
 *
 * Labels mirror the current gesture semantics (verified against
 * interaction-controller.ts): right-hand GRAB → Move, OPEN_PALM → Rotate,
 * SCALE_POSE ("OK") → Scale; left-hand OPEN_PALM pauses and its release
 * resumes/re-anchors (it is not a session lock).
 *
 * Pictograms are inline line-art SVG — deliberately no emoji characters.
 */

// ─── SVG icons (24×24 line art, currentColor) ─────────────

const SVG_ATTRS =
  'viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" ' +
  'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" ' +
  'aria-hidden="true" focusable="false"';

/** Open palm (the right-hand ROTATE pose). */
const ICON_PALM = `
<svg class="cv-gesture-bar__icon" ${SVG_ATTRS}>
  <path d="M8 12.5V6.6a1.4 1.4 0 0 1 2.8 0v5.9"/>
  <path d="M10.8 12.4V5.2a1.4 1.4 0 0 1 2.8 0v7.2"/>
  <path d="M13.6 12.4V6.8a1.4 1.4 0 0 1 2.8 0v5.6"/>
  <path d="M16.4 9.6a1.4 1.4 0 0 1 2.8 0v5.1a6 6 0 0 1-6 6h-1.4a5 5 0 0 1-4.1-2.1l-2.3-3.4a1.5 1.5 0 0 1 2.4-1.7l1.2 1.4"/>
</svg>`;

/** Closed fist (the right-hand MOVE pose). */
const ICON_FIST = `
<svg class="cv-gesture-bar__icon" ${SVG_ATTRS}>
  <path d="M5.6 12.8V10a3.2 3.2 0 0 1 3.2-3.2h6.4A3.2 3.2 0 0 1 18.4 10v2.8a4.8 4.8 0 0 1-4.8 4.8h-3.2a4.8 4.8 0 0 1-4.8-4.8Z"/>
  <path d="M9 6.9v6.4M12 6.9v6.4M15 6.9v6.4"/>
</svg>`;

/** OK pose — thumb and index joined, three fingers extended (SCALE). */
const ICON_OK = `
<svg class="cv-gesture-bar__icon" ${SVG_ATTRS}>
  <circle cx="9.4" cy="12.6" r="3.3"/>
  <path d="M12.7 9.6V5.6a1.4 1.4 0 0 1 2.8 0v5"/>
  <path d="M15.5 9.4a1.4 1.4 0 0 1 2.8 0v3.4a5.4 5.4 0 0 1-5.4 5.4h-1a5.4 5.4 0 0 1-3.9-1.7"/>
</svg>`;

/** Left-hand open palm with pause bars (pause / resume). */
const ICON_PAUSE = `
<svg class="cv-gesture-bar__icon" ${SVG_ATTRS}>
  <g transform="translate(-2.6 0.6) scale(0.74)">
    <path d="M8 12.5V6.6a1.4 1.4 0 0 1 2.8 0v5.9"/>
    <path d="M10.8 12.4V5.2a1.4 1.4 0 0 1 2.8 0v7.2"/>
    <path d="M13.6 12.4V6.8a1.4 1.4 0 0 1 2.8 0v5.6"/>
    <path d="M16.4 9.6a1.4 1.4 0 0 1 2.8 0v5.1a6 6 0 0 1-6 6h-1.4a5 5 0 0 1-4.1-2.1l-2.3-3.4a1.5 1.5 0 0 1 2.4-1.7l1.2 1.4"/>
  </g>
  <path class="cv-gesture-bar__icon-accent" d="M19.4 8.6v6.6M22 8.6v6.6"/>
</svg>`;

// ─── Builder ─────────────────────────────────────────────

interface GuideItem {
  icon: string;
  label: string;
  hint: string;
  /** Accurate extra detail for the tooltip (not shown in the compact row). */
  title: string;
}

const LEFT_ITEMS: GuideItem[] = [
  {
    icon: ICON_PAUSE,
    label: 'Pause',
    hint: 'left palm',
    title: 'Left hand open palm holds the active transformation; release to resume and re-anchor.',
  },
];

const RIGHT_ITEMS: GuideItem[] = [
  {
    icon: ICON_PALM,
    label: 'Rotate',
    hint: 'open palm',
    title: 'Right hand open palm → Rotate (hold ~1 s to switch mode).',
  },
  {
    icon: ICON_FIST,
    label: 'Move',
    hint: 'fist',
    title: 'Right hand fist / grab → Move (hold ~1 s to switch mode).',
  },
  {
    icon: ICON_OK,
    label: 'Scale',
    hint: 'OK sign',
    title: 'Right hand OK sign (thumb + index touching, three fingers extended) → Scale.',
  },
];

function createItem(item: GuideItem): HTMLElement {
  const el = document.createElement('span');
  el.className = 'cv-gesture-bar__item';
  el.title = item.title;

  const text = document.createElement('span');
  text.className = 'cv-gesture-bar__text';

  const label = document.createElement('span');
  label.className = 'cv-gesture-bar__label';
  label.textContent = item.label;

  const hint = document.createElement('span');
  hint.className = 'cv-gesture-bar__hint';
  hint.textContent = item.hint;

  text.appendChild(label);
  text.appendChild(hint);
  el.insertAdjacentHTML('beforeend', item.icon);
  el.appendChild(text);
  return el;
}

function createDivider(): HTMLElement {
  const divider = document.createElement('span');
  divider.className = 'cv-gesture-bar__divider';
  divider.setAttribute('aria-hidden', 'true');
  return divider;
}

/**
 * Build the CV gesture guide strip. Returned element is inert (no listeners);
 * the caller only mounts it inside the CV region.
 */
export function createGestureInstructionBar(): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'cv-gesture-bar';
  bar.setAttribute('role', 'note');
  bar.setAttribute('aria-label', 'Hand gesture guide');

  const left = document.createElement('span');
  left.className = 'cv-gesture-bar__group cv-gesture-bar__group--left';
  for (const item of LEFT_ITEMS) left.appendChild(createItem(item));

  const right = document.createElement('span');
  right.className = 'cv-gesture-bar__group';
  for (const item of RIGHT_ITEMS) right.appendChild(createItem(item));

  bar.appendChild(left);
  bar.appendChild(createDivider());
  bar.appendChild(right);

  return bar;
}
