import { requireBuzzKey } from "@/buzzkey-native";
import { lockPresentation } from "@/lock-intent";
import {
  clearLockIntent,
  pendingLockIntent,
  requestNodeLock,
} from "@/lock-intent-native";
import { useSession } from "@/providers/session-provider";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  lockCommandTerminal,
  type LockCommand,
  type LockRequest,
} from "@vwapp/contract/lock-command";
import { useEffect } from "react";
import { Alert } from "react-native";
import { Paragraph, Spinner, Text, XStack, YStack } from "tamagui";
import { IosButton, IosCard } from "./ios-list";
import { SfIcon } from "./sf-icon";

/** Every icon/state comes from observed data; intent affects progress text only. */
export function LockControl({
  vehicleId,
  locked,
  fetchedAt,
}: {
  vehicleId: string;
  locked: boolean | null;
  fetchedAt: number;
}) {
  const { connection } = useSession();
  const allowed =
    connection?.linked === true &&
    connection.state === "connected" &&
    connection.session === "usable";
  const queryClient = useQueryClient();
  const intentKey = ["buzzkey", "lock-intent", vehicleId];
  const intent = useQuery({
    queryKey: intentKey,
    queryFn: () => pendingLockIntent(vehicleId),
    retry: false,
  });
  const statusKey = [
    "buzzkey",
    "lock-command",
    vehicleId,
    intent.data?.idempotencyKey ?? "",
  ];
  const status = useQuery({
    queryKey: statusKey,
    queryFn: () =>
      requireBuzzKey().lockCommandByKey(intent.data?.idempotencyKey ?? ""),
    enabled: allowed && intent.data != null,
    retry: false,
    refetchInterval: (query) =>
      query.state.error !== null ||
      (query.state.data !== undefined &&
        lockCommandTerminal(query.state.data.status))
        ? false
        : 1500,
  });
  const request = useMutation({
    mutationFn: (action: LockRequest["action"]) =>
      requestNodeLock(vehicleId, action, (prepared) => {
        queryClient.setQueryData(intentKey, prepared);
      }),
    retry: false,
    onSuccess: (receipt) => {
      const saved = queryClient.getQueryData<LockRequest>(intentKey);
      if (saved !== undefined)
        queryClient.setQueryData(
          ["buzzkey", "lock-command", vehicleId, saved.idempotencyKey],
          receipt,
        );
    },
  });
  const reconcile = useMutation({
    mutationFn: (command: LockCommand) =>
      requireBuzzKey().reconcileLockCommand(command.id),
    retry: false,
    onSuccess: () => {
      void status.refetch();
    },
  });
  const forget = useMutation({
    mutationFn: () => clearLockIntent(vehicleId),
    retry: false,
    onSuccess: () => {
      queryClient.setQueryData(intentKey, null);
      request.reset();
      reconcile.reset();
    },
  });
  useEffect(() => {
    if (
      status.data !== undefined &&
      ["confirmed", "failed"].includes(status.data.status)
    )
      void queryClient.invalidateQueries({ queryKey: ["buzzkey", "vehicles"] });
  }, [status.data, queryClient]);
  const command = status.data;
  const presentation = lockPresentation(
    command,
    {
      lock: locked === null ? "unknown" : locked ? "locked" : "unlocked",
      fetchedAt,
    },
    request.isPending,
    request.variables ?? intent.data?.action ?? "lock",
  );
  const unresolved = intent.data != null;
  const error =
    intent.error ??
    request.error ??
    reconcile.error ??
    forget.error ??
    status.error;
  const pending =
    request.isPending ||
    reconcile.isPending ||
    (command !== undefined && !lockCommandTerminal(command.status));
  const run = (action: LockRequest["action"]) => {
    if (allowed && !unresolved && !pending) request.mutate(action);
  };
  const unlock = () => {
    Alert.alert(
      "Unlock the doors?",
      "Anyone nearby will be able to open your vehicle until it is locked again.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Unlock",
          onPress: () => {
            run("unlock");
          },
        },
      ],
    );
  };
  const retry = () => {
    if (!allowed || intent.data == null) return;
    const action = intent.data.action;
    if (action === "unlock")
      Alert.alert(
        "Retry the saved unlock request?",
        "The same request key will be reused; this does not create a second command.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Check / retry",
            onPress: () => {
              request.mutate(action);
            },
          },
        ],
      );
    else request.mutate(action);
  };
  const resolve = () => {
    const uncertain =
      command === undefined ||
      command.status === "unknown" ||
      command.status === "timed_out";
    Alert.alert(
      uncertain ? "Resolve uncertain request?" : "Dismiss command result?",
      uncertain
        ? "The vehicle may still execute the old command. Check the car before choosing a new command. This clears only this phone's saved request; the server record remains."
        : "The server keeps the command record and idempotency key.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Dismiss",
          onPress: () => {
            forget.mutate();
          },
        },
      ],
    );
  };
  return (
    <IosCard p="$4" gap="$3">
      <XStack items="center" gap="$3">
        <SfIcon
          name={
            presentation.lock === "unlocked" ? "lock.open.fill" : "lock.fill"
          }
          color={
            presentation.lock === "unlocked"
              ? "$red10"
              : presentation.lock === "locked"
                ? "$green10"
                : "$color10"
          }
          size={26}
        />
        <YStack flex={1}>
          <Paragraph color="$color" fontWeight="700" fontSize="$6">
            {presentation.label}
          </Paragraph>
          {command !== undefined && command.status !== "confirmed" ? (
            <Paragraph color="$color10" fontSize="$2">
              Observed: {presentation.physicalLabel}
            </Paragraph>
          ) : null}
        </YStack>
        {pending ? <Spinner color="$color10" /> : null}
        {!unresolved && presentation.lock !== "unlocked" ? (
          <IosButton
            tone="blue"
            label="Unlock"
            disabled={!allowed || intent.isPending || pending}
            onPress={unlock}
          />
        ) : null}
        {!unresolved && presentation.lock !== "locked" ? (
          <IosButton
            tone="green"
            label="Lock"
            disabled={!allowed || intent.isPending || pending}
            onPress={() => {
              run("lock");
            }}
          />
        ) : null}
      </XStack>
      {!allowed ? (
        <Paragraph color="$color10">
          Connect or reconnect VW on BuzzKey to use lock controls.
        </Paragraph>
      ) : null}
      {unresolved ? (
        <XStack gap="$2">
          <IosButton
            tone="blue"
            label="Check / retry request"
            disabled={!allowed || pending}
            onPress={retry}
          />
          {command?.acceptedAt != null &&
          ["unknown", "timed_out", "waiting_for_vehicle"].includes(
            command.status,
          ) ? (
            <IosButton
              tone="blue"
              label="Check vehicle"
              disabled={!allowed || reconcile.isPending || request.isPending}
              onPress={() => {
                reconcile.mutate(command);
              }}
            />
          ) : null}
          {command === undefined || lockCommandTerminal(command.status) ? (
            <IosButton
              tone="blue"
              variant="plain"
              label="Dismiss result"
              disabled={request.isPending || forget.isPending}
              onPress={resolve}
            />
          ) : null}
        </XStack>
      ) : null}
      {error !== null ? (
        <Text color="$red10" fontSize="$2">
          {error.message}
        </Text>
      ) : null}
    </IosCard>
  );
}
