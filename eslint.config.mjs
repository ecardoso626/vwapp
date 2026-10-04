// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import expoFlat from "eslint-config-expo/flat.js";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.expo/**",
      "**/.tamagui/**",
      "**/babel.config.js",
      "**/metro.config.js",
      "**/*.config.js",
      "**/expo-env.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  // The Expo app additionally uses the Expo flat config.
  {
    files: ["app/**/*.{ts,tsx,js,jsx}"],
    extends: [expoFlat],
  },
  // Plain JS files (configs, scripts) shouldn't run type-aware rules.
  {
    files: ["**/*.{js,mjs,cjs}"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  // The POC is throwaway exploratory code that scrapes HTML and handles
  // loosely-typed JSON responses; relax the strict type-aware rules there.
  {
    files: ["packages/poc/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/restrict-plus-operands": "off",
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "no-useless-escape": "off",
    },
  },
);
