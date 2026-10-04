/**
 * Transitional InstantDB client for Worker-backed controls and
 * the managed-climate session subscription. Passive owner/vehicle/history/
 * message views now use the NIP-98 Node client instead.
 */
import "@/polyfills";
import { init } from "@instantdb/react-native";
import schema from "@vwapp/db";

const APP_ID = process.env.EXPO_PUBLIC_INSTANT_APP_ID;
export const db =
  APP_ID === undefined || APP_ID === ""
    ? null
    : init({ appId: APP_ID, schema });
