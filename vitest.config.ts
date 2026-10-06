import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const vscodeMock = fileURLToPath(new URL("./test/vscode.ts", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      vscode: vscodeMock
    }
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 15_000
  }
});
