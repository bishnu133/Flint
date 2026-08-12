/**
 * Deterministic naming for emitted code.
 *
 * Every identifier and filename Phase 4 writes comes from here. That is not
 * tidiness — it is the determinism requirement: regenerating a feature must
 * produce byte-identical output, so no name may depend on iteration order, a
 * counter that survives across runs, or anything a model chose.
 *
 * Names are derived from Screen Model facts (a page's URL pattern, an element's
 * role and accessible name). When two elements on a page would take the same
 * name, the collision is broken by appending the shortest numeric suffix in a
 * fixed order — same inputs, same names, every time.
 */

/** Reserved words plus the identifiers our emitted classes already use. */
const RESERVED = new Set([
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'new',
  'null',
  'return',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
  'let',
  'static',
  'await',
  'implements',
  'interface',
  'package',
  'private',
  'protected',
  'public',
  // Members of the emitted page-object base shape.
  'page',
  'goto',
  'constructor',
]);

/** Split any string into lowercase word parts, dropping everything else. */
export function words(input: string): string[] {
  return input
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .flatMap((part) => (part === '' ? [] : [part.toLowerCase()]))
    .filter((part) => part !== '');
}

/** `Sign in page` -> `signInPage`. Empty input yields `item`. */
export function camelCase(input: string): string {
  const parts = words(input);
  if (parts.length === 0) return 'item';
  const head = parts[0]!;
  const rest = parts.slice(1).map(capitalize).join('');
  const name = `${head}${rest}`;
  // A leading digit is not a valid identifier start.
  return /^[0-9]/.test(name) ? `n${capitalize(name)}` : name;
}

/** `sign in page` -> `SignInPage`. Empty input yields `Item`. */
export function pascalCase(input: string): string {
  return capitalize(camelCase(input));
}

/** `Sign In Page` -> `sign-in-page`. Empty input yields `item`. */
export function kebabCase(input: string): string {
  const parts = words(input);
  return parts.length === 0 ? 'item' : parts.join('-');
}

function capitalize(input: string): string {
  return input === '' ? input : input.charAt(0).toUpperCase() + input.slice(1);
}

/**
 * A page-object class name for a URL pattern.
 *
 * `/` becomes `HomePage`, `/checkout/step-one` becomes `CheckoutStepOnePage`.
 * The `Page` suffix is always present, and never doubled — `/pages/login`
 * yields `PagesLoginPage`, not `PagesLoginPagePage`.
 */
export function pageClassName(urlPattern: string, role?: string): string {
  const parts = words(urlPattern);
  const roleParts = role === undefined || role === '' ? [] : words(role);
  const base = [...roleParts, ...parts];
  const name = base.length === 0 ? 'Home' : pascalCase(base.join(' '));
  return name.endsWith('Page') ? name : `${name}Page`;
}

/** File basename for a page object: `LoginPage` -> `login.page.ts`. */
export function pageObjectFileName(className: string): string {
  const parts = words(className);
  const trimmed = parts.at(-1) === 'page' ? parts.slice(0, -1) : parts;
  const stem = trimmed.length === 0 ? 'home' : trimmed.join('-');
  return `${stem}.page.ts`;
}

/** File basename for a feature's spec: `login` -> `login.spec.ts`. */
export function specFileName(featureId: string): string {
  return `${kebabCase(featureId)}.spec.ts`;
}

/**
 * Locator property name for an element: role + accessible name.
 *
 * `button "Login"` -> `loginButton`; `textbox "Username"` -> `usernameInput`.
 * Role words that read badly as a suffix are mapped to the noun a human would
 * write, because these names end up in test code a human reviews.
 */
const ROLE_SUFFIX: Readonly<Record<string, string>> = {
  textbox: 'Input',
  searchbox: 'Input',
  spinbutton: 'Input',
  combobox: 'Select',
  slider: 'Slider',
  checkbox: 'Checkbox',
  radio: 'Radio',
  button: 'Button',
  link: 'Link',
  tab: 'Tab',
  menuitem: 'MenuItem',
  option: 'Option',
  alert: 'Alert',
  heading: 'Heading',
};

export function locatorName(role: string, name: string, fallback: string): string {
  const base = name.trim() === '' ? '' : camelCase(name);
  const suffix = ROLE_SUFFIX[role] ?? capitalize(camelCase(role));
  if (base === '') {
    // No accessible name: fall back to something derived from the element id,
    // which is itself a stable hash — never a positional index.
    return camelCase(`${fallback} ${suffix}`);
  }
  // Avoid `loginButtonButton` when the name already carries the noun.
  return base.toLowerCase().endsWith(suffix.toLowerCase()) ? base : `${base}${capitalize(suffix)}`;
}

/** Method name for acting on an element: `fill` + `usernameInput`. */
export function actionMethodName(action: string, locator: string): string {
  return camelCase(`${action} ${locator}`);
}

/**
 * Make every name in a list unique and identifier-safe, deterministically.
 *
 * Collisions are resolved by appending `2`, `3`… in the order the names were
 * given. The caller is responsible for giving them in a stable order — the
 * emitter sorts before calling, so two runs over the same model agree.
 */
export function uniquify(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((raw) => {
    const safe = RESERVED.has(raw) ? `${raw}Element` : raw;
    if (!used.has(safe)) {
      used.add(safe);
      return safe;
    }
    for (let n = 2; ; n += 1) {
      const candidate = `${safe}${n}`;
      if (!used.has(candidate)) {
        used.add(candidate);
        return candidate;
      }
    }
  });
}
