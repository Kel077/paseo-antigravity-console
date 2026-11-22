# Antigravity Console

A console for Paseo's built-in Antigravity provider: usage, quota and more than one Google account in one place.

- **Usage**: requests, output speed (tokens per second), cache hit rate and time to first token over 24 hours, 7 days or 30 days, per hour or day and per model. Read from agy's own conversation records on this host.
- **Quota**: every account's 5-hour and weekly quota. The sidebar footer shows the default account's two meters.
- **Accounts**: add Google accounts next to the sign-in agy keeps in the keychain, pick one for new agents in the composer, or move a running agent to another account from the pill above the composer (or `/account`). The conversation continues on the new account.
- **Context**: a composer pill with the agent's context window use.

## Setup

Requires the Antigravity CLI (`agy` 1.5 or later) on the daemon host. Add an account from the console, open the Google sign-in link and paste the code Google shows.

## Limits

- The model picker lists the system sign-in's models.
- Each added account runs agy with its own HOME, which links back to your real home; files an agent creates directly in the home folder land in that account's profile.
- The plugin refuses to launch an account whose sign-in agy stored outside the account's profile.
