import type { PluginClientContext, PluginSidebarItemProps, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { AccountsScreen } from "./client/AccountsScreen";
import { observeAgents } from "./client/agents";
import { ComposerAccount } from "./client/composer";
import { antigravityLogo } from "./client/logo";
import { messages } from "./client/messages";

const logo = { svg: antigravityLogo };

export default function contribute(client: PluginClientContext) {
  const observation = observeAgents(client);
  const title = messages.message("title");
  function Screen(props: PluginSurfaceProps) {
    observation.useNotifications();
    return <AccountsScreen {...props} observation={observation} />;
  }
  function Sidebar({ currentScreen, openScreen }: PluginSidebarItemProps) {
    observation.useNotifications();
    return <SidebarRow icon={logo} active={currentScreen?.screenId === "accounts"} onPress={() => openScreen({ screenId: "accounts" })} />;
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
  ];
  return () => {
    observation.stop();
    cleanup.forEach(remove => remove());
  };
}
