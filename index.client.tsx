import {
  useTranslation,
  type PluginClientContext,
  type PluginSidebarItemProps,
  type PluginSurfaceProps,
  type PluginWorkspaceRowBadgeItemProps,
} from "@getpaseo/plugin/client";
import { WorkspaceRowBadge } from "@getpaseo/plugin/client/ui";
import { useSyncExternalStore } from "react";
import { AccountsScreen } from "./client/AccountsScreen";
import { observeAgents } from "./client/agents";
import { ComposerAccount } from "./client/composer";
import { antigravityLogo } from "./client/logo";
import { errorMessage, messages } from "./client/messages";
import { QuotaSidebarItem } from "./client/sidebar";
import { SUBAGENT_PANEL_ID, createSubagentViews } from "./client/subagents";
import { FallbackNote } from "./client/timeline";
import { registerSubagentTransforms } from "./client/transform";
import {
  FALLBACK_TIMELINE_KIND,
  SUBAGENT_LIST_TIMELINE_KIND,
  SUBAGENT_TIMELINE_KIND,
  fallbackEventSchema,
  refreshAccountsRpc,
  subagentCardSchema,
  subagentCheckSchema,
} from "./shared/contracts";

const logo = { svg: antigravityLogo };

export default function contribute(client: PluginClientContext) {
  const subagents = createSubagentViews(client);
  const observation = observeAgents(client, subagents.open);
  const title = messages.message("title");

  function Screen(props: PluginSurfaceProps) {
    observation.useNotifications();
    return <AccountsScreen {...props} observation={observation} />;
  }
  function Sidebar(props: PluginSidebarItemProps) {
    observation.useNotifications();
    return <QuotaSidebarItem {...props} />;
  }
  function Composer() {
    observation.useNotifications();
    return <ComposerAccount />;
  }
  function SubagentsWorkspaceBadge({ workspaceId }: PluginWorkspaceRowBadgeItemProps) {
    const { t } = useTranslation(messages);
    const byWorkspace = useSyncExternalStore(observation.subscribe, observation.workspaceRunningSubagents);
    const running = byWorkspace.get(workspaceId) ?? 0;
    if (!running) return null;
    return <WorkspaceRowBadge icon="Bot" tone="info" label={t("subagents.workspaceBadge", { count: running })} />;
  }

  const cleanup = [
    client.addScreen({ id: "accounts", title, Component: Screen }),
    client.addSettingsScreen({ id: "accounts", title, icon: logo, Component: Screen }),
    client.addSidebarFooterItem({ id: "accounts", title, Component: Sidebar }),
    client.addWorkspaceRowBadgeItem({
      id: "running-subagents",
      title: messages.message("subagents.title"),
      icon: "Bot",
      Component: SubagentsWorkspaceBadge,
    }),
    client.addCommandCenterItem({
      id: "accounts",
      title,
      icon: logo,
      context: "global",
      onSelect: ({ openScreen }) => openScreen({ screenId: "accounts" }),
    }),
    client.addCommandCenterItem({
      id: "refresh-quotas",
      title: messages.message("commandRefresh"),
      icon: "RefreshCw",
      context: "global",
      onSelect: async ({ rpc }) => {
        try {
          await rpc(refreshAccountsRpc, {});
          observation.notify(client.i18n.t(messages, "commandRefreshed"));
        } catch (error) {
          observation.notify(errorMessage(error));
        }
      },
    }),
    client.addComposerItem({ id: "account", Component: Composer }),
    client.addTimelineRenderer({ kind: FALLBACK_TIMELINE_KIND, version: 1, schema: fallbackEventSchema, Component: FallbackNote }),
    client.addTimelineRenderer({ kind: SUBAGENT_TIMELINE_KIND, version: 1, schema: subagentCardSchema, Component: subagents.SubagentCardRow }),
    client.addTimelineRenderer({ kind: SUBAGENT_LIST_TIMELINE_KIND, version: 1, schema: subagentCheckSchema, Component: subagents.SubagentCheckRow }),
    registerSubagentTransforms(client),
    client.addAgentPanel({
      id: SUBAGENT_PANEL_ID,
      title: messages.message("subagents.title"),
      icon: "Bot",
      Component: subagents.SubagentsPanel,
    }),
  ];
  return () => {
    observation.stop();
    cleanup.forEach((remove) => remove());
  };
}
