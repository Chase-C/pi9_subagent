import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/smoke/**", "node_modules/**", "dist/**"],
    setupFiles: ["test/helpers/setup.ts"],
    testTimeout: 5000,
    isolate: true,
  },
});
