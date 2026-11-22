# Antigravity Console

More than one Google account for Paseo's built-in Antigravity provider, with automatic fallback, quota and usage in one place, a view of the subagents Antigravity starts, and control over its Orchestrator's planner and executor.

## What it adds

- **Accounts.** Add Google accounts next to the sign-in the Antigravity CLI keeps in the keychain. Choose the account for new agents, or move an agent to another account from the composer pill or with `/account`. The conversation continues on the new account.
- **Fallback.** When a turn fails, the agent first retries on the same account if the error looks temporary, then moves to the next account that can serve and sends "Continue." to resume. Quota and sign-in failures move right away. Every retry and switch is noted in the agent's timeline. You can turn fallback off or change the number of retries.
- **Quota.** Each account's 5-hour and weekly quota. The sidebar footer shows the default account's two meters.
- **Usage.** Requests, output speed, cache hit rate and time to first token over 24 hours, 7 days or 30 days, per model.
- **Subagents.** The subagents Antigravity starts show as live cards in the agent's timeline and in a Subagents panel, with each one's task, status, every step it took, its token use and the report it sent back.
- **Orchestrator.** Choose the planner and executor models of Antigravity's Orchestrator and their effort, in the console or from a composer pill on Orchestrator agents. The choice is saved where the CLI's own `/model` saves it.
- **Context.** A composer pill with the agent's context window use.

## Setup

Requires the Antigravity CLI (`agy` 1.5.13 or later; planner and executor choices need 1.5.14) on the daemon host, and Paseo 0.16.2 or later. Tested on macOS. Linux is untested and Windows is not supported.

To add an account, open Antigravity Console from the Command Center or the sidebar footer, choose Add account, open the Google sign-in link and paste the code Google shows.

## Data and access

- Each added account runs agy with its own HOME inside Paseo's plugin data folder. That HOME links back to your real home, so agents still see your files and settings, and agy keeps only that account's sign-in there, as a file instead of a keychain entry. Conversations are shared by all accounts. If a sign-in ever lands outside its profile, the plugin stops using that account.
- Removing an added account deletes its sign-in and the data agy keeps for it, such as logs and caches. Files agents saved in its home folder are first moved to `~/Antigravity Console/<account name>`, and the Remove dialog lists them before you confirm.
- Before each launch on an added account, the plugin copies agy's `settings.json` into that account's profile, so every account uses the same preferences.
- Choosing a planner or executor writes the `orchestrator` entry of `~/.gemini/antigravity-cli/settings.json`.
- Quota, model lists and sign-in run the agy CLI on the daemon host. Usage, context and subagent views read agy's conversation records and logs under `~/.gemini/antigravity-cli`.
- The plugin makes no network requests of its own and sends no data anywhere; agy talks to Google as it always does. It never reads the keychain. The account list and a status cache are kept in Paseo's plugin data folder.

## Limits

- The model picker lists the system sign-in's models, and accounts can offer different ones. An agent moved to an account without its model fails to start there and stays on its current account.
- A planner or executor that an account cannot run falls back to agy's default on that account.
- Files an agent creates directly in the home folder while it runs on an added account stay in that account's profile until you remove the account.
- The subagent views are read-only. Stopping or messaging a subagent stays with its parent agent.
