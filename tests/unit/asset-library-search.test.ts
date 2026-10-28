/**
 * Asset Library search — unit tests
 *
 * Guards the Asset Bar search field: case-insensitive partial matching on the
 * displayed module name, live filtering, the no-results message, and the fact
 * that filtering is a pure view concern (no scene/selection/add side effects).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EventBus } from '../../src/core/event-bus';
import { AssetLibrary, filterAssets } from '../../src/engine-ui/asset-library';
import type { AssetRecord, AssetId } from '../../src/core/contracts';

function asset(
  name: string,
  sourceType: AssetRecord['sourceType'] = 'GLB',
): AssetRecord {
  return {
    assetId: `asset-${name}` as AssetId,
    name,
    sourcePath: sourceType === 'PRIMITIVE' ? undefined : `${name}.glb`,
    sourceType,
    textureStatus: sourceType === 'PRIMITIVE' ? 'NOT_APPLICABLE' : 'EMBEDDED',
    loadStatus: 'AVAILABLE',
  };
}

const CATALOG: AssetRecord[] = [
  asset('Ground_Tile'),
  asset('Group_House'),
  asset('Stone_Ground'),
  asset('Chair'),
  asset('Cube', 'PRIMITIVE'),
];

/** Render order: the Basic Shapes section paints above the imports. */
const RENDERED = ['Cube', 'Ground_Tile', 'Group_House', 'Stone_Ground', 'Chair'];

function names(assets: AssetRecord[]): string[] {
  return assets.map((a) => a.name);
}

describe('filterAssets', () => {
  it('matches a partial query anywhere in the name', () => {
    expect(names(filterAssets(CATALOG, 'Grou'))).toEqual([
      'Ground_Tile',
      'Group_House',
      'Stone_Ground',
    ]);
  });

  it('is case-insensitive in both directions', () => {
    const lower = names(filterAssets(CATALOG, 'grou'));
    const upper = names(filterAssets(CATALOG, 'GROU'));
    expect(lower).toEqual(['Ground_Tile', 'Group_House', 'Stone_Ground']);
    expect(upper).toEqual(lower);
  });

  it('returns every match and excludes non-matching assets', () => {
    const result = names(filterAssets(CATALOG, 'grou'));
    expect(result).toHaveLength(3);
    expect(result).not.toContain('Chair');
    expect(result).not.toContain('Cube');
  });

  it('does not require the file extension in the query', () => {
    // The displayed name already has `.glb` stripped by the importer.
    expect(names(filterAssets(CATALOG, 'Ground_Tile'))).toEqual(['Ground_Tile']);
    expect(names(filterAssets(CATALOG, 'ground_tile.glb'))).toEqual([]);
  });

  it('preserves catalog order for multiple matches', () => {
    expect(names(filterAssets(CATALOG, 'e'))).toEqual(
      CATALOG.filter((a) => a.name.toLowerCase().includes('e')).map((a) => a.name),
    );
  });

  it('treats empty and whitespace-only queries as "no filter"', () => {
    expect(filterAssets(CATALOG, '')).toHaveLength(CATALOG.length);
    expect(filterAssets(CATALOG, '   ')).toHaveLength(CATALOG.length);
    expect(filterAssets(CATALOG, '\t\n ')).toHaveLength(CATALOG.length);
  });

  it('trims the query before matching', () => {
    expect(names(filterAssets(CATALOG, '  Chair  '))).toEqual(['Chair']);
  });

  it('returns no assets when nothing matches', () => {
    expect(filterAssets(CATALOG, 'zzz')).toEqual([]);
  });
});

