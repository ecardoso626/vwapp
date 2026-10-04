import { requireBuzzKey } from "@/buzzkey-native";
import { passiveKeys, usePassiveMessages } from "@/hooks/use-passive-data";
import { htmlToText } from "@/html";
import { useIosColors } from "@/ios-colors";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Stack, useLocalSearchParams } from "expo-router";
import { useEffect } from "react";
import { Text as RNText, ScrollView } from "react-native";
import { Paragraph, Spinner, Text, YStack } from "tamagui";

/**
 * A cached message from Node/SQLite; opening it updates our local read override.
 */
export default function MessageDetail() {
  const ios = useIosColors();
  const { id } = useLocalSearchParams<{ id: string }>();
  const q = usePassiveMessages();
  const message = q.data?.messages.find((item) => item.messageId === id);

  const queryClient = useQueryClient();
  const setRead = useMutation({
    mutationFn: (messageId: string) =>
      requireBuzzKey().setMessageRead(messageId, true),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: passiveKeys.messages }),
  });
  const { mutate: setReadMutate } = setRead;
  useEffect(() => {
    if (message !== undefined && !(message.readOverride ?? message.read))
      setReadMutate(message.messageId);
  }, [message, setReadMutate]);

  return (
    <>
      <Stack.Screen
        options={{
          title: "",
          headerLargeTitle: false,
          headerBackTitle: "Messages",
          contentStyle: { backgroundColor: ios.systemBackground },
        }}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: 16, gap: 8 }}
      >
        {q.isLoading ? <Spinner color="$color" /> : null}
        {q.error ? <Text color="$red10">{q.error.message}</Text> : null}
        {setRead.error ? (
          <Text color="$red10">{setRead.error.message}</Text>
        ) : null}
        {!q.isLoading && q.error === null && message === undefined ? (
          <Paragraph color="$color10">Message not found.</Paragraph>
        ) : message !== undefined ? (
          <YStack gap="$2">
            <RNText
              selectable
              style={{ fontSize: 22, fontWeight: "700", color: ios.label }}
            >
              {message.title}
            </RNText>
            {message.at != null ? (
              <RNText style={{ fontSize: 13, color: ios.secondaryLabel }}>
                {formatDate(message.at)}
              </RNText>
            ) : null}
            {message.body != null && message.body !== "" ? (
              <RNText
                selectable
                style={{
                  fontSize: 17,
                  lineHeight: 24,
                  color: ios.label,
                  marginTop: 8,
                }}
              >
                {htmlToText(message.body)}
              </RNText>
            ) : null}
          </YStack>
        ) : null}
      </ScrollView>
    </>
  );
}

function formatDate(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}
