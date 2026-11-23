# Antigravity Console

More than one Google account for Paseo's built-in Antigravity provider, with automatic fallback, quota and usage in one place, a view of the subagents Antigravity starts, and control over its Orchestrator's planner and executor.

## What it adds

- **Accounts.** Add Google accounts next to the sign-in the Antigravity CLI keeps in the keychain. Reorder priority, choose the account for new agents, inspect or bulk-migrate agents on an account, recover files saved in a profile home folder, or move an agent to another account from the composer pill or with `/account`. The conversation continues on the new account.
- **Fallback.** When a turn fails, the agent first retries on the same account if the error looks temporary, then moves to the next eligible account that supports the model and has quota in the model's pool (Gemini or Claude/GPT), sending "Continue." to resume. Choose between priority order, most remaining quota, or soonest quota reset, exclude specific accounts from automatic switching, and view or clear active cooldowns on each account card. Every retry and switch is noted in the agent's timeline.
- **Quota.** Each account's Google AI plan, such as Google AI Pro, and its 5-hour and weekly quota. The sidebar footer shows the default account's two meters. In Paseo's Usage, Paseo itself reports the system sign-in and the account each agent runs on; the plugin adds the accounts you added, with their plan.
- **Usage and cost.** Estimated API cost per request (using official Google AI Studio rates, with editable custom prices per model), requests, tokens, output speed, cache hit rate, and time to first token over 24 hours, 7 days, or 30 days, with switchable chart metrics, model filtering, main-versus-subagent split, and per-account attribution.
- **Subagents.** The subagents Antigravity starts show as live cards in the agent's timeline, a workspace badge while running, and a Subagents panel with search and state filters, each subagent's task, steps, artifacts, token use, full transcript copy, and one-click insertion of its report into the parent composer.
- **Interactive questions.** Renders Antigravity's `ask_question` calls as interactive choice cards with single-select, multi-select, multi-question tabs, free-text answers, and skip, replacing the raw JSON block and hiding the duplicate plain-text list from the CLI.
- **Orchestrator.** Choose the planner and executor models of Antigravity's Orchestrator and their effort globally, via quick presets, per profile account, from a composer pill on Orchestrator agents, or with `/orchestrator`. Global choices are saved where the CLI's own `/model` saves them.
- **Context.** A composer pill with the agent's context window use.

## Setup

Requires the Antigravity CLI (`agy` 1.5.13 or later; planner and executor choices need 1.5.14) on the daemon host, and Paseo 0.17.1 or later. Tested on macOS. Linux is untested and Windows is not supported.

To add an account, open Antigravity Console from the Command Center or the sidebar footer, choose Add account, open the Google sign-in link, and paste the code Google shows.

## Data and access

- Each added account runs agy with its own HOME inside Paseo's plugin data folder. That HOME links back to your real home, so agents still see your files and settings, and agy keeps only that account's sign-in there, as a file instead of a keychain entry. Conversations are shared by all accounts. If a sign-in ever lands outside its profile, the plugin stops using that account.
- Removing an added account deletes its sign-in and the data agy keeps for it, such as logs and caches. Files agents saved in its home folder are first moved to `~/Antigravity Console/<account name>`, and the Remove dialog lists them before you confirm. You can also inspect and recover saved files at any time from the account menu without removing the account; if the profile and recovery folders are on different volumes, recovery copies the files and leaves the originals in place.
- Before each launch on an added account, the plugin atomically copies agy's `settings.json` into that account's profile and merges any per-account Orchestrator override, so every account uses the same base preferences.
- Choosing a global planner or executor writes the `orchestrator` entry of `~/.gemini/antigravity-cli/settings.json`.
- Quota, plans, model lists, and sign-in run the agy CLI on the daemon host. Usage, context, and subagent views read agy's conversation records, artifacts, and logs under `~/.gemini/antigravity-cli`.
- Submitting or skipping an interactive question card sends your answer (or "User Skipped") as a message to that Antigravity agent through Paseo.
- The plugin makes no network requests of its own and sends no data anywhere; agy talks to Google as it always does. It never reads the keychain. The account list, status cache, custom price overrides, and conversation-to-account attribution map are kept in Paseo's plugin data folder.

## Limits

- The model picker lists the system sign-in's models, and accounts can offer different ones. An agent moved to an account without its model fails to start there and stays on its current account.
- A planner or executor that an account cannot run falls back to agy's default on that account.
- Per-account usage attribution applies to conversations observed while this plugin is active.
- Files an agent creates directly in the home folder while it runs on an added account stay in that account's profile until you recover them or remove the account.
- The subagent views are read-only. Stopping or messaging a subagent stays with its parent agent.
