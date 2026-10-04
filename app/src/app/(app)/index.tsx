import { openSummary, strArr, unlockedSummary } from "@/closures";
import { ChargeControl } from "@/components/charge-control";
import { ClimateControl } from "@/components/climate-control";
import { IosButton, IosCard, IosGroup, IosRow } from "@/components/ios-list";
import { LockControl } from "@/components/lock-control";
import { agoLabel, useNow } from "@/hooks/use-now";
import {
  useFirstPassiveVehicle,
  type PassiveSnapshot,
} from "@/hooks/use-passive-data";
import { useTransientError } from "@/hooks/use-transient-error";
import { useIosColors } from "@/ios-colors";
import { useSession } from "@/providers/session-provider";
import { formatMiles } from "@/units";
import { Stack, useRouter } from "expo-router";
import { useState } from "react";
import { RefreshControl, ScrollView } from "react-native";
import {
  AnimatePresence,
  Paragraph,
  Spinner,
  Text,
  useTheme,
  YStack,
} from "tamagui";

export default function Dashboard() {
  const theme = useTheme();
  const ios = useIosColors();
  const router = useRouter();
  const { signOut, signOutError, accountLinked, loggedIn, legacyError } =
    useSession();

  const { vehiclesQuery, vehicle, snapshot } = useFirstPassiveVehicle();
  const isLoading = vehiclesQuery.isLoading;
  // A failed server logout must be visible too — otherwise tapping "Sign out"
  // with the server down silently does nothing. The refresh (mutation) error
  // is transient — query errors clear themselves on recovery, but a mutation
  // error would sit there until the next refresh.
  const refreshError = useTransientError(vehiclesQuery.error);
  const errorMessage = refreshError?.message ?? signOutError;

  const noSnapshotYet =
    vehicle !== undefined &&
    !vehiclesQuery.isLoading &&
    vehiclesQuery.error === null &&
    snapshot === undefined;

  // Native RefreshControl and the header toolbar need a resolved color
  // string, not a Tamagui token.
  const tintColor = theme.color.val;

  // Pull-to-refresh reads the Node cache; it never wakes the vehicle.
  const [pulling, setPulling] = useState(false);
  const onPullRefresh = () => {
    setPulling(true);
    void vehiclesQuery.refetch().finally(() => {
      setPulling(false);
    });
  };

  // The ScrollView must be the screen's first child (no wrapper view) with
  // contentInsetAdjustmentBehavior="automatic", or UIKit won't collapse the
  // large title on scroll and content slides underneath it instead.
  return (
    <>
      {/* The title is the vehicle itself (large title collapses into the bar
          on scroll); pushed screens still label their back button "Home" via
          their own headerBackTitle. */}
      <Stack.Screen options={{ title: vehicle?.nickname ?? "My Vehicle" }} />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Menu
          icon="ellipsis.circle"
          tintColor={tintColor}
          accessibilityLabel="Menu"
        >
          <Stack.Toolbar.MenuAction
            icon="arrow.clockwise"
            onPress={() => {
              void vehiclesQuery.refetch();
            }}
          >
            Refresh
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction
            icon="gearshape"
            onPress={() => {
              router.push("/settings");
            }}
          >
            Settings
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction
            icon="person.crop.circle"
            onPress={() => {
              router.push("/login");
            }}
          >
            Legacy control sign-in
          </Stack.Toolbar.MenuAction>
          {loggedIn ? (
            <Stack.Toolbar.MenuAction
              icon="rectangle.portrait.and.arrow.right"
              destructive
              onPress={signOut}
            >
              Sign out of legacy controls
            </Stack.Toolbar.MenuAction>
          ) : null}
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>
      <ScrollView
        style={{ flex: 1 }}
        alwaysBounceVertical
        contentInsetAdjustmentBehavior="automatic"
        // paddingTop 2, not 16: the native large title already brings its own
        // bottom margin, and the VIN should read as its subline.
        contentContainerStyle={{
          padding: 16,
          paddingTop: 2,
          gap: 16,
        }}
        refreshControl={
          <RefreshControl
            refreshing={pulling}
            onRefresh={onPullRefresh}
            tintColor={tintColor}
          />
        }
      >
        {!accountLinked ? (
          <Paragraph color="$color10">
            This device is paired, but no VW account is linked in the Node
            backend yet. Passive vehicle data will appear after the owner links
            that account.
          </Paragraph>
        ) : null}
        {legacyError !== null ? (
          <Text color="$red10">Legacy controls: {legacyError}</Text>
        ) : null}
        {vehicle !== undefined ? (
          <Text selectable style={{ color: ios.secondaryLabel, fontSize: 13 }}>
            {vehicle.vin}
          </Text>
        ) : null}

        {isLoading ? (
          <Spinner
            color="$color"
            transition="quick"
            enterStyle={{ opacity: 0 }}
          />
        ) : null}
        <AnimatePresence>
          {errorMessage != null ? (
            <Text
              key="error"
              selectable
              color="$red10"
              transition="quick"
              animateOnly={["opacity"]}
              enterStyle={{ opacity: 0 }}
              exitStyle={{ opacity: 0 }}
            >
              {errorMessage}
            </Text>
          ) : null}
        </AnimatePresence>
        {!vehiclesQuery.isLoading &&
        vehiclesQuery.error === null &&
        vehicle === undefined ? (
          <Paragraph
            color="$color10"
            transition="quick"
            enterStyle={{ opacity: 0 }}
          >
            {accountLinked
              ? "No vehicles found in the linked VW account."
              : "No Node vehicle is available yet."}
          </Paragraph>
        ) : null}
        <AnimatePresence>
          {noSnapshotYet ? (
            <IosCard
              key="empty-state"
              p="$4"
              gap="$3"
              items="flex-start"
              transition="quick"
              animateOnly={["opacity", "transform"]}
              enterStyle={{ opacity: 0, y: 20 }}
              exitStyle={{ opacity: 0, y: -10 }}
            >
              <Paragraph color="$color10">
                No status stored on the BuzzKey server yet.
              </Paragraph>
              <IosButton
                tone="blue"
                label="Check server"
                onPress={() => {
                  void vehiclesQuery.refetch();
                }}
              />
            </IosCard>
          ) : null}
        </AnimatePresence>
        {snapshot !== undefined && vehicle !== undefined ? (
          <StatusCards
            s={snapshot}
            uuid={vehicle.uuid}
            controlsEnabled={loggedIn}
          />
        ) : null}
      </ScrollView>
    </>
  );
}

