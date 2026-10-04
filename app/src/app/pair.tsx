import { requireBuzzKey } from "@/buzzkey-native";
import { IosButton } from "@/components/ios-list";
import { resetDeviceIdentity } from "@/device-identity-native";
import { passiveKeys } from "@/hooks/use-passive-data";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from "react-native";
import { H2, Input, Paragraph, Text, YStack } from "tamagui";

/** One-owner administrator-assisted pairing; no relay or consumer signup. */
export default function PairScreen() {
  const queryClient = useQueryClient();
  const [token, setToken] = useState("");
  const [name, setName] = useState("BuzzKey iPhone");
  const pair = useMutation({
    mutationFn: () => requireBuzzKey().pair(token.trim(), name.trim()),
    onSuccess: async () => {
      setToken("");
      await queryClient.invalidateQueries({ queryKey: passiveKeys.owner });
    },
  });

  return (
    <>
      <Stack.Screen options={{ title: "Pair this device" }} />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={{ padding: 24 }}
          keyboardShouldPersistTaps="handled"
        >
          <YStack gap="$4">
            <H2 color="$color">Pair BuzzKey</H2>
            <Paragraph color="$color10">
              Ask the owner to issue a one-time pairing token from the local
              BuzzKey admin tool. Enter it here over your private HTTPS
              connection.
            </Paragraph>
            <Input
              value={name}
              onChangeText={setName}
              placeholder="Device name"
              autoCapitalize="words"
              accessibilityLabel="Device name"
            />
            <Input
              value={token}
              onChangeText={setToken}
              placeholder="One-time pairing token"
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="One-time pairing token"
            />
            {pair.error ? (
              <Text color="$red10">{pair.error.message}</Text>
            ) : null}
            <IosButton
              tone="blue"
              label={pair.isPending ? "Pairing…" : "Pair device"}
              disabled={
                pair.isPending || token.trim() === "" || name.trim() === ""
              }
              onPress={() => {
                pair.mutate();
              }}
            />
            <Paragraph color="$color10">
              If this device was revoked or its secure key is damaged, reset its
              device identity and ask the owner for a new pairing token. This
              removes its current authorization.
            </Paragraph>
            <IosButton
              tone="red"
              label="Reset device identity"
              onPress={() => {
                Alert.alert(
                  "Reset device identity?",
                  "This device will need a new pairing token before it can read BuzzKey data.",
                  [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: "Reset",
                      style: "destructive",
                      onPress: () => {
                        void resetDeviceIdentity()
                          .then(() => {
                            pair.reset();
                            return queryClient.invalidateQueries({
                              queryKey: passiveKeys.owner,
                            });
                          })
                          .catch(() => {
                            Alert.alert("Could not reset device identity");
                          });
                      },
                    },
                  ],
                );
              }}
            />
          </YStack>
        </ScrollView>
      </KeyboardAvoidingView>
    </>
  );
}
