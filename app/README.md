# BuzzKey mobile app

This Expo/React Native app uses the BuzzKey client and NIP-98 signing to reach the self-hosted Node API. It does not connect to InstantDB or a Cloudflare Worker. The shared `packages/contract` types describe the Node API and vehicle state.

Use the repository's pinned pnpm 10.33.4 from the root. Copy `app/.env.example` to ignored `app/.env` and set `EXPO_PUBLIC_NODE_ORIGIN` to the same trusted HTTPS origin configured as `NODE_PUBLIC_ORIGIN` on the backend. Then run `pnpm --filter @vwapp/mobile start` for local development. Offline iOS JavaScript export is `EXPO_OFFLINE=1 pnpm --filter @vwapp/mobile exec expo export --platform ios --clear`; this does not generate a native Xcode project or deploy anything.

Native distribution is planned through local Xcode tooling. No EAS project or cloud release command is required by this repository.
