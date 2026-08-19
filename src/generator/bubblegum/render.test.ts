import { describe, it, expect } from 'vitest';
import type { BubblegumSuite } from './suite.js';
import { dataKey, renderSuite } from './render.js';

/**
 * Every shape asserted here comes from the target suite's own files. A generated
 * test that imports `{ act } from '../helpers/bubblegum'` when the project's
 * helper is `'../helpers/actions'` is broken in a way no other test would catch.
 */

const SUITE: BubblegumSuite = {
  featureId: 'vendor-admin-view-facilitators',
  title: 'Vendor Admin facilitator listing',
  baseUrl: 'https://portal.test/web/h365-portal',
  flows: [
    {
      name: 'openListingFlow',
      caseId: 'open-listing',
      summary: 'Vendor Admin opens the Facilitator listing',
      steps: [
        { kind: 'act', text: 'Click the Facilitators tab', elementId: 'el-tab', label: 'Facilitators' },
        {
          kind: 'act',
          text: 'Enter "Avenger" into Search Name',
          elementId: 'el-search',
          value: 'Avenger',
          label: 'Search Name',
        },
      ],
    },
  ],
  tests: [
    {
      caseId: 'open-listing',
      title: 'Vendor Admin opens the Facilitator listing',
      tags: ['@flint'],
      mode: { kind: 'live' },
      goto: ['https://portal.test/web/h365-portal/facilitators/list'],
      reuse: [
        {
          flowId: 'login.loginFlow',
          exportName: 'loginFlow',
          importPath: 'flows/login.flow.ts',
          args: ['getBAPActivityVendorAdminUserCredentials()'],
        },
      ],
      flow: 'openListingFlow',
      checks: [
        { kind: 'verify', text: 'the "Download as CSV" button is present', elementId: 'el-csv' },
      ],
      notes: ['The plan does not sign in, so the session comes from `login.loginFlow`.'],
    },
  ],
  credentialImports: [
    { getter: 'getBAPActivityVendorAdminUserCredentials', importPath: 'packages/data/BAP.ts' },
  ],
};

const WITH_CONSTANT: BubblegumSuite = {
  ...SUITE,
  baseUrlConstant: {
    name: 'initialApplicationUri',
    importPath: 'packages/utilities/constants/url.ts',
  },
};

const render = (suite: BubblegumSuite = SUITE) => {
  const files = renderSuite(suite);
  const find = (suffix: string) => files.find((f) => f.path.endsWith(suffix))!;
  return {
    files,
    data: find('.data.ts'),
    flow: find('.flow.ts'),
    test: find('.test.mts'),
  };
};

describe('the four-layer layout', () => {
  it('writes data, flow and test into the directories the suite uses', () => {
    expect(render().files.map((f) => f.path)).toEqual([
      'data/vendor-admin-view-facilitators.data.ts',
      'flows/vendor-admin-view-facilitators.flow.ts',
      'tests/vendor-admin-view-facilitators.test.mts',
    ]);
  });

  it('writes no data file when nothing is typed or chosen', () => {
    const bare: BubblegumSuite = {
      ...SUITE,
      flows: [{ ...SUITE.flows[0]!, steps: [SUITE.flows[0]!.steps[0]!] }],
    };
    expect(renderSuite(bare).map((f) => f.path)).not.toContain(
      'data/vendor-admin-view-facilitators.data.ts',
    );
  });
});

describe('the flow file', () => {
  it('imports act from the helper the suite actually has', () => {
    expect(render().flow.contents).toContain(
      "import { act, getRunConsole } from '../helpers/actions';",
    );
  });

  it('labels the steps with a section, the way the suite does', () => {
    // The console banner and the HTML report both key off it, so a generated
    // flow without sections reads as one undifferentiated list beside
    // hand-written ones that group their steps.
    expect(render().flow.contents).toContain(
      "getRunConsole()?.section('Vendor Admin opens the Facilitator listing');",
    );
  });

  it('types the parameters the way every flow in the suite does', () => {
    const { contents } = render().flow;
    expect(contents).toContain("import type { Bubblegum } from '@bubblegum-ai/node';");
    expect(contents).toContain(
      'export async function openListingFlow(engine: Bubblegum, page: Page): Promise<void> {',
    );
  });

  it('calls act with the engine and the sentence, not the page', () => {
    // `act(engine, phrase)`. Passing `page` would be a plausible signature and
    // the wrong one.
    expect(render().flow.contents).toContain("await act(engine, 'Click the Facilitators tab');");
  });

  it('interpolates a value out of the data file, as the suite does', () => {
    expect(render().flow.contents).toContain(
      'await act(engine, `Enter "${VendorAdminViewFacilitatorsData.searchName}" into Search Name`);',
    );
  });

  it('asserts nothing — flows drive, tests assert', () => {
    expect(render().flow.contents).not.toContain('verify(');
  });
});

