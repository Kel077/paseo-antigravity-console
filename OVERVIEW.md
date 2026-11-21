# Antigravity Accounts

Use more than one Google account with Paseo's built-in Antigravity provider. Each Antigravity agent runs on the account you pick, and a running agent can move to another account, for example when one account's quota runs out, without losing its conversation.

## How it works

The `agy` CLI normally keeps a single Google sign-in in the system keychain. That sign-in stays as it is and appears here as the system sign-in. Every account you add gets its own profile under the Paseo home directory: a HOME folder that links back to your real home, so tools an agent runs still find your Git, SSH and other settings, and a private `.gemini/antigravity-cli` folder where agy keeps that account's sign-in. The conversation folders inside it point at your real ones, so every account sees the same conversations.

When an Antigravity agent starts, the plugin launches it with the HOME of its account. Switching an agent stores the new account on the agent and reopens its session; the conversation continues where it was. If the agent is in the middle of a turn, you can switch immediately (the turn is interrupted) or after the turn ends.

## Setup

Requires the Antigravity CLI (`agy` 1.5 or later) on the daemon host, signed in at least once for the system account. Open **Antigravity accounts** from the sidebar, the Command Center or the plugin's settings, add an account, open the Google sign-in link, and paste the code Google shows (or the URL of the page you land on).

## Using it

- **New agents**: pick the account in the composer's Account control. Agents without a choice get the account marked as default for new agents.
- **Running agents**: the account pill above the composer shows the current account and switches it. `/account <name or number>` does the same from the composer.
- **Usage**: each added account's quota appears in Paseo's Usage panel and in the agent's usage popover.

## Limits

- The model picker lists the models of the system sign-in. If another account's plan lacks a model, pick one it has.
- Agents on an added account see your real home through symlinks. Files an agent creates directly in the home folder (not inside an existing folder) land in that account's profile instead.
- To protect the system sign-in, the plugin checks where agy stored each new sign-in and refuses to launch an account whose sign-in landed outside its profile.
- Removing an account deletes its stored sign-in. Conversations are kept; agents that used the account must be switched before they can run again.
