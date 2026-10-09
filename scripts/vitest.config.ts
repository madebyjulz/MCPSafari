import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/**/*.test.ts"],
          exclude: ["test/mcp-results.test.ts"],
        },
      },
      {
        // Drives the real server binary, so it runs only after a Swift build (`pnpm test:mcp`).
        test: {
          name: "mcp",
          include: ["test/mcp-results.test.ts"],
        },
      },
    ],
  },
});