describe('the data file', () => {
  it('exports a plain const object keyed by what the sentence calls the field', () => {
    expect(render().data.contents).toContain('export const VendorAdminViewFacilitatorsData = {');
    expect(render().data.contents).toContain("searchName: 'Avenger',");
  });
});

describe('the run command in the header', () => {
  // Not decoration: it is the command somebody copies. The first generated file
  // said `npx tsx src/smart-tests/tests/x.test.mts` for a suite four
  // directories further in, and the copied command failed with
  // ERR_MODULE_NOT_FOUND.
  it('names the path the file is actually written to', () => {
    const [, , test] = renderSuite(SUITE, { suiteDir: 'packages/web-tests/src/smart-tests' });
    expect(test!.contents).toContain(
      'Run:  npx tsx packages/web-tests/src/smart-tests/tests/vendor-admin-view-facilitators.test.mts',
    );
  });

  it('falls back to the suite-relative path when no root is given', () => {
    expect(render().test.contents).toContain(
      'Run:  npx tsx tests/vendor-admin-view-facilitators.test.mts',
    );
  });
});

describe('the test file', () => {
  it('is a script, not a Playwright spec', () => {
    // `npx tsx tests/X.test.mts` with a main(). There is no test(), no
    // describe(), and no test.fixme() to fall back on.
    const { contents } = render().test;
    expect(contents).toContain('async function main() {');
    expect(contents).toContain('main();');
    expect(contents).not.toContain("from '@playwright/test'");
  });

  it('loads dotenv before anything that reads process.env', () => {
    // Not stylistic. A static import of the engine helper would evaluate it
    // before the env is loaded and break the run in a way that reads as a
    // configuration problem.
    const { contents } = render().test;
    expect(contents.indexOf("dotenv.config(")).toBeLessThan(contents.indexOf('await import('));
  });

  it('imports the engine and runner dynamically', () => {
    const { contents } = render().test;
    expect(contents).toContain(
      "const { initEngine, teardownEngine } = await import('../helpers/engine');",
    );
    expect(contents).toContain("const { runTest } = await import('../helpers/runner');");
  });

  it('imports the reused flow by its real export and path', () => {
    expect(render().test.contents).toContain(
      "const { loginFlow } = await import('../flows/login.flow');",
    );
  });

  it('reaches the credential getter across the package boundary', () => {
    // The manifest records `packages/data/BAP.ts` from the project root; the
    // test imports it from `src/smart-tests/tests`.
    expect(render().test.contents).toContain(
      "const { getBAPActivityVendorAdminUserCredentials } = await import('../../../../data/BAP');",
    );
  });

  it('navigates in the test, not in the flow — where the suite puts it', () => {
    // A "flow" containing nothing but a goto is an exported function that does
    // not earn its name, and the suite's own flows never navigate.
    expect(render().flow.contents).not.toContain('page.goto(');
    expect(render().test.contents).toContain(
      "await page.goto('https://portal.test/web/h365-portal/facilitators/list', { waitUntil: 'domcontentloaded' });",
    );
  });

  it('says a shared note once, not once per case', () => {
    // A note true of every case is a fact about the run. Repeated seven times
    // it buries the ones that differ.
    const shared = 'The plan does not sign in, so the session comes from `login.loginFlow`.';
    const twice = render({
      ...SUITE,
      tests: [SUITE.tests[0]!, { ...SUITE.tests[0]!, caseId: 'second' }],
    }).test.contents;
    expect(twice.split(shared)).toHaveLength(2);
  });

  it('runs each case through runTest and tears the engine down in finally', () => {
    const { contents } = render().test;
    expect(contents).toContain(
      "await runTest(ctx, 'open-listing', 'Vendor Admin opens the Facilitator listing', async () => {",
    );
    expect(contents).toContain('await loginFlow(engine, page, getBAPActivityVendorAdminUserCredentials());');
    expect(contents).toContain('await openListingFlow(engine, page);');
    expect(contents).toContain('await teardownEngine(ctx);');
  });

  it('verifies in the test, not in the flow', () => {
    expect(render().test.contents).toContain(
      'await verify(engine, \'the "Download as CSV" button is present\');',
    );
  });
});

