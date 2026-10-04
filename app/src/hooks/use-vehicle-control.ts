import { requireBuzzKey } from "@/buzzkey-native";
import { readControlIntent, type ControlInput } from "@/control-intent";
import { controlStorage, submitControl } from "@/control-intent-native";
import { useSession } from "@/providers/session-provider";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ControlRequest } from "@vwapp/contract/control";
import { lockCommandTerminal } from "@vwapp/contract/lock-command";
import { useEffect } from "react";

export function useVehicleControl(vehicleId: string, channel: string) {
  const { connection } = useSession();
  const allowed =
    connection?.linked === true &&
    connection.state === "connected" &&
    connection.session === "usable";
  const cache = useQueryClient();
  const intentKey = ["buzzkey", "control-intent", vehicleId, channel];
  const intent = useQuery({
    queryKey: intentKey,
    queryFn: async () =>
      readControlIntent(await controlStorage(vehicleId, channel)),
    retry: false,
    enabled: vehicleId !== "",
  });
  const receiptKey = [
    "buzzkey",
    "control-receipt",
    vehicleId,
    channel,
    intent.data?.idempotencyKey ?? "",
  ];
  const receipt = useQuery({
    queryKey: receiptKey,
    queryFn: () =>
      requireBuzzKey().commandByKey(intent.data?.idempotencyKey ?? ""),
    enabled: allowed && intent.data != null,
    retry: false,
    refetchInterval: (q) =>
      q.state.error !== null ||
      (q.state.data !== undefined && lockCommandTerminal(q.state.data.status))
        ? false
        : 1500,
  });
  const send = useMutation({
    mutationFn: (input: ControlInput) =>
      submitControl(input, channel, (prepared) =>
        cache.setQueryData(intentKey, prepared),
      ),
    retry: false,
    onSuccess: (result) => {
      const saved = cache.getQueryData<ControlRequest>(intentKey);
      if (saved !== undefined)
        cache.setQueryData(
          [
            "buzzkey",
            "control-receipt",
            vehicleId,
            channel,
            saved.idempotencyKey,
          ],
          result,
        );
    },
  });
  const reconcile = useMutation({
    mutationFn: () => requireBuzzKey().reconcileCommand(receipt.data?.id ?? ""),
    retry: false,
    onSuccess: () => {
      void receipt.refetch();
    },
  });
  const dismiss = useMutation({
    mutationFn: async () => {
      await (await controlStorage(vehicleId, channel)).clear();
    },
    retry: false,
    onSuccess: () => {
      cache.setQueryData(intentKey, null);
      send.reset();
      reconcile.reset();
    },
  });
  useEffect(() => {
    if (receipt.data !== undefined && lockCommandTerminal(receipt.data.status))
      void cache.invalidateQueries({ queryKey: ["buzzkey", "vehicles"] });
  }, [receipt.data, cache]);
  return {
    allowed,
    intent,
    receipt,
    send,
    reconcile,
    dismiss,
    canSend:
      allowed &&
      intent.data == null &&
      !intent.isPending &&
      !intent.isError &&
      !send.isPending,
    error:
      intent.error ??
      send.error ??
      receipt.error ??
      reconcile.error ??
      dismiss.error,
  };
}
