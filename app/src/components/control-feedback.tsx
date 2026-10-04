import { controlLabel } from "@/control-intent";
import type { useVehicleControl } from "@/hooks/use-vehicle-control";
import { lockCommandTerminal } from "@vwapp/contract/lock-command";
import { Alert } from "react-native";
import { Paragraph, XStack, YStack } from "tamagui";
import { IosButton } from "./ios-list";

export function ControlFeedback({
  control,
}: {
  control: ReturnType<typeof useVehicleControl>;
}) {
  const { receipt, intent, send, reconcile, dismiss } = control;
  const command = receipt.data;
  const terminal = command === undefined || lockCommandTerminal(command.status);
  return (
    <YStack gap="$2">
      {controlLabel(command, send.isPending) !== null ? (
        <Paragraph color="$color10">
          {controlLabel(command, send.isPending)}
        </Paragraph>
      ) : null}
      {control.error !== null ? (
        <Paragraph color="$red10">{control.error.message}</Paragraph>
      ) : null}
      {intent.data != null ? (
        <XStack gap="$2">
          <IosButton
            tone="blue"
            label="Check saved request"
            disabled={!control.allowed || send.isPending || !terminal}
            onPress={() => {
              if (intent.data != null) send.mutate(intent.data);
            }}
          />
          {command?.acceptedAt != null &&
          command.status !== "confirmed" &&
          command.status !== "failed" ? (
            <IosButton
              tone="blue"
              label="Check vehicle"
              disabled={
                !control.allowed || reconcile.isPending || send.isPending
              }
              onPress={() => {
                reconcile.mutate();
              }}
            />
          ) : null}
          {terminal ? (
            <IosButton
              tone="blue"
              variant="plain"
              label="Dismiss result"
              disabled={send.isPending || dismiss.isPending}
              onPress={() => {
                Alert.alert(
                  "Dismiss command result?",
                  "An uncertain command may still execute. Check the vehicle before choosing a new action. The server keeps the original record.",
                  [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: "Dismiss",
                      onPress: () => {
                        dismiss.mutate();
                      },
                    },
                  ],
                );
              }}
            />
          ) : null}
        </XStack>
      ) : null}
    </YStack>
  );
}
