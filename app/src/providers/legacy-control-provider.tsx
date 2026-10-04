import { getStoredAuthToken, setStoredAuthToken } from "@/auth-storage";
import { db } from "@/db";
import {
  passiveVehicleIdentity,
  usePassiveVehicles,
} from "@/hooks/use-passive-data";
import { matchingLegacyVehicle } from "@/legacy-control-state";
import { API_URL, orpc } from "@/rpc";
import { useQuery } from "@tanstack/react-query";
import {
  createContext,
  use,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useSession } from "./session-provider";

type LegacyDb = NonNullable<typeof db>;
interface LegacyState {
  loggedIn: boolean;
  vehicles: { id: string; uuid: string; vin: string }[];
  sessions: {
    vehicle?: { id: string } | undefined;
    tempF: number;
    expiresAt: number;
    pausedAt?: number | null | undefined;
    remainingMin?: number | null | undefined;
  }[];
  error: string | null;
}
const empty: LegacyState = {
  loggedIn: false,
  vehicles: [],
  sessions: [],
  error: null,
};
const Context = createContext(empty);
/** Optional existing Worker identity. Never creates a guest or connects an account. */
export function LegacyControlProvider({ children }: { children: ReactNode }) {
  return db === null || API_URL === null ? (
    <Context.Provider value={empty}>{children}</Context.Provider>
  ) : (
    <ConfiguredLegacyProvider database={db}>
      {children}
    </ConfiguredLegacyProvider>
  );
}
function ConfiguredLegacyProvider({
  database,
  children,
}: {
  database: LegacyDb;
  children: ReactNode;
}) {
  const auth = database.useAuth();
  const restoring = useRef(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (auth.isLoading || auth.user != null || restoring.current) return;
    restoring.current = true;
    void getStoredAuthToken()
      .then(async (token) => {
        if (token !== null) await database.auth.signInWithToken(token);
      })
      .catch(() => {
        setError("Existing legacy control session is unavailable.");
      });
  }, [auth.isLoading, auth.user, database]);
  useEffect(() => {
    if (auth.user?.refresh_token != null)
      void setStoredAuthToken(auth.user.refresh_token);
  }, [auth.user?.refresh_token]);
  const me = useQuery({
    ...orpc.auth.me.queryOptions(),
    enabled: auth.user != null,
    retry: 1,
    refetchInterval: 45_000,
  });
  const data = database.useQuery(
    auth.user == null
      ? null
      : {
          vehicles: {},
          climateSessions: { $: { where: { state: "active" } }, vehicle: {} },
        },
  );
  return (
    <Context.Provider
      value={{
        loggedIn: me.data?.loggedIn === true && !me.isError,
        vehicles: data.error == null ? (data.data?.vehicles ?? []) : [],
        sessions: data.data?.climateSessions ?? [],
        error:
          error ??
          (auth.error != null || me.isError || data.error != null
            ? "Legacy controls are unavailable."
            : null),
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useLegacyControlGate(uuid?: string) {
  const legacy = use(Context);
  const { connection } = useSession();
  const node = usePassiveVehicles();
  const vehicle = node.isError
    ? undefined
    : node.data?.vehicles.find((item) => item.identity.reference === uuid);
  const match = matchingLegacyVehicle(
    connection,
    vehicle === undefined ? undefined : passiveVehicleIdentity(vehicle),
    legacy.loggedIn,
    legacy.vehicles,
  );
  return {
    allowed: match !== undefined,
    reason:
      legacy.error ??
      "Controls require an existing Worker session for this exact VW vehicle. Connect VW on BuzzKey first; new control sessions become available after controls migrate.",
    legacyId: match?.id,
    session:
      match === undefined
        ? undefined
        : legacy.sessions.find((item) => item.vehicle?.id === match.id),
  };
}
