declare global {
  namespace NodeJS {
    interface ProcessEnv {
      EXPO_PUBLIC_NODE_ORIGIN?: string;
      IOS_BUNDLE_IDENTIFIER?: string;
    }
  }
}

export {};
