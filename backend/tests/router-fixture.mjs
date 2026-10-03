import { Buffer } from "node:buffer";
import { seal } from "../src/crypto.ts";
import { ACCESS, CARNET, ID_TOKEN, SPIN, UUID, VIN } from "./harness.mjs";

export async function routerFixture({
  activeSession = null,
  spin = SPIN,
} = {}) {
  const key = Buffer.alloc(32, 7).toString("base64");
  const sealed = await seal(
    key,
    JSON.stringify({
      username: "nobody@example.invalid",
      password: "synthetic-password",
      spin,
    }),
  );
  const snapshots = [];
  const sessions = activeSession === null ? [] : [{ ...activeSession }];
  const account = {
    id: "synthetic-account-id",
    credCiphertext: sealed.ciphertext,
    credIv: sealed.iv,
    accessToken: ACCESS,
    refreshToken: "synthetic-refresh-token",
    idToken: ID_TOKEN,
    tokenExpiresAt: Date.now() + 600_000,
    codeVerifier: "synthetic-verifier",
    carnetTokens: JSON.stringify({
      [UUID]: { token: CARNET, expiresAt: Date.now() + 600_000 },
    }),
    vehicles: [{ id: "synthetic-vehicle-row", uuid: UUID, vin: VIN }],
  };
  const db = {
    snapshots,
    sessions,
    query: async (query) => {
      if (query.$users) return { $users: [{ account }] };
      if (query.vwAccounts) return { vwAccounts: [account] };
      if (query.climateSessions) {
        const active = sessions.filter((s) => s.state === "active");
        if (query.climateSessions.vehicle) {
          return {
            climateSessions: active.map((s) => ({
              ...s,
              vehicle: { ...account.vehicles[0], account },
            })),
          };
        }
        return { climateSessions: active };
      }
      return {
        snapshots: query.snapshots?.$.where?.createdAt ? [] : snapshots,
      };
    },
    transact: async (operation) => operation,
    tx: {
      snapshots: new Proxy(
        {},
        {
          get: () => ({
            create: (data) => ({
              link: ({ vehicle }) => {
                snapshots.push({ ...data, vehicle });
                return { ...data, vehicle };
              },
            }),
          }),
        },
      ),
      climateSessions: new Proxy(
        {},
        {
          get: (_, id) => ({
            create: (data) => ({
              link: ({ vehicle }) => {
                const row = { id, ...data, vehicle };
                sessions.push(row);
                return row;
              },
            }),
            update: (fields) => {
              Object.assign(
                sessions.find((s) => s.id === id),
                fields,
              );
              return fields;
            },
          }),
        },
      ),
    },
  };
  return {
    db,
    env: { CREDS_ENC_KEY: key },
    context: {
      db,
      env: { CREDS_ENC_KEY: key },
      userId: "synthetic-guest-id",
      waitUntil: () => undefined,
    },
  };
}
