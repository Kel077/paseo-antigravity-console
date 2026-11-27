# Antigravity Console

More than one Google account for Paseo's built-in Antigravity provider, with automatic fallback, quota and usage in one place, a view of the subagents Antigravity starts, and control over its Orchestrator's planner and executor.

## What it adds

- **Accounts.** Add Google accounts next to the sign-in the Antigravity CLI keeps in the keychain. Reorder priority, add short notes or tags per account, pick a fixed default or automatic strategy-based selection for new agents, inspect or bulk-migrate agents on an account, recover files saved in a profile home folder, or move an agent to another account from the composer pill (which shows remaining quota for the current model's pool, cooldowns, and model compatibility) or with `/account`. The conversation continues on the new account.
- **Fallback and proactive switching.** When a turn fails, the agent first retries on the same account if the error looks temporary, then moves to the next eligible account that supports the model and has quota in the model's pool (Gemini or Claude/GPT), sending "Continue." to resume. Optionally enable proactive low-quota switching to choose a healthier account when creating or reopening a session if its model pool is at or below the threshold. Active turns continue uninterrupted. Choose between priority order, most remaining quota, or soonest quota reset, exclude specific accounts from automatic switching, and view or clear active cooldowns on each account card. Every retry and switch is noted in the agent's timeline.
- **Quota.** Each account's Google AI plan, such as Google AI Pro, and its 5-hour and weekly quota. The sidebar footer shows the active default account's two meters and opens a quick popover listing every account's quota, reset timers, default switcher, and auto-routing toggle without leaving the current conversation. In Paseo's Usage, Paseo itself reports the system sign-in and the account each agent runs on; the plugin adds the accounts you added, with their plan.
- **Usage and cost.** A daily token calendar for the last year, in the style of GitHub's contribution graph. Total tokens, estimated API cost per request (using official Google AI Studio rates, with editable custom prices per model), requests, output speed, cache hit rate, and time to first token over 24 hours, 7 days, or 30 days, with tiles that pick the chart's metric, a sortable per-model table with totals, a top-conversations cost ranking with direct jump links to active agents, model filtering, main-versus-subagent split, and per-account attribution.
- **Artifacts and attachments.** An Artifacts panel per agent lists Markdown, code, text, and image files created in the main conversation and its subagents under `~/.gemini/antigravity-cli/brain`, with inline preview, path/content copy, and composer insertion. A composer attachment source lets you search recent artifacts and subagent reports across conversations and attach them to any prompt.
- **Subagents.** The subagents Antigravity starts show as live cards in the agent's timeline, a workspace badge while running, and a Subagents panel with search and state filters, each subagent's task, steps, artifacts, token use, full transcript copy, and one-click insertion of its report into the parent composer.
- **Interactive questions and native tool cards.** Renders Antigravity's `ask_question` calls as interactive choice cards with single-select, multi-select, multi-question tabs, free-text answers, and skip, hiding the duplicate plain-text list from the CLI. Each `update_steps` call appears as a single progress row. Expand it to see the checklist at that point, or open the live Tasks pill for the latest confirmed checklist. The plugin condenses `schedule`, `run_workflow`, and `send_message` tool calls into compact expandable rows.
- **Orchestrator.** Choose the planner and executor models of Antigravity's Orchestrator and their effort globally, via quick presets, per profile account, from a composer pill on Orchestrator agents, or with `/orchestrator`. Global choices are saved where the CLI's own `/model` saves them.
- **Context and session totals.** A composer pill shows the agent's context window use, and its popover includes cumulative requests, tokens, cache hit rate, and estimated API cost for the current conversation.

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
- Searching the composer attachment source returns matching artifact and subagent report excerpts (up to 48 KB each) to your Paseo client. Only when you select an attachment and submit a prompt does Paseo include that text in the prompt sent to that agent's provider.
- The plugin makes no external network requests of its own; agy talks to Google as it always does. It never reads the keychain. The account list, status cache, custom price overrides, and conversation-to-account attribution spans are kept in Paseo's plugin data folder.

## Limits

- The model picker lists the system sign-in's models, and accounts can offer different ones. An agent moved to an account without its model fails to start there and stays on its current account.
- A planner or executor that an account cannot run falls back to agy's default on that account.
- Per-account usage attribution applies to conversations observed while this plugin is active.
- Files an agent creates directly in the home folder while it runs on an added account stay in that account's profile until you recover them or remove the account.
- The subagent views are read-only. Stopping or messaging a subagent stays with its parent agent.
- Automatic failure fallback calls Paseo's session reload API to switch accounts and resume. Because Paseo 0.17.1 does not expose an atomic reload-if-idle check, a new message sent in the exact moment a failure-recovery reload is in flight can be interrupted; disable automatic fallback if you prefer manual switching.
