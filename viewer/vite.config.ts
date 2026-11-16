import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],

  server: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
  },

  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],

    include: ["src/**/*.{test,spec}.{js,jsx,ts,tsx}"],

    exclude: [
      "node_modules/**",
      "dist/**",
      "coverage/**",
    ],

    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "html", "lcov"],
      reportsDirectory: "./coverage",
      reportOnFailure: true,
      clean: true,
      cleanOnRerun: false,

      include: ["src/**/*.{js,jsx,ts,tsx}"],
      exclude: [
        "src/**/*.d.ts",
        "src/**/*.test.{js,jsx,ts,tsx}",
        "src/**/*.spec.{js,jsx,ts,tsx}",
        "src/**/__tests__/**",
        "src/**/__mocks__/**",
        "src/test/**",
        "src/main.tsx",
      ],

      thresholds: {
        // Global minimums
        statements: 80,
        lines: 80,
        functions: 75,
        branches: 70,

        // Optional: stricter for critical code (glob keys)
        "src/services/**": {
          statements: 90,
          lines: 90,
          functions: 90,
          branches: 80,
        },
        "src/utils/**": {
          statements: 90,
          lines: 90,
          functions: 90,
          branches: 85,
        },
      },
    },
  },
});