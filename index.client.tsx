import type { PluginClientContext, PluginSidebarItemProps, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { AccountsScreen } from "./client/AccountsScreen";
import { observeAgents } from "./client/agents";
import { ComposerAccount } from "./client/composer";
import { antigravityLogo } from "./client/logo";
import { messages } from "./client/messages";
import { QuotaSidebarItem } from "./client/sidebar";
import { FallbackNote } from "./client/timeline";
import { FALLBACK_TIMELINE_KIND, fallbackEventSchema } from "./shared/contracts";

const logo = { svg: antigravityLogo };

export default function contribute(client: PluginClientContext) {
  const observation = observeAgents(client);
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
  ];
  return () => {
    observation.stop();
    cleanup.forEach(remove => remove());
  };
}
