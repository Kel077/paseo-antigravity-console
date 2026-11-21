import { useRpc, useSubscription } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { listAccountsRpc, watchAccountsSubscription, type AccountsState } from "../shared/contracts";

const key = ["antigravity-accounts", "state"] as const;

export function useAccounts() {
  const list = useRpc(listAccountsRpc);
  const cache = useQueryClient();
  const observed = useRef(-1);
  const query = useQuery({
    queryKey: key,
    queryFn: () => list({}),
    staleTime: Infinity,
    structuralSharing(old: unknown, next: unknown) {
      const previous = old as AccountsState | undefined;
      return previous && previous.revision > (next as AccountsState).revision ? previous : next;
    },
  });
  const invalidate = () => cache.invalidateQueries({ queryKey: key });
  const watch = useSubscription(watchAccountsSubscription, {}, ({ revision }) => {
    observed.current = revision;
    if (revision > (cache.getQueryData<AccountsState>(key)?.revision ?? -1)) void invalidate();
  });
  // An event can arrive before the very first list request resolves.
  useEffect(() => {
    if (query.data && query.data.revision < observed.current) void cache.invalidateQueries({ queryKey: key });
  }, [cache, query.data, query.dataUpdatedAt]);
  return { ...query, watch, accept: (state: AccountsState) => cache.setQueryData(key, state) };
}
