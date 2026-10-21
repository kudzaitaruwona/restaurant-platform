import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Photo storage boundary (D-07): app code touches storage only through
  // uploadImage / deleteImage / getUrl from "@/lib/storage".
  {
    files: ["**/*.{js,jsx,mjs,ts,tsx,mts}"],
    ignores: ["src/lib/storage/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@aws-sdk/*"],
              message:
                'Use uploadImage / deleteImage / getUrl from "@/lib/storage".',
            },
            {
              group: ["@/lib/storage/*", "**/lib/storage/*"],
              message: 'Import storage from "@/lib/storage" only.',
            },
          ],
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