describe('a case that must not run', () => {
  const blocked = (mode: BubblegumSuite['tests'][number]['mode']) =>
    render({ ...SUITE, tests: [{ ...SUITE.tests[0]!, mode }] }).test.contents;

  it('comments out the invocation under a banner saying why', () => {
    // There is no test.fixme() in a script runner, so the call is disabled
    // rather than marked.
    const contents = blocked({ kind: 'fixme', reason: 'element `el-ghost` is not in the model' });
    expect(contents).toContain('// NOT RUNNABLE: element `el-ghost` is not in the model');
    expect(contents).toContain("// await runTest(ctx, 'open-listing'");
    expect(contents).not.toMatch(/^ {4}await runTest/m);
  });

  it('distinguishes waiting-for-setup from not-runnable', () => {
    expect(blocked({ kind: 'skip', reason: 'data: a seeded facilitator' })).toContain(
      '// SKIPPED: data: a seeded facilitator',
    );
  });

  it('still writes the flow as real code, so the work survives', () => {
    const files = renderSuite({
      ...SUITE,
      tests: [{ ...SUITE.tests[0]!, mode: { kind: 'fixme', reason: 'x' } }],
    });
    const flow = files.find((f) => f.path.endsWith('.flow.ts'))!;
    expect(flow.contents).toContain('export async function openListingFlow');
  });
});

describe('the app entry point comes from the suite, not from a literal', () => {
  /**
   * A live run hardcoded a full CCSIT URL five times while the suite's own tests
   * import `initialApplicationUri`, which switches on `ENV`. The generated file
   * was not off-style, it was pinned to one environment: `ENV=SIT` would still
   * have driven CCSIT.
   */
  const withConstant = () =>
    renderSuite(WITH_CONSTANT).find((f) => f.path.endsWith('.test.mts'))!.contents;

  it('imports the constant and opens the app with it', () => {
    const contents = withConstant();
    expect(contents).toContain(
      "const { initialApplicationUri } = await import('../../../../utilities/constants/url');",
    );
    expect(contents).toContain(
      'await page.goto(initialApplicationUri, { waitUntil: \'networkidle\', timeout: 30000 });',
    );
  });

  it('writes a deeper path relative to it', () => {
    expect(withConstant()).toContain(
      'await page.goto(`${initialApplicationUri}/facilitators/list`, ',
    );
  });

  it('falls back to the literal when no constant was identified', () => {
    // Several plausible URL constants and no way to tell them apart is a choice,
    // and a wrong base URL sends the whole suite to the wrong environment.
    expect(render().test.contents).toContain("await page.goto('https://portal.test/web/h365-portal'");
  });

  it('does not re-open the app inside a case that only wanted the base url', () => {
    const atBase: BubblegumSuite = {
      ...WITH_CONSTANT,
      tests: [{ ...WITH_CONSTANT.tests[0]!, goto: ['https://portal.test/web/h365-portal/'] }],
    };
    const contents = renderSuite(atBase).find((f) => f.path.endsWith('.test.mts'))!.contents;
    expect(contents.match(/page\.goto\(/g)).toHaveLength(1);
  });
});

describe('dataKey', () => {
  it('camel-cases what the sentence calls the field', () => {
    expect(dataKey('Postal Code', new Map())).toBe('postalCode');
  });

  it('suffixes rather than colliding', () => {
    expect(dataKey('Name', new Map([['name', 'x']]))).toBe('name2');
  });

  it('survives a label that starts with a digit', () => {
    expect(dataKey('2nd contact', new Map())).toBe('field2ndContact');
  });
});

describe('determinism', () => {
  it('renders byte-identical output twice', () => {
    // Regenerating has to match or the managed marker churns and every review
    // carries noise.
    expect(renderSuite(SUITE)).toEqual(renderSuite(SUITE));
  });
});
