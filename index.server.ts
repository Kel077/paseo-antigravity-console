import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  cancelSignInRpc,
  contextUsageRpc,
  createAccountRpc,
  getOrchestratorRpc,
  listAccountsRpc,
  listSubagentsRpc,
  refreshAccountsRpc,
  removeAccountRpc,
  renameAccountRpc,
  savedFilesRpc,
  setFallbackRpc,
  setDefaultAccountRpc,
  setOrchestratorRpc,
  signOutAccountRpc,
  startSignInRpc,
  submitSignInRpc,
  subagentCountsRpc,
  subagentDetailRpc,
  switchAgentAccountRpc,
  usageStatsRpc,
  watchAccountsSubscription,
} from "./shared/contracts";
import { AccountService } from "./server/accounts";
import { ContextReader } from "./server/context";
import { FallbackController } from "./server/fallback";
import { OrchestratorSettings } from "./server/orchestrator";
import { SubagentReader } from "./server/subagents";
import { UsageStatsReader } from "./server/stats";
import { PendingSwitches, registerHooks, switchAgentAccount } from "./server/hooks";
import { createUsageSource } from "./server/usage";

export default function contribute(server: PluginServerContext) {
  const service = new AccountService();
  const pending = new PendingSwitches();
  const context = new ContextReader();
  const stats = new UsageStatsReader();
  const subagents = new SubagentReader(context);
  const orchestrator = new OrchestratorSettings(service);
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

  const fallback = new FallbackController(service, pending);
  const removers = registerHooks(server, service, pending, fallback);
  removers.push(fallback.register(server));
  removers.push(...orchestrator.register(server));
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

  server.handle(setFallbackRpc, async (patch) => {
    await ready;
    await service.setFallback(patch);
    return service.state();
  });

  server.handle(setDefaultAccountRpc, async ({ accountId }) => {
    await ready;
    await service.setDefault(accountId);
    return service.state();
  });

  server.handle(savedFilesRpc, async ({ accountId }) => {
    await ready;
    return service.savedFiles(accountId);
  });

  server.handle(removeAccountRpc, async ({ accountId }) => {
    await ready;
    const moved = await service.remove(accountId);
    return { state: await service.state(), moved };
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

  server.handle(listSubagentsRpc, async ({ agentId }, { paseo }) => subagents.list(paseo, agentId));

  server.handle(subagentCountsRpc, async ({ agentIds }, { paseo }) => ({
    counts: await subagents.counts(paseo, agentIds),
  }));

  server.handle(subagentDetailRpc, async ({ agentId, subagentId }, { paseo }) =>
    subagents.detail(paseo, agentId, subagentId),
  );

  server.handle(getOrchestratorRpc, async ({ refresh }) => {
    await ready;
    return orchestrator.state(refresh ?? false);
  });

  server.handle(setOrchestratorRpc, async ({ planner, executor, applyTo }, { paseo }) => {
    await ready;
    const state = await orchestrator.save({ planner, executor });
    const applied = applyTo ? await orchestrator.apply(paseo, applyTo) : "none";
    return { state, applied };
  });

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
    fallback.dispose();
    service.dispose();
  };
}
