# Configuration reference

`flint.config.ts` at the root of your project. It is a TypeScript module, so
you get autocomplete and type errors before Flint ever runs:

```ts
import type { FlintConfigInput } from 'flint';

export default {
  baseUrl: 'https://test.example.com',
  envClass: 'test',
  models: {
    planner: 'claude-opus-5',
    coder: 'claude-opus-5',
    repair: 'claude-opus-5',
  },
} satisfies FlintConfigInput;
```

Everything not listed as **required** has a default. An invalid config fails
with a message naming the bad key — never a stack trace.

---

## Top level

| Key | Required | Default | Notes |
| --- | :---: | --- | --- |
| `baseUrl` | ✅ | — | Absolute URL of the app. Also passed to the generated suite as `BASE_URL`, so changing it re-points the tests without regenerating them. |
| `envClass` | ✅ | — | `test` \| `dev` \| `staging` \| `production`. **`flint explore` refuses anything but `test`.** |
| `suiteDir` | | `e2e` | Where the generated suite lives, relative to the project root. |
| `kbDir` | | `kb` | Where the knowledge base lives. |
| `dialect` | | `playwright-pom` | Code-emission style. `bubblegum` is reserved and not implemented in V1. |
| `auth` | | `{ mode: 'none' }` | See below. |
| `explorer` | | see below | Crawl behaviour and selector strategy. |
| `models` | ✅ | — | Which model runs which stage. |
| `tokenBudgets` | | see below | Context budgets per stage. |
| `debug` | | `{}` | Logging. |

### `envClass` is a safety rail, not a label

Exploration drives a real browser through real flows — it clicks buttons, fills
forms, and follows links. On a production environment that is somewhere between
rude and catastrophic. Flint refuses rather than trusting you to remember, and
there is no override flag.

---

## `auth`

A discriminated union on `mode`. Exploration and the generated suite both use it.

```ts
auth: { mode: 'none' }
```

```ts
auth: {
  mode: 'credentials',
  username: process.env.APP_USER ?? '',
  password: process.env.APP_PASSWORD ?? '',
  loginUrl: 'https://test.example.com/login',   // optional; defaults to baseUrl
}
```

```ts
auth: { mode: 'storageState', storageStatePath: './.auth/state.json' }
```

```ts
auth: { mode: 'loginScript', loginScriptPath: './scripts/login.ts' }
```

| Mode | When to use it |
| --- | --- |
| `none` | The app needs no sign-in, or you only care about anonymous pages. |
| `credentials` | A conventional username/password form. Flint finds the fields and submits. |
| `storageState` | You already have a Playwright storage-state file (SSO, MFA, anything scripted elsewhere). |
| `loginScript` | Sign-in is bespoke enough to need code. Your script gets a `page` and must leave it authenticated. |

**Never commit real credentials.** Read them from the environment, as above.

> A one-page Screen Model is the classic symptom of auth that did not work —
> Flint crawled the login screen and nothing else. It detects this case and says
> so explicitly rather than leaving you to infer it from a page count.

---

## `explorer`

| Key | Default | Notes |
| --- | --- | --- |
| `testIdAttribute` | `data-testid` | **The single most consequential setting.** See below. |
| `maxPages` | `50` | Crawl budget. |
| `maxDepth` | `5` | Link depth from the entry point. |
| `mode` | `crawl` | `agent` and `crawl-then-agent` are V2; the enum is stable so config written today keeps parsing. |
| `waitStrategy` | `networkidle` | `networkidle` \| `domcontentloaded` \| `load`. Lower it for apps that poll — `networkidle` never settles when something long-polls. |
| `dangerousActionPatterns` | `['logout', 'delete', 'submit', 'pay', 'remove']` | Buttons matching these are never clicked during exploration. Add anything destructive in your domain. |
| `i18n` | `false` | When true, text-derived selector strategies are demoted, because visible copy changes per locale. |
| `roles` | `[]` | Build a separate Screen Model per named role. Empty means one anonymous model. |
| `captchaPatterns` | `[]` | Page markers that mean "bot-blocked", so a challenge page is reported rather than modelled as a real screen. |
| `urlPatterns.include` | `[]` | Only crawl URLs matching these. Empty means everything same-origin. |
| `urlPatterns.exclude` | `[]` | Never crawl URLs matching these. |
| `urlPatterns.normalize` | `[]` | `{ pattern, replacement }` rules that collapse parameterised URLs so `/order/1`, `/order/2`… are one page, not fifty. |

