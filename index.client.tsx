import type { PluginClientContext, PluginSidebarItemProps, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { AccountsScreen } from "./client/AccountsScreen";
import { observeAgents } from "./client/agents";
import { ComposerAccount } from "./client/composer";
import { antigravityLogo } from "./client/logo";
import { messages } from "./client/messages";
import { QuotaSidebarItem } from "./client/sidebar";
import { SUBAGENT_PANEL_ID, createSubagentViews } from "./client/subagents";
import { FallbackNote } from "./client/timeline";
import { registerSubagentTransforms } from "./client/transform";
import {
  FALLBACK_TIMELINE_KIND,
  SUBAGENT_LIST_TIMELINE_KIND,
  SUBAGENT_TIMELINE_KIND,
  fallbackEventSchema,
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
  const cleanup = [
    client.addScreen({ id: "accounts", title, Component: Screen }),
    client.addSettingsScreen({ id: "accounts", title, icon: logo, Component: Screen }),
    client.addSidebarFooterItem({ id: "accounts", title, Component: Sidebar }),
    client.addCommandCenterItem({ id: "accounts", title, icon: logo, context: "global",
      onSelect: ({ openScreen }) => openScreen({ screenId: "accounts" }) }),
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
    cleanup.forEach(remove => remove());
  };
}
