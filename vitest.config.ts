import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

// Tests run against test/brand.ts, never your filled-in src/brand.ts, so they pass before and after setup.
// Parallel sessions keep their git worktrees under .claude/worktrees/; their in-progress tests aren't ours.
export default defineConfig({
  resolve: { alias: [{ find: /^\.\/brand$/, replacement: fileURLToPath(new URL("./test/brand.ts", import.meta.url)) }] },
  test: { exclude: [...configDefaults.exclude, ".claude/**"] },
});
