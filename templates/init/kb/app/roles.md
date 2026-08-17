---
roles:
  - id: standardUser
    description: An ordinary signed-in shopper.
    credentials: getStandardUserCredentials
    aliases: [shopper, customer]
---

# Roles

Who a test signs in as, and where the credentials come from.

`credentials` names an exported getter in your own codebase — `flint kb` checks
it exists, so a renamed getter is caught here rather than in a failing run.

Never put passwords in this file. It names the function that supplies them.

| Role | Description | How to authenticate |
| --- | --- | --- |
| guest | Unauthenticated visitor | none |
| user | Standard signed-in user | _describe_ |
| admin | Elevated privileges | _describe_ |

> If the app has multiple user roles, also set `explorer.roles` in
> `flint.config.ts` to build a Screen Model per role — the frontmatter above
> tells the generator which credentials to use, while `explorer.roles` tells the
> crawler which pages each role can even see.
