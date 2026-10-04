import { IosGroup, IosRow } from "@/components/ios-list";
import { SfIcon } from "@/components/sf-icon";
import { agoLabel, useNow } from "@/hooks/use-now";
import { useFirstPassiveVehicle } from "@/hooks/use-passive-data";
import { useIosColors } from "@/ios-colors";
import { useThemeToggle } from "@/providers/theme-provider";
import { Stack } from "expo-router";
import type { ReactNode } from "react";
import {
  ActionSheetIOS,
  Alert,
  Linking,
  Platform,
  Pressable,
  ScrollView,
} from "react-native";
import { Paragraph, Spinner, Text, YStack } from "tamagui";

const MAP_HEIGHT = 200;

/**
 * Where the car last parked: an inline Apple Maps snapshot plus the location
 * details from VW. Tapping the map offers a native "open in Apple/Google Maps"
 * action sheet.
 */
export default function ParkedScreen() {
  const now = useNow();
  const ios = useIosColors();
  const { vehiclesQuery, snapshot } = useFirstPassiveVehicle();
  const isLoading = vehiclesQuery.isLoading;
  const errorMessage = vehiclesQuery.error?.message;

  const parked =
    snapshot?.parkedLat != null && snapshot.parkedLng != null
      ? {
          lat: snapshot.parkedLat,
          lng: snapshot.parkedLng,
          at: snapshot.parkedAt ?? null,
        }
      : null;

  return (
    <>
      <Stack.Screen
        options={{ title: "Parked location", headerBackTitle: "Home" }}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: 16, gap: 16 }}
      >
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
        {!isLoading && errorMessage == null && parked === null ? (
          <Paragraph color="$color10">
            No parked location stored. The car reports where it parked when it’s
            switched off; it should appear after the next check-in.
          </Paragraph>
        ) : null}

        {parked !== null ? (
          <YStack
            gap="$4"
            transition="quick"
            animateOnly={["opacity", "transform"]}
            enterStyle={{ opacity: 0, y: 20 }}
          >
            <MapPanel lat={parked.lat} lng={parked.lng} />

            <IosGroup>
              <IosRow
                icon="mappin.and.ellipse"
                iconColor={ios.blue}
                label="Last parked"
                subtitle={
                  parked.at !== null
                    ? `${clockLabel(parked.at, now)} · ${agoLabel(parked.at, now)}`
                    : undefined
                }
              />
              <IosRow
                label="Coordinates"
                value={`${parked.lat.toFixed(5)}, ${parked.lng.toFixed(5)}`}
              />
            </IosGroup>
          </YStack>
        ) : null}
      </ScrollView>
    </>
  );
}

/** Centered fill used for the map's loading and error states. */
function MapBox({ children }: { children?: ReactNode }) {
  return (
    <YStack flex={1} bg="$color2" items="center" justify="center" gap="$2">
      {children}
    </YStack>
  );
}

/**
 * Coordinate placeholder for the future native map. No Worker signing or hosted preview request.
 */
function MapPanel({ lat, lng }: { lat: number; lng: number }) {
  const { pref } = useThemeToggle();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Open parked location in Maps"
      onPress={() => {
        chooseMapsApp(lat, lng, pref);
      }}
    >
      <YStack height={MAP_HEIGHT} rounded={10} overflow="hidden">
        <MapBox>
          <SfIcon name="map" color="$color10" size={28} />
          <Paragraph color="$color10">
            {lat.toFixed(5)}, {lng.toFixed(5)}
          </Paragraph>
          <Paragraph color="$color10" fontSize="$2">
            Open parked location in Maps. Native preview is planned.
          </Paragraph>
        </MapBox>
      </YStack>
    </Pressable>
  );
}

/**
 * Native "open in…" chooser for the parked location: a real iOS action sheet
 * (matched to the in-app theme), with an Alert fallback off-iOS. Index 0 = Apple
 * Maps, 1 = Google Maps.
 */
function chooseMapsApp(
  lat: number,
  lng: number,
  scheme: "light" | "dark",
): void {
  const open = (index: number) => {
    if (index === 0) void Linking.openURL(appleMapsUrl(lat, lng));
    else if (index === 1) void openGoogleMaps(lat, lng);
  };
  if (Platform.OS === "ios") {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: "Open parked location",
        options: ["Open in Apple Maps", "Open in Google Maps", "Cancel"],
        cancelButtonIndex: 2,
        userInterfaceStyle: scheme,
      },
      open,
    );
  } else {
    Alert.alert("Open parked location", undefined, [
      {
        text: "Apple Maps",
        onPress: () => {
          open(0);
        },
      },
      {
        text: "Google Maps",
        onPress: () => {
          open(1);
        },
      },
      { text: "Cancel", style: "cancel" },
    ]);
  }
}

const PIN_LABEL = encodeURIComponent("My vehicle");

function appleMapsUrl(lat: number, lng: number): string {
  return `https://maps.apple.com/?ll=${String(lat)},${String(lng)}&q=${PIN_LABEL}`;
}

/**
 * Prefer the Google Maps app over its website. openURL (unlike canOpenURL)
 * needs no LSApplicationQueriesSchemes entry, so try the app's scheme and fall
 * back to the web URL when it rejects (app not installed).
 */
async function openGoogleMaps(lat: number, lng: number): Promise<void> {
  const q = `${String(lat)},${String(lng)}`;
  try {
    await Linking.openURL(`comgooglemaps://?q=${q}`);
  } catch {
    await Linking.openURL(
      `https://www.google.com/maps/search/?api=1&query=${q}`,
    );
  }
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
