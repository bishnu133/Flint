---
id: example-login
title: User can sign in
priority: p0
tags:
  - auth
pages:
  - /login
acceptanceCriteria:
  - Given valid credentials, the user reaches the dashboard
  - Given invalid credentials, an error message is shown
negativeCases:
  - Locked-out user sees a lockout message
dataNeeds:
  - A standard test user
  - A locked-out test user
status: draft
---

# User can sign in

This is a starter feature spec. Replace it with a real feature.

The frontmatter above is the machine-readable contract TestGen uses to plan
tests; this body is free-form prose that gives the planner extra context.

## Flow

1. Navigate to the login page.
2. Enter credentials.
3. Submit.
4. Verify the resulting state.
