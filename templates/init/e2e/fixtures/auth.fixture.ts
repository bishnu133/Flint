import { test as base } from '@playwright/test';

/**
 * Auth fixture stub.
 *
 * Phase 1 wires this to your `flint.config.ts` auth mode (storageState /
 * loginScript / credentials). For now it is a pass-through so the suite compiles.
 */
export const test = base.extend({
  // Example (uncomment once you have a storageState file):
  // storageState: async ({}, use) => {
  //   await use('.auth/user.json');
  // },
});

export { expect } from '@playwright/test';
