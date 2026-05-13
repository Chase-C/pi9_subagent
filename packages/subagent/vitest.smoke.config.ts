import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/smoke/**/*.test.ts"],
    testTimeout: 5000,
    isolate: true,
  },
});
