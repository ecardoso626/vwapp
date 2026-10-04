import { snapshotUpdates, type UpdateEvent } from "@/activity-events";
import { IosGroup, IosRow } from "@/components/ios-list";
import {
  stateToSnapshot,
  useFirstPassiveVehicle,
  usePassiveHistory,
} from "@/hooks/use-passive-data";
import { Stack } from "expo-router";
import { RefreshControl, ScrollView } from "react-native";
import { Paragraph, Spinner, Text, useTheme } from "tamagui";

/**
 * Observed vehicle changes from the Node/SQLite history. Commands are not
 * represented as observations until the vehicle actually reports a change.
 */
export default function ActivityScreen() {
  // Native RefreshControl needs a resolved color string, not a Tamagui token.
  const theme = useTheme();
  const { vehiclesQuery, vehicle } = useFirstPassiveVehicle();
  const history = usePassiveHistory(vehicle?.id);
  const events = snapshotUpdates(
    (history.data?.observations ?? []).map((row) =>
      stateToSnapshot(row.state, row.recordedAt),
    ),
  ).sort((a, b) => b.at - a.at);
  const isPending =
    vehiclesQuery.isPending || (vehicle !== undefined && history.isPending);
  const errorMessage = (vehiclesQuery.error ?? history.error)?.message;

  return (
    <>
      <Stack.Screen options={{ title: "Activity", headerBackTitle: "Home" }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: 16, gap: 12 }}
        refreshControl={
          <RefreshControl
            refreshing={history.isRefetching}
            onRefresh={() => {
              void history.refetch();
            }}
            tintColor={theme.color.val}
          />
        }
      >
        {isPending ? <Spinner color="$color" /> : null}
        {errorMessage !== undefined ? (
          <Text selectable color="$red10">
            {errorMessage}
          </Text>
        ) : null}
        {!isPending && errorMessage === undefined && events.length === 0 ? (
          <Paragraph color="$color10">No recent activity.</Paragraph>
        ) : null}
        {events.length > 0 ? (
          <IosGroup>
            {events.map((e, i) => (
              <ActivityRow key={`${String(e.at)}-${String(i)}`} e={e} />
            ))}
          </IosGroup>
        ) : null}
      </ScrollView>
    </>
  );
}

interface Row {
  at: number | null;
  title: string;
  description: string | null;
  icon: UpdateEvent["icon"];
}

function ActivityRow({ e }: { e: Row }) {
  return (
    <IosRow
      icon={e.icon}
      label={e.title}
      subtitle={e.description ?? undefined}
      value={e.at != null ? formatWhen(e.at) : undefined}
      multiline
    />
  );
}

function formatWhen(epochMs: number): string {
  return new Date(epochMs).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
