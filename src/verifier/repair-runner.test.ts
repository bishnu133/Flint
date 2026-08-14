import { describe, it, expect } from 'vitest';
import { classify, withMarker } from '../indexer/managed.js';
import { restamp } from './repair-runner.js';

/**
 * The regression these guard is worth stating plainly, because it cost two full
 * pipeline runs before anyone understood it.
 *
 * Repair rewrites page objects and specs in place. It used to write them with a
 * plain `writeFileSync`, leaving the `@flint:managed` marker describing the
 * *pre-repair* content. The next `flint ci` therefore read Flint's own repaired
 * output as a human's edit: it diverted the file to `*.flint.ts`, generated
 * specs against its own version, typechecked them against the repaired one, and
 * failed the compile gate — identically, forever. The operator was told they had
 * edited a file they had never opened.
 *
 * The ninth instance of this project's recurring class: Flint reading its own
 * previous output as somebody else's input.
 */

const GENERATED = `export class InventoryPage {
  readonly addToCartButton = this.page.locator('[data-test="add-to-cart-bike-light"]');
}
`;

/** What the selector retry does: swap one locator for a verified alternative. */
const REPAIRED = GENERATED.replace('bike-light', 'backpack');

describe('restamp', () => {
  it('leaves a repaired managed file still managed', () => {
    const onDisk = withMarker(GENERATED);
    expect(classify(onDisk).status).toBe('managed');

    // Repair edits the content it read, marker line and all.
    const afterRepair = restamp(onDisk.replace('bike-light', 'backpack'));

    expect(classify(afterRepair).status).toBe('managed');
    expect(afterRepair).toContain('backpack');
  });

  it('without it, a repaired file reads as hand-edited — the actual bug', () => {
    // Sanity check on the mechanism itself, so this test still means something
    // if `classify` ever changes.
    const notRestamped = withMarker(GENERATED).replace('bike-light', 'backpack');
    expect(classify(notRestamped).status).toBe('hand-edited');
  });

  it('produces the same bytes as a fresh generation of the repaired content', () => {
    // Determinism: a repaired file and a regenerated one must be identical, or
    // the next run rewrites it for no reason and the diff is noise.
    expect(restamp(withMarker(GENERATED).replace('bike-light', 'backpack'))).toBe(
      withMarker(REPAIRED),
    );
  });

  it('never adopts a hand-written file', () => {
    // Repair is allowed to fix a page object Flint did not write. It is not
    // allowed to claim ownership of one — stamping a marker here would let a
    // later run overwrite somebody's own code without warning.
    const handWritten = 'export class MyPage {}\n';
    expect(restamp(handWritten)).toBe(handWritten);
    expect(classify(restamp(handWritten)).status).toBe('hand-written');
  });

  it('is idempotent', () => {
    const once = restamp(withMarker(GENERATED));
    expect(restamp(once)).toBe(once);
  });

  it('does not accumulate markers', () => {
    const twice = restamp(restamp(withMarker(GENERATED)));
    expect(twice.match(/@flint:managed/g)).toHaveLength(1);
  });
});
