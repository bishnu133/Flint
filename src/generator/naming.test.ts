import { describe, it, expect } from 'vitest';
import {
  actionMethodName,
  camelCase,
  kebabCase,
  locatorName,
  pageClassName,
  pageObjectFileName,
  pascalCase,
  specFileName,
  uniquify,
  words,
} from './naming.js';

describe('words', () => {
  it.each([
    ['sign in page', ['sign', 'in', 'page']],
    ['/checkout/step-one', ['checkout', 'step', 'one']],
    ['signInPage', ['sign', 'in', 'page']],
    ['HTTPServer', ['httpserver']],
    ['user_name', ['user', 'name']],
    ['   ', []],
    ['', []],
  ])('%s => %j', (input, expected) => {
    expect(words(input)).toEqual(expected);
  });
});

describe('case helpers', () => {
  it.each([
    ['sign in', 'signIn'],
    ['Sign-In Page', 'signInPage'],
    ['', 'item'],
    // A leading digit is not a valid identifier start, so it gets a prefix.
    ['2fa code', 'n2faCode'],
  ])('camelCase(%s) => %s', (input, expected) => {
    expect(camelCase(input)).toBe(expected);
  });

  it('pascal- and kebab-case the same words', () => {
    expect(pascalCase('sign in page')).toBe('SignInPage');
    expect(kebabCase('Sign In Page')).toBe('sign-in-page');
    expect(kebabCase('')).toBe('item');
  });
});

describe('pageClassName', () => {
  it.each([
    ['/', 'HomePage'],
    ['/login', 'LoginPage'],
    ['/checkout/step-one', 'CheckoutStepOnePage'],
    ['/inventory.html', 'InventoryHtmlPage'],
  ])('%s => %s', (pattern, expected) => {
    expect(pageClassName(pattern)).toBe(expected);
  });

  it('does not double the Page suffix', () => {
    expect(pageClassName('/pages/login')).toBe('PagesLoginPage');
    expect(pageClassName('/page')).toBe('Page');
  });

  it('scopes the class by role so a multi-role model does not collide', () => {
    expect(pageClassName('/orders', 'admin')).toBe('AdminOrdersPage');
    expect(pageClassName('/orders', 'admin')).not.toBe(pageClassName('/orders', 'customer'));
  });
});

describe('file names', () => {
  it.each([
    ['LoginPage', 'login.page.ts'],
    ['CheckoutStepOnePage', 'checkout-step-one.page.ts'],
    ['Page', 'home.page.ts'],
  ])('%s => %s', (className, expected) => {
    expect(pageObjectFileName(className)).toBe(expected);
  });

  it('names a spec after its feature', () => {
    expect(specFileName('login')).toBe('login.spec.ts');
    expect(specFileName('Checkout Flow')).toBe('checkout-flow.spec.ts');
  });
});

describe('locatorName', () => {
  it.each([
    ['button', 'Login', 'loginButton'],
    ['textbox', 'Username', 'usernameInput'],
    ['textbox', 'Password', 'passwordInput'],
    ['link', 'Continue shopping', 'continueShoppingLink'],
    ['checkbox', 'Accept terms', 'acceptTermsCheckbox'],
    ['combobox', 'Country', 'countrySelect'],
    ['alert', 'Error message', 'errorMessageAlert'],
  ])('%s "%s" => %s', (role, name, expected) => {
    expect(locatorName(role, name, 'el-abc')).toBe(expected);
  });

  it('does not repeat a noun the name already carries', () => {
    expect(locatorName('button', 'Submit button', 'el-abc')).toBe('submitButton');
    expect(locatorName('link', 'Home link', 'el-abc')).toBe('homeLink');
  });

  it('falls back to the element id — never a positional index — when unnamed', () => {
    // A positional fallback would change every time the DOM order shifted,
    // which is exactly the churn stable element ids exist to prevent.
    expect(locatorName('button', '', 'el-50b5011efc86')).toBe('el50b5011efc86Button');
  });

  it('handles a role we have no noun for', () => {
    expect(locatorName('switch', 'Dark mode', 'el-abc')).toBe('darkModeSwitch');
  });
});

describe('actionMethodName', () => {
  it('reads as a sentence', () => {
    expect(actionMethodName('fill', 'usernameInput')).toBe('fillUsernameInput');
    expect(actionMethodName('click', 'loginButton')).toBe('clickLoginButton');
  });
});

describe('uniquify', () => {
  it('leaves distinct names alone', () => {
    expect(uniquify(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('breaks collisions with the shortest numeric suffix, in order', () => {
    expect(uniquify(['item', 'item', 'item'])).toEqual(['item', 'item2', 'item3']);
  });

  it('does not collide with a name that already ends in the suffix it would add', () => {
    expect(uniquify(['item2', 'item', 'item'])).toEqual(['item2', 'item', 'item3']);
  });

  it('escapes reserved words and page-object members', () => {
    expect(uniquify(['class', 'page', 'goto'])).toEqual([
      'classElement',
      'pageElement',
      'gotoElement',
    ]);
  });

  it('is a pure function of its input order', () => {
    const input = ['x', 'x', 'y', 'x'];
    expect(uniquify(input)).toEqual(uniquify(input));
  });
});
