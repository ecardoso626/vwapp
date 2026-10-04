import { requireBuzzKey } from "@/buzzkey-native";
import { IosButton } from "@/components/ios-list";
import { useFocusOnScreen } from "@/hooks/use-focus-on-screen";
import { useLoginFlow } from "@/providers/login-flow";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Redirect, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { H1, Input, Paragraph, Text, YStack } from "tamagui";

/** Complete the expiring Node account attempt with an in-memory S-PIN. */
export default function LoginPin() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { attempt, setAttempt, clear } = useLoginFlow();
  const [spin, setSpin] = useState("");
  const [pinNotice, setPinNotice] = useState<string | null>(null);
  const pinRef = useFocusOnScreen();

  // Leaving the screen discards only the opaque attempt. The encrypted Node
  // session remains reusable; no PIN or password is held in this context.
  useEffect(() => clear, [clear]);

  const login = useMutation({
    mutationKey: ["buzzkey", "account-action"],
    mutationFn: () => requireBuzzKey().connect(attempt?.attemptId ?? "", spin),
    retry: false,
    onSuccess: async (result) => {
      setSpin("");
      await queryClient.invalidateQueries({ queryKey: ["buzzkey"] });
      if (result.pending !== null) {
        setAttempt(result.pending);
        setPinNotice(
          "The security PIN could not be confirmed. Check it before trying again.",
        );
      } else router.replace("/");
    },
  });

  if (attempt === null) return <Redirect href="/login" />;

  const canSubmit = /^\d{4,6}$/.test(spin) && !login.isPending;
  const submit = () => {
    if (canSubmit) login.mutate();
  };

  return (
    <YStack flex={1} bg="$background">
      <KeyboardAwareScrollView
        mode="layout"
        bottomOffset={16}
        style={{ flex: 1 }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: "center",
          padding: 16,
          gap: 16,
        }}
      >
        <H1 size="$9" color="$color">
          Enter PIN
        </H1>
        <Paragraph color="$color10">
          Your myVW security PIN. If rejected, check the PIN before trying
          again.
        </Paragraph>
        {/* textContentType="none": keep iOS from treating this secure field as a
            password and offering to save it as the credential. */}
        <Input
          ref={pinRef}
          size="$5"
          placeholder="PIN"
          secureTextEntry
          keyboardType="number-pad"
          textContentType="none"
          autoComplete="off"
          maxLength={6}
          returnKeyType="go"
          onSubmitEditing={submit}
          value={spin}
          onChangeText={setSpin}
        />
        {login.error !== null || pinNotice !== null ? (
          <Text
            selectable
            color="$red10"
            transition="quick"
            animateOnly={["opacity"]}
            enterStyle={{ opacity: 0 }}
          >
            {login.error?.message ?? pinNotice}
          </Text>
        ) : null}
        <IosButton
          full
          tone="blue"
          disabled={!canSubmit}
          onPress={submit}
          label={login.isPending ? "Signing in…" : "Sign in"}
        />
      </KeyboardAwareScrollView>
    </YStack>
  );
}
