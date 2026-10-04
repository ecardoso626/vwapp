/**
 * Transitional InstantDB client for Worker-backed controls, VW login/logout,
 * and the managed-climate session subscription. Passive owner/vehicle/history/
 * message views now use the NIP-98 Node client instead.
 */
import "@/polyfills";
import { init } from "@instantdb/react-native";
import schema from "@vwapp/db";

const APP_ID = process.env.EXPO_PUBLIC_INSTANT_APP_ID;
if (APP_ID === undefined)
  throw new Error("Set EXPO_PUBLIC_INSTANT_APP_ID in app/.env");

export const db = init({ appId: APP_ID, schema });
