import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true
  },
  // ADD THIS — don't replace the existing Vite configuration
 test: {
  environment: "jsdom",

  setupFiles: ["./src/test/setup.ts"],

  coverage: {
    provider: "v8",

    reporter: [
      "text",
      "text-summary",
      "html",
      "lcov",
    ],

    include: [
      "src/**/*.{js,jsx,ts,tsx}",
    ],

    exclude: [
      "src/**/*.d.ts",
      "src/**/*.test.{js,jsx,ts,tsx}",
      "src/**/*.spec.{js,jsx,ts,tsx}",
      "src/main.tsx",
    ],

    reportsDirectory: "./coverage",

    thresholds: {
      statements: 80,
      branches: 75,
      functions: 80,
      lines: 80,
      perFile: true,
    },
  },
},
});