import type { AccountAttempt } from "@vwapp/contract/account";
import {
  createContext,
  use,
  useCallback,
  useMemo,
  useState,
  type ReactNode,
} from "react";

interface LoginFlow {
  attempt: AccountAttempt | null;
  setAttempt: (attempt: AccountAttempt) => void;
  clear: () => void;
}

const LoginFlowContext = createContext<LoginFlow | null>(null);

export function useLoginFlow(): LoginFlow {
  const ctx = use(LoginFlowContext);
  if (ctx === null)
    throw new Error("useLoginFlow must be used within LoginFlowProvider");
  return ctx;
}

/** Only an expiring opaque attempt crosses screens; passwords and PINs do not. */
export function LoginFlowProvider({ children }: { children: ReactNode }) {
  const [attempt, setAttemptState] = useState<AccountAttempt | null>(null);
  // Stable identities so the S-PIN screen's unmount-cleanup effect doesn't loop.
  const setAttempt = useCallback((c: AccountAttempt) => {
    setAttemptState(c);
  }, []);
  const clear = useCallback(() => {
    setAttemptState(null);
  }, []);
  const value = useMemo<LoginFlow>(
    () => ({ attempt, setAttempt, clear }),
    [attempt, setAttempt, clear],
  );
  return (
    <LoginFlowContext.Provider value={value}>
      {children}
    </LoginFlowContext.Provider>
  );
}
