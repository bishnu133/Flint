import { describe, it, expect } from 'vitest';
import { divertDeadlockAdvice } from './divert-deadlock.js';
import type { WriteDecision } from './writer.js';

/**
 * The failure this exists for repeats identically on every run, so the only
 * thing that can end it is the message. These check that the message appears
 * when it should, stays quiet when it should not, and names both files.
 */

function decision(partial: Partial<WriteDecision>): WriteDecision {
  return {
    path: 'pages/home.page.ts',
    targetPath: 'pages/home.page.ts',
    outcome: 'updated',
    contents: '',
    ...partial,
  };
}

const diverted = decision({
  path: 'pages/inventory-html.page.ts',
  targetPath: 'pages/inventory-html.page.flint.ts',
  outcome: 'diverted',
  reason: 'the generated file has been edited by hand',
});

const memberError =
  "tests/cart.spec.ts(14,22): error TS2551: Property 'addToCartButton2' does not exist on type 'InventoryHtmlPage'.";

describe('divertDeadlockAdvice', () => {
  it('says nothing when the run diverted nothing', () => {
    expect(
      divertDeadlockAdvice({
        decisions: [decision({}), decision({ outcome: 'created' })],
        errors: [memberError],
        suiteDir: 'e2e',
      }),
    ).toEqual([]);
  });

  it('says nothing when there are no gate errors and nothing diverted', () => {
    expect(divertDeadlockAdvice({ decisions: [], errors: [], suiteDir: 'e2e' })).toEqual([]);
  });

  it('names both files and the two ways out', () => {
    const lines = divertDeadlockAdvice({
      decisions: [decision({}), diverted],
      errors: [memberError],
      suiteDir: 'e2e',
    }).join('\n');

    expect(lines).toContain('e2e/pages/inventory-html.page.ts');
    expect(lines).toContain('e2e/pages/inventory-html.page.flint.ts');
    expect(lines).toContain('Merge what you want from the .flint.ts copy');
    expect(lines).toContain(
      'rm e2e/pages/inventory-html.page.ts e2e/pages/inventory-html.page.flint.ts',
    );
  });

  it('is confident when tsc reports a missing member — the divergence signature', () => {
    const lines = divertDeadlockAdvice({
      decisions: [diverted],
      errors: [memberError],
      suiteDir: 'e2e',
    }).join('\n');
    expect(lines).toContain('That is this run colliding with your edits');
    expect(lines).not.toContain('which may be why');
  });

  it('hedges when the errors are some other kind of breakage', () => {
    // A syntax error would fail whether anything was diverted or not; claiming
    // the divert caused it would send someone down the wrong path.
    const lines = divertDeadlockAdvice({
      decisions: [diverted],
      errors: ["tests/cart.spec.ts(3,1): error TS1005: ';' expected."],
      suiteDir: 'e2e',
    }).join('\n');
    expect(lines).toContain('which may be why');
    expect(lines).not.toContain('That is this run colliding');
  });

  it('lists every diverted file, not just the first', () => {
    const second = decision({
      path: 'pages/cart.page.ts',
      targetPath: 'pages/cart.page.flint.ts',
      outcome: 'diverted',
    });
    const lines = divertDeadlockAdvice({
      decisions: [diverted, second],
      errors: [memberError],
      suiteDir: 'e2e',
    }).join('\n');
    expect(lines).toContain('e2e/pages/inventory-html.page.ts');
    expect(lines).toContain('e2e/pages/cart.page.ts');
  });
});
