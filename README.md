# Antigravity Console for Paseo

A [Paseo](https://paseo.sh) plugin for the built-in Antigravity provider:

- **Multiple Google accounts.** Pick an account per agent and switch a running agent to another account without losing the conversation.
- **Automatic fallback.** Failed turns are retried, then continued on the next account that has quota.
- **Quota and usage.** 5-hour and weekly quota for every account, plus requests, output speed, cache hit rate and time to first token per model.
- **Subagents.** The subagents Antigravity starts appear as live cards in the timeline and in a panel with their task, steps, token use and report.
- **Orchestrator models.** Choose the Orchestrator's planner and executor and their effort, the same setting agy's `/model` writes.
- **Context.** A composer pill with the agent's context window use.

![Usage in Antigravity Console](assets/console.png)

![Subagents panel](assets/subagents.png)

| Subagents in the timeline | Accounts and settings |
| --- | --- |
| ![Subagent cards](assets/timeline.png) | ![Accounts and settings](assets/accounts.png) |

## Install

Requires Paseo 0.16.2 or later and the Antigravity CLI (`agy` 1.5.13 or later; planner and executor choices need 1.5.14) on the daemon host. Tested on macOS.

```bash
paseo plugin add git:Kel077/paseo-antigravity-console
```

Then open **Antigravity Console** from the Command Center (or the meters at the bottom of the sidebar) and choose **Add account**.

## How it works

Paseo runs `agy` for every Antigravity agent. This plugin hooks those launches:

- Each extra account gets its own `HOME` under `~/.paseo/plugin-data/antigravity-accounts/profiles/`. It mirrors your real home with symlinks, except for agy's sign-in, which agy keeps there as a file. Conversation folders link back to the real ones, so every account sees the same conversations and an agent can change accounts mid-conversation.
- Before an account launches, the plugin copies `~/.gemini/antigravity-cli/settings.json` into its profile.
- Removing an account deletes its sign-in and agy's data for it. Files agents saved in its `HOME` are moved to `~/Antigravity Console/<account name>` first, and the Remove dialog lists them.
- Quota comes from `agy -p /usage`, model lists from `agy models`. Usage statistics, context use and subagents are read from agy's own records under `~/.gemini/antigravity-cli` (conversation databases and the `transcript.jsonl` logs agy writes for every conversation).
- Planner and executor choices are written to the `orchestrator` entry of agy's `settings.json`.

The plugin itself makes no network requests and never reads the keychain. See [OVERVIEW.md](OVERVIEW.md) for the full list of what it reads and writes, and its limits.

## Development

```bash
npm install
npm run typecheck
paseo plugin add "$PWD"                   # install from this folder
paseo plugin reload antigravity-accounts  # after each change
```

The plugin uses only modules Paseo provides at runtime, so it has no runtime dependencies and no build step.

## License

[MIT](LICENSE)

Antigravity and the Antigravity logo are trademarks of Google LLC. This project is not affiliated with or endorsed by Google or Paseo.