### `testIdAttribute` — get this right first

Flint's selector ranking is locked: `testid` scores 100, `role` 85, `label` 75,
`placeholder` 65, `text` 55, `css` 30. The highest-ranked strategy is only
available if Flint knows which attribute your app marks test hooks with.

If your app uses `data-test` and this is left at `data-testid`, Flint gets **no
test-id selectors at all** and silently falls back to role and CSS — which is
exactly the fragility the ranking exists to avoid. Nothing errors; the suite is
just quietly more brittle.

```ts
explorer: { testIdAttribute: 'data-test' }
```

Changing it later re-hashes every element id (ids are derived from stable facts
including the test id), so the next `flint explore` will look like the whole app
changed, and a regenerate is needed. Set it before your first real run.

### `urlPatterns.normalize`

```ts
explorer: {
  urlPatterns: {
    normalize: [
      { pattern: '/order/\\d+', replacement: '/order/:id' },
      { pattern: '/user/[0-9a-f-]{36}', replacement: '/user/:uuid' },
    ],
  },
}
```

Without this, a list of 200 orders is 200 "pages" and your crawl budget is gone
before it reaches checkout.

---

## `models`

| Key | Required | Used by |
| --- | :---: | --- |
| `planner` | ✅ | `flint plan`, and the planning phase of `ci` / `bench` |
| `coder` | ✅ | Reserved. V1's emitter is deterministic and makes no model calls. |
| `repair` | ✅ | `flint verify --repair`, after the deterministic selector retry has nothing left to try |

```ts
models: {
  planner: 'claude-opus-5',
  coder: 'claude-opus-5',
  repair: 'claude-opus-5',
}
```

Planning is where model quality shows up most — it decides what gets tested.
Repair runs rarely and only after the deterministic path is exhausted.

---

## `tokenBudgets`

Context budgets, in tokens, for the **prompt** each stage builds.

| Key | Default | Notes |
| --- | --- | --- |
| `plan` | `60000` | How much Screen Model and suite context the planner is shown. Raise it for large apps; lower it to cut cost. |
| `generate` | `40000` | Reserved for a model-driven emitter. |
| `repair` | `30000` | Context given to the repair model per failing test. |

> These are **input** budgets. They do not cap the model's output — if a plan
> comes back truncated, that is the output ceiling, not this.

---

## `debug`

| Key | Default | Notes |
| --- | --- | --- |
| `logPrompts` | `false` | Log raw prompts. **Off by default because prompts contain your app's content and may contain credentials.** |
| `verbose` | `false` | Verbose logging. `-v` on any command does the same thing per-run. |

---

## Environment variables

| Variable | Needed by | Notes |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | `plan`, `ci`, `bench`, `verify --repair` | Without it, `verify --repair` degrades to the deterministic selector retry and says so, rather than failing. |
| `BASE_URL` | the generated suite | Set by Flint when it runs the suite; set it yourself to point the same tests at another environment. |
| `FLINT_BROWSER_EXECUTABLE` | exploration | Path to a Chromium binary, when Playwright's own download is unavailable. |
| `NODE_OPTIONS=--use-system-ca` | corporate networks | Needed behind a TLS-inspecting proxy. **Never use `NODE_TLS_REJECT_UNAUTHORIZED=0`** — it disables certificate verification entirely. |

---

## Files Flint writes

| Path | What it is | Commit it? |
| --- | --- | --- |
| `.flint/screen-model/model.json` | The Screen Model | Yes — it is the input every other stage reads, and diffing it is how you see drift |
| `.flint/plans/<id>.plan.json` | Stored plans | Yes |
| `.flint/plans/<id>.plan.md` | Human-readable plan | Yes |
| `.flint/page-objects.json` | Which element ids each page object exposes | Yes — without it, regenerating one feature drops another's locators |
| `.flint/suite-index.json` | Static scan of the suite | Optional; regenerated by `flint index` |
| `.flint/reports/*.json` | Run reports | No — add to `.gitignore` |
| `<suiteDir>/**` | The generated suite | Yes |
| `benchmarks/baseline.md` | `flint bench` output | Yes |
