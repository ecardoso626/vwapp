import { BuzzKeyApiError } from "@/buzzkey-client";
import { requireBuzzKey } from "@/buzzkey-native";
import { DeviceIdentityRecoveryError } from "@/device-identity";
import { usePassiveOwner } from "@/hooks/use-passive-data";
import {
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { AccountConnection } from "@vwapp/contract/account";
import { createContext, use, type ReactNode } from "react";

interface Session {
  isLoading: boolean;
  paired: boolean;
  accountLinked: boolean;
  vehicleAvailable: boolean;
  connection: AccountConnection | undefined;
  initError: string | null;
  retry: () => void;
  retrying: boolean;
  signOut: () => void;
  signOutError: string | null;
  accountError: string | null;
  reconnect: ReturnType<typeof useReconnect>;
}
const SessionContext = createContext<Session | null>(null);
export function useSession(): Session {
  const context = use(SessionContext);
  if (context === null) throw new Error("SessionProvider required");
  return context;
}
function useReconnect(onSuccess: () => Promise<void>) {
  return useMutation({
    mutationKey: ["buzzkey", "account-action"],
    mutationFn: () => requireBuzzKey().reconnect(),
    retry: false,
    onSuccess,
  });
}
/** Device authorization is independent of VW connection and legacy identity. */
export function SessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const changingAccount =
    useIsMutating({ mutationKey: ["buzzkey", "account-action"] }) > 0;
  const owner = usePassiveOwner();
  const account = useQuery({
    queryKey: ["buzzkey", "account"],
    queryFn: () => requireBuzzKey().account(),
    enabled: owner.data !== undefined,
    retry: 1,
    refetchInterval: 45_000,
  });
  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ["buzzkey"] });
  };
  const logout = useMutation({
    mutationKey: ["buzzkey", "account-action"],
    mutationFn: () => requireBuzzKey().disconnect(),
    retry: false,
    onSuccess: invalidate,
  });
  const reconnect = useReconnect(invalidate);
  const rejected =
    owner.error instanceof DeviceIdentityRecoveryError ||
    (owner.error instanceof BuzzKeyApiError &&
      owner.error.code === "authorization_rejected") ||
    (account.error instanceof BuzzKeyApiError &&
      account.error.code === "authorization_rejected");
  const initError =
    owner.data === undefined && !rejected
      ? (owner.error?.message ?? null)
      : null;
  return (
    <SessionContext.Provider
      value={{
        isLoading:
          owner.data === undefined && owner.isPending && initError === null,
        paired: owner.data !== undefined && !rejected,
        accountLinked: account.data?.linked === true,
        vehicleAvailable: account.data?.vehicleAvailable === true,
        connection:
          account.isError || changingAccount ? undefined : account.data,
        accountError:
          account.error?.message ?? reconnect.error?.message ?? null,
        initError,
        retry: () => {
          void owner.refetch();
          void account.refetch();
        },
        retrying: owner.isFetching || account.isFetching,
        signOut: () => {
          logout.mutate();
        },
        signOutError: logout.error?.message ?? null,
        reconnect,
      }}
    >
      {children}
    </SessionContext.Provider>
  );
}
