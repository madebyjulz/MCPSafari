import { defineConfig } from "oxfmt";

export default defineConfig({
  printWidth: 120,
  ignorePatterns: ["**/dist/**", "pnpm-lock.yaml", "MCPServer/**", "MCPSafari/**", ".github/**", "**/*.md"],
});
