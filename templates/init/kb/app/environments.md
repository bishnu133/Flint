# Environments

> Record the environments TestGen may target. Exploration and generated runs
> should point at a **test** environment, never production.

| Env | Base URL | envClass | Notes |
| --- | --- | --- | --- |
| test | {{baseUrl}} | test | Safe for exploration and destructive-looking flows |
| staging | _https://staging.example.com_ | staging | _describe_ |

- Test users should have CAPTCHA / bot detection disabled.
