import type { ConfigContext, ExpoConfig } from "expo/config";

/** Local native builds keep the app identity stable without EAS configuration. */
export default ({ config }: ConfigContext): ExpoConfig => {
  const bundleIdentifier = "com.ecardoso626.buzzkey";
  if (
    process.env.IOS_BUNDLE_IDENTIFIER !== undefined &&
    process.env.IOS_BUNDLE_IDENTIFIER !== bundleIdentifier
  )
    throw new Error("IOS_BUNDLE_IDENTIFIER must be com.ecardoso626.buzzkey");
  return {
    ...config,
    name: "BuzzKey",
    slug: config.slug ?? "vwapp",
    ios: { ...config.ios, bundleIdentifier },
  };
};