describe('AssetLibrary search field', () => {
  let container: HTMLElement;
  let library: AssetLibrary;

  function searchInput(): HTMLInputElement {
    const input = container.querySelector('.asset-library-panel__search');
    expect(input).toBeInstanceOf(HTMLInputElement);
    return input as HTMLInputElement;
  }

  function type(value: string): void {
    const input = searchInput();
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }

  function rowNames(): string[] {
    return Array.from(container.querySelectorAll('.asset-library-panel__name')).map(
      (el) => el.textContent ?? '',
    );
  }

  function visible(el: Element | null): boolean {
    return !!el && (el as HTMLElement).style.display !== 'none';
  }

  beforeEach(() => {
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.appendChild(container);
    library = new AssetLibrary(new EventBus(), container);
    library.refresh(CATALOG.map((a) => ({ ...a })));
  });

  it('renders a compact search input above the asset list', () => {
    const input = searchInput();
    expect(input.placeholder).toBe('Search assets...');
    expect(input.getAttribute('aria-label')).toBe('Search assets');
    // Above the list in document order.
    const first = container.firstElementChild;
    expect(first).toBe(input);
  });

  it('filters live as the user types, without a submit action', () => {
    type('grou');
    expect(rowNames()).toEqual(['Ground_Tile', 'Group_House', 'Stone_Ground']);
  });

  it('narrows further and widens again as the query changes', () => {
    type('grou');
    type('group_h');
    expect(rowNames()).toEqual(['Group_House']);
    type('grou');
    expect(rowNames()).toHaveLength(3);
  });

  it('restores the full list when the query is cleared', () => {
    type('grou');
    type('');
    expect(rowNames()).toEqual(RENDERED);
  });

  it('shows every asset for a whitespace-only query', () => {
    type('    ');
    expect(rowNames()).toEqual(RENDERED);
  });

  it('shows a friendly message instead of the list when nothing matches', () => {
    type('zzz');
    const noResults = container.querySelector('.asset-library-panel__empty:last-child');
    expect(noResults?.textContent).toBe('No matching assets found');
    expect(visible(noResults)).toBe(true);
    expect(rowNames()).toEqual([]);
    const list = container.querySelector('.asset-library-panel__list');
    expect((list as HTMLElement).style.display).toBe('none');

    // Clearing the query brings the list back and hides the message.
    type('');
    expect(visible(noResults)).toBe(false);
    expect((list as HTMLElement).style.display).toBe('flex');
  });

  it('keeps the Basic Shapes / Imported sections for the filtered set', () => {
    type('c');
    const sections = Array.from(
      container.querySelectorAll('.asset-library-panel__section'),
    ).map((el) => el.textContent);
    expect(sections).toEqual(['Basic Shapes', 'Imported']);
    expect(rowNames()).toEqual(['Cube', 'Chair']);

    // A query that only hits imported assets drops the empty shape section.
    type('grou');
    expect(
      Array.from(container.querySelectorAll('.asset-library-panel__section')).map(
        (el) => el.textContent,
      ),
    ).toEqual(['Imported']);
  });

  it('adds a filtered asset through the existing add workflow', () => {
    const added: string[] = [];
    library.onAdd((assetId) => added.push(assetId));
    type('chair');
    const addBtn = container.querySelector(
      '.asset-library-panel__add',
    ) as HTMLButtonElement;
    addBtn.click();
    expect(added).toEqual(['asset-Chair']);
  });

  it('does not add, select or mutate anything just by filtering', () => {
    const added: string[] = [];
    library.onAdd((assetId) => added.push(assetId));
    type('grou');
    type('nope');
    type('');
    expect(added).toEqual([]);
    expect(CATALOG.map((a) => a.name)).toEqual([
      'Ground_Tile',
      'Group_House',
      'Stone_Ground',
      'Chair',
      'Cube',
    ]);
  });
});

describe('search with a large catalog', () => {
  it('filters ~3,000 names quickly and still renders the matches', () => {
    const big: AssetRecord[] = Array.from({ length: 3000 }, (_, i) =>
      asset(i % 3 === 0 ? `Ground_${i}` : `Prop_${i}`),
    );

    const start = performance.now();
    const matches = filterAssets(big, 'grou');
    const elapsed = performance.now() - start;

    expect(matches).toHaveLength(1000);
    // Pure substring scan over an in-memory list: no model is loaded.
    expect(elapsed).toBeLessThan(50);

    document.body.innerHTML = '';
    const container = document.createElement('div');
    document.body.appendChild(container);
    const library = new AssetLibrary(new EventBus(), container);
    library.refresh(big);

    const input = container.querySelector(
      '.asset-library-panel__search',
    ) as HTMLInputElement;
    const t0 = performance.now();
    input.value = 'Ground_2997';
    input.dispatchEvent(new Event('input'));
    const renderMs = performance.now() - t0;

    const rows = Array.from(
      container.querySelectorAll('.asset-library-panel__name'),
    ).map((el) => el.textContent);
    expect(rows).toEqual(['Ground_2997']);
    // Narrow queries render one row; the scan, not the paint, is the cost.
    expect(renderMs).toBeLessThan(200);
  });
});