function StatusCards({
  s,
  uuid,
  controlsEnabled,
}: {
  s: PassiveSnapshot;
  uuid: string;
  controlsEnabled: boolean;
}) {
  // Snapshots only re-render this on arrival; tick so "Xm ago" stays honest.
  const now = useNow();
  const router = useRouter();
  const sec = securitySummary(s);
  const parked =
    s.parkedLat != null && s.parkedLng != null
      ? { lat: s.parkedLat, lng: s.parkedLng }
      : null;
  return (
    <YStack
      gap="$3"
      transition="quick"
      animateOnly={["opacity", "transform"]}
      enterStyle={{ opacity: 0, y: 20 }}
    >
      {now - s.fetchedAt > 5 * 60_000 ? (
        <Paragraph color="$yellow10">
          Cached vehicle status may be stale.
        </Paragraph>
      ) : null}
      {controlsEnabled ? (
        <>
          <ChargeControl s={s} uuid={uuid} />
          <LockControl uuid={uuid} locked={s.locked ?? null} />
          <ClimateControl uuid={uuid} />
        </>
      ) : (
        <IosCard p="$4" gap="$2">
          <Paragraph color="$color10">
            Vehicle controls still use the legacy Worker account.
          </Paragraph>
          <IosButton
            tone="blue"
            label="Sign in for controls"
            onPress={() => {
              router.push("/login");
            }}
          />
        </IosCard>
      )}
      <IosGroup>
        <IosRow label="Odometer" value={formatMiles(s.odometerKm)} />
        <IosRow
          label="Doors & windows"
          value={sec.text}
          warn={sec.warn}
          onPress={() => {
            router.push("/doors");
          }}
        />
        {parked !== null ? (
          <IosRow
            label="Parked"
            value="Location"
            onPress={() => {
              router.push("/parked");
            }}
          />
        ) : null}
        <IosRow
          label="Updated"
          value={agoLabel(s.capturedAt ?? s.createdAt, now)}
          onPress={() => {
            router.push("/updates");
          }}
        />
      </IosGroup>
      <IosGroup>
        <IosRow
          label="Activity"
          value="View"
          onPress={() => {
            router.push("/activity");
          }}
        />
        <IosRow
          label="Messages"
          value="View"
          onPress={() => {
            router.push("/messages");
          }}
        />
      </IosGroup>
    </YStack>
  );
}

/**
 * One-line "is the car sealed?" summary. Surfaces open doors/windows (or, as a
 * fallback, individually unlocked doors) as a warning; otherwise reassures.
 */
function securitySummary(s: PassiveSnapshot): { text: string; warn: boolean } {
  const open = openSummary(strArr(s.openDoors), strArr(s.openWindows));
  if (open !== null) return { text: open, warn: true };
  const unlocked = unlockedSummary(strArr(s.unlockedDoors));
  if (unlocked !== null) return { text: unlocked, warn: true };
  if (s.openDoors === null || s.openWindows === null)
    return { text: "Status unknown", warn: false };
  return { text: "All closed", warn: false };
}
