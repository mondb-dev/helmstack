import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/release/**",
      ".npm-cache/**",
      "sdk-example/**",
      "**/*.config.{js,mjs,ts}",
      "**/scripts/**",
      "apps/desktop/test-pages/**"
    ]
  },
  // Lint the TypeScript source + tests across all workspaces.
  {
    files: ["apps/**/*.ts", "packages/**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    rules: {
      // TS already checks undefined identifiers (incl. browser/node globals).
      "no-undef": "off",
      // Pragmatic: keep high-signal rules, silence the noisy ones for this codebase.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      "@typescript-eslint/no-empty-object-type": "off",
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "no-control-regex": "off"
    }
  }
);
