import type { PassiveSnapshot } from "@/hooks/use-passive-data";
import { useVehicleControl } from "@/hooks/use-vehicle-control";
import { useThemeToggle } from "@/providers/theme-provider";
import { formatMiles } from "@/units";
import { Gauge, Host, Text as NativeText, Picker } from "@expo/ui/swift-ui";
import {
  disabled as disabledModifier,
  gaugeStyle,
  pickerStyle,
  tag,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import { H2, Paragraph, Spinner, useTheme, XStack, YStack } from "tamagui";
import { ControlFeedback } from "./control-feedback";
import { IosButton, IosCard } from "./ios-list";
import { SfIcon } from "./sf-icon";

const LIMITS = [50, 60, 70, 80, 90, 100];

/**
 * Battery + charging card (the dashboard headline): SoC and range up top,
 * then the live charging status with its start/stop action inline (compact,
 * S-PIN-gated server-side — Stop only while actively charging, Charge only
 * when plugged in and idle). The charge limit is a native menu picker: one
 * deliberate selection commits one RPC, so VW's rate-limited EV channel sees
 * no more traffic than the old stepper's explicit Save did.
 */
export function ChargeControl({
  s,
  vehicleId,
}: {
  s: PassiveSnapshot;
  vehicleId: string;
}) {
  // The native picker/gauge need a resolved scheme to follow the in-app theme.
  const control = useVehicleControl(vehicleId, "charging");
  const allowed = control.canSend;
  const { pref } = useThemeToggle();
  const theme = useTheme();
  const pending = control.send.isPending;

  const carLimit = s.targetSoc ?? null;
  // The car can report an off-grid limit (set from its own screen); without a
  // matching tag the menu's label would render blank.
  const limitOptions =
    carLimit === null || LIMITS.includes(carLimit)
      ? LIMITS
      : [carLimit, ...LIMITS];

  const charging = isCharging(s);
  // Can start only when plugged in and not already charging.
  const canStart = s.pluggedIn === true && !charging;

  return (
    <IosCard p="$4" gap="$3.5">
      {/* Battery headline */}
      <YStack gap="$2">
        <YStack>
          <H2 color="$color">{s.soc != null ? `${String(s.soc)}%` : "—"}</H2>
          <Paragraph color="$color10">
            Battery
            {s.rangeKm != null ? ` · ${formatMiles(s.rangeKm)} range` : ""}
          </Paragraph>
        </YStack>
        {s.soc != null ? (
          <Host matchContents={{ vertical: true }} colorScheme={pref}>
            <Gauge
              value={s.soc / 100}
              modifiers={[
                gaugeStyle("linearCapacity"),
                // Green while charging, red when low — like the system battery.
                tint(
                  charging
                    ? theme.green10.val
                    : s.soc <= 20
                      ? theme.red10.val
                      : theme.blue10.val,
                ),
              ]}
            />
          </Host>
        ) : null}
      </YStack>

      {/* Charging status, with its action inline */}
      <XStack items="center" gap="$3">
        {charging ? (
          <SfIcon name="bolt.car.fill" color="$green10" size={26} />
        ) : (
          <SfIcon name="ev.charger.fill" color="$color10" size={26} />
        )}
        <YStack flex={1}>
          <Paragraph color={charging ? "$green10" : "$color"} fontWeight="700">
            {stateLabel(s)}
          </Paragraph>
          <Paragraph color="$color10" fontSize="$2">
            {plugLabel(s)}
          </Paragraph>
        </YStack>
        {charging ? (
          <IosButton
            tone="red"
            disabled={!allowed || pending}
            onPress={() => {
              if (allowed)
                control.send.mutate({ vehicleId, action: "charge_stop" });
            }}
            label={pending ? "Stopping…" : "Stop"}
          />
        ) : canStart ? (
          <IosButton
            tone="green"
            icon="bolt.car.fill"
            disabled={!allowed || pending}
            onPress={() => {
              if (allowed)
                control.send.mutate({ vehicleId, action: "charge_start" });
            }}
            label={pending ? "Starting…" : "Charge"}
          />
        ) : null}
      </XStack>

      {/* Charge limit: a native dropdown menu; selecting a value commits it. */}
      <XStack items="center" justify="space-between">
        <Paragraph color="$color10">Charge limit</Paragraph>
        <XStack items="center" gap="$2">
          {pending ? <Spinner color="$color10" /> : null}
          {carLimit !== null ? (
            <Host matchContents colorScheme={pref}>
              <Picker
                selection={carLimit}
                onSelectionChange={(next) => {
                  if (allowed && next !== carLimit && !pending) {
                    control.send.mutate({
                      vehicleId,
                      action: "charge_target",
                      targetSoc: next,
                    });
                  }
                }}
                modifiers={[
                  pickerStyle("menu"),
                  disabledModifier(!allowed || pending),
                ]}
              >
                {limitOptions.map((v) => (
                  <NativeText key={v} modifiers={[tag(v)]}>
                    {`${String(v)}%`}
                  </NativeText>
                ))}
              </Picker>
            </Host>
          ) : (
            <Paragraph color="$color" fontWeight="700">
              —
            </Paragraph>
          )}
        </XStack>
      </XStack>

      <ControlFeedback control={control} />
    </IosCard>
  );
}

function isCharging(s: PassiveSnapshot): boolean {
  return s.chargeState === "charging";
}

function stateLabel(s: PassiveSnapshot): string {
  if (s.chargeState === "unknown") return "Charging status unknown";
  if (!isCharging(s))
    return s.pluggedIn === true ? "Plugged in, idle" : "Not charging";
  const power =
    s.chargePowerKw != null && s.chargePowerKw > 0
      ? ` ${String(s.chargePowerKw)} kW`
      : "";
  // minutesToFull is whole minutes, so <1m arrives as 0 and drops the estimate.
  const eta =
    s.minutesToFull != null && s.minutesToFull > 0
      ? ` · ${fmtEta(s.minutesToFull)} to full`
      : "";
  return `Charging${power}${eta}`;
}

/** "42m" under an hour (the rounded hour would read 0h/0.1h), "1.5h" above. */
function fmtEta(minutes: number): string {
  if (minutes < 60) return `${String(minutes)}m`;
  return `${String(Math.round((minutes / 60) * 10) / 10)}h`;
}

function plugLabel(s: PassiveSnapshot): string {
  if (s.pluggedIn == null) return "Plug status unknown";
  if (!s.pluggedIn) return "Unplugged";
  return s.plugLocked === true ? "Connected · locked" : "Connected";
}
