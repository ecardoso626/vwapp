import { IosButton, IosGroup, IosRow } from "@/components/ios-list";
import { agoLabel, useNow } from "@/hooks/use-now";
import { useFirstPassiveVehicle } from "@/hooks/use-passive-data";
import { useIosColors } from "@/ios-colors";
import { orpc } from "@/rpc";
import { useMutation } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { ScrollView } from "react-native";
import { Paragraph, Spinner, Text } from "tamagui";

/**
 * What "Updated" means, a manual refresh (wake) button, and the per-category
 * update times VW reports alongside the data.
 */
export default function UpdatesScreen() {
  const now = useNow();
  const ios = useIosColors();
  const { vehiclesQuery, snapshot } = useFirstPassiveVehicle();
  const isLoading = vehiclesQuery.isLoading;

  const refresh = useMutation(orpc.vehicle.refresh.mutationOptions());
  const errorMessage = (vehiclesQuery.error ?? refresh.error)?.message;

  return (
    <>
      <Stack.Screen
        options={{ title: "Status updates", headerBackTitle: "Home" }}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: 16, gap: 16 }}
      >
        <Paragraph
          style={{ color: ios.secondaryLabel, fontSize: 15, lineHeight: 20 }}
        >
          These times distinguish the car’s reported updates from when the
          BuzzKey server received them. “Refresh now” uses the legacy Worker
          wake path; passive screens otherwise read the server cache. The Worker
          refresh does not update the separate Node cache immediately.
        </Paragraph>

        <IosButton
          full
          tone="blue"
          icon="arrow.clockwise"
          disabled={refresh.isPending}
          onPress={() => {
            refresh.mutate(
              {},
              {
                onSuccess: () => {
                  void vehiclesQuery.refetch();
                },
              },
            );
          }}
          label={refresh.isPending ? "Refreshing…" : "Refresh now"}
        />

        {isLoading ? (
          <Spinner
            color="$color"
            transition="quick"
            enterStyle={{ opacity: 0 }}
          />
        ) : null}
        {errorMessage != null ? (
          <Text selectable color="$red10">
            {errorMessage}
          </Text>
        ) : null}

        {snapshot !== undefined ? (
          <IosGroup>
            <WhenRow
              label="Car check-in"
              at={snapshot.capturedAt ?? null}
              now={now}
            />
            <WhenRow
              label="Vehicle status"
              at={snapshot.rvsUpdatedAt ?? null}
              now={now}
            />
            <WhenRow
              label="Doors"
              at={snapshot.doorsUpdatedAt ?? null}
              now={now}
            />
            <WhenRow
              label="Locks"
              at={snapshot.locksUpdatedAt ?? null}
              now={now}
            />
            <WhenRow
              label="Windows"
              at={snapshot.windowsUpdatedAt ?? null}
              now={now}
            />
            <WhenRow
              label="Battery & charging"
              at={snapshot.chargeUpdatedAt ?? null}
              now={now}
            />
            <WhenRow
              label="Parked location"
              at={snapshot.parkedAt ?? null}
              now={now}
            />
            <WhenRow
              label="Received by server"
              at={snapshot.createdAt}
              now={now}
            />
          </IosGroup>
        ) : !isLoading && errorMessage == null ? (
          <Paragraph color="$color10">No status stored yet.</Paragraph>
        ) : null}
      </ScrollView>
    </>
  );
}

/** Category + when it last updated: absolute clock time, relative underneath. */
function WhenRow({
  label,
  at,
  now,
}: {
  label: string;
  at: number | null;
  now: number;
}) {
  if (at === null) return <IosRow label={label} value="—" />;
  return (
    <IosRow
      label={label}
      value={clockLabel(at, now)}
      subValue={agoLabel(at, now)}
    />
  );
}

/** "8:40 PM" today; otherwise prefixed with the day ("Jun 9, 8:40 PM"). */
function clockLabel(epochMs: number, now: number): string {
  const d = new Date(epochMs);
  const time = d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  if (d.toDateString() === new Date(now).toDateString()) return time;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}
