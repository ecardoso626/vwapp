import { requireBuzzKey } from "@/buzzkey-native";
import { useFirstPassiveVehicle } from "@/hooks/use-passive-data";
import { useVehicleControl } from "@/hooks/use-vehicle-control";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { Paragraph, XStack, YStack } from "tamagui";
import { ControlFeedback } from "./control-feedback";
import { IosButton, IosCard } from "./ios-list";
import { SfIcon } from "./sf-icon";

export function ClimateControl({ vehicleId }: { vehicleId: string }) {
  const router = useRouter();
  const control = useVehicleControl(vehicleId, "climate");
  const { passiveVehicle } = useFirstPassiveVehicle();
  const climate = passiveVehicle?.current?.state.climate;
  const camp = useQuery({
    queryKey: ["buzzkey", "camp", vehicleId],
    queryFn: () => requireBuzzKey().camp(vehicleId),
    refetchInterval: 5000,
    retry: 1,
  });
  const session = camp.data?.session;
  const open = () => {
    router.push({
      pathname: "/climate",
      params: {
        vehicleId,
        ...(session == null
          ? {}
          : {
              mode: "adjust",
              tempF: String(session.tempF),
              endMs: String(session.expiresAt),
            }),
      },
    });
  };
  return (
    <IosCard p="$4" gap="$3">
      <XStack items="center" gap="$3">
        <SfIcon name="thermometer.medium" color="$color10" size={26} />
        <YStack flex={1}>
          <Paragraph fontWeight="700" fontSize="$6">
            {climate?.activity === "active"
              ? "Climate on"
              : climate?.activity === "inactive"
                ? "Climate off"
                : "Climate status unknown"}
          </Paragraph>
          {climate?.fetchedAt !== undefined ? (
            <Paragraph color="$color10">
              Last climate check {new Date(climate.fetchedAt).toLocaleString()}
            </Paragraph>
          ) : null}
          {session != null ? (
            <Paragraph color="$color10">
              Camp Mode ({session.controlState}) · {String(session.tempF)}°F ·
              until {new Date(session.expiresAt).toLocaleTimeString()}
            </Paragraph>
          ) : null}
        </YStack>
        <IosButton
          tone="blue"
          label={session?.state !== "active" ? "Start" : "Adjust"}
          disabled={!control.canSend}
          onPress={open}
        />
        <IosButton
          tone="red"
          label="Stop"
          disabled={!control.canSend}
          onPress={() => {
            control.send.mutate({ vehicleId, action: "climate_stop" });
          }}
        />
      </XStack>
      {session?.automationEnabled === true &&
      camp.data?.schedulerEnabled === false ? (
        <Paragraph color="$yellow10">
          Camp Mode schedule is saved. Server automation is disabled; it will
          not restart or stop climate automatically.
        </Paragraph>
      ) : null}
      {camp.error !== null ? (
        <Paragraph color="$red10">{camp.error.message}</Paragraph>
      ) : null}
      <ControlFeedback control={control} />
    </IosCard>
  );
}
