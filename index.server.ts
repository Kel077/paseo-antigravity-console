import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  cancelSignInRpc,
  contextUsageRpc,
  createAccountRpc,
  listAccountsRpc,
  refreshAccountsRpc,
  removeAccountRpc,
  renameAccountRpc,
  setDefaultAccountRpc,
  signOutAccountRpc,
  startSignInRpc,
  submitSignInRpc,
  switchAgentAccountRpc,
  usageStatsRpc,
  watchAccountsSubscription,
} from "./shared/contracts";
import { AccountService } from "./server/accounts";
import { ContextReader } from "./server/context";
import { UsageStatsReader } from "./server/stats";
import { PendingSwitches, registerHooks, switchAgentAccount } from "./server/hooks";
import { createUsageSource } from "./server/usage";

export default function contribute(server: PluginServerContext) {
  const service = new AccountService();
  const pending = new PendingSwitches();
  const context = new ContextReader();
  const stats = new UsageStatsReader();
  const ready = service.init();

  // Learn every account's state once in the background so the composer can show it.
  const warmup = setTimeout(() => {
    void ready.then(() => service.refreshAll()).catch((error: unknown) => {
      console.error("antigravity-accounts: initial refresh failed", error);
    });
  }, 3000);

  // Keep quota fresh for the sidebar: the default account often, every account now and then.
  const quotaTimer = setInterval(() => {
    void ready
      .then(async () => {
        const state = await service.state();
        await service.refreshOne(state.defaultAccountId);
      })
      .catch(() => undefined);
  }, 3 * 60_000);
  const sweepTimer = setInterval(() => {
    void ready.then(() => service.refreshAll()).catch(() => undefined);
  }, 15 * 60_000);

  const removers = registerHooks(server, service, pending);
  server.registerUsageSource(createUsageSource(service));

  server.handle(listAccountsRpc, async ({ refresh }) => {
    await ready;
    if (refresh) await service.refreshAll();
    return service.state();
  });

  server.handle(refreshAccountsRpc, async ({ accountId }) => {
    await ready;
    if (accountId) {
      service.requireAccount(accountId);
      await service.refreshOne(accountId);
    } else {
      await service.refreshAll();
    }
    return service.state();
  });

  server.handle(createAccountRpc, async ({ label }) => {
    await ready;
    const account = await service.create(label);
    return { account, state: await service.state() };
  });

  server.handle(renameAccountRpc, async ({ accountId, label }) => {
    await ready;
    await service.rename(accountId, label);
    return service.state();
  });

  server.handle(setDefaultAccountRpc, async ({ accountId }) => {
    await ready;
    await service.setDefault(accountId);
    return service.state();
  });

  server.handle(removeAccountRpc, async ({ accountId }) => {
    await ready;
    await service.remove(accountId);
    return service.state();
  });

  server.handle(signOutAccountRpc, async ({ accountId }) => {
    await ready;
    await service.signOut(accountId);
    return service.state();
  });

  server.handle(startSignInRpc, async ({ accountId }) => {
    await ready;
    return service.startSignIn(accountId);
  });

  server.handle(submitSignInRpc, async ({ loginId, code }) => {
    await ready;
    await service.submitSignIn(loginId, code);
    return service.state();
  });

  server.handle(cancelSignInRpc, async ({ loginId }) => {
    service.cancelSignIn(loginId);
    return {};
  });

  server.handle(switchAgentAccountRpc, async (input, { paseo }) => {
    await ready;
    return switchAgentAccount(paseo, service, pending, input);
  });

  server.handle(usageStatsRpc, async ({ range }) => stats.summary(range));

  server.handle(contextUsageRpc, async ({ agentIds }, { paseo }) => context.usage(paseo, agentIds));

  // Must return synchronously: a returned promise closes the subscription when it settles.
  server.handle(watchAccountsSubscription, (_input, { push, signal }) => {
    const stop = service.onChange((revision) => {
      void push({ revision }).catch(() => undefined);
    });
    signal.addEventListener("abort", stop, { once: true });
    void ready.then(() => push({ revision: service.currentRevision() })).catch(() => undefined);
  });

  return () => {
    clearTimeout(warmup);
    clearInterval(quotaTimer);
    clearInterval(sweepTimer);
    for (const remove of removers) remove();
    service.dispose();
  };
}
