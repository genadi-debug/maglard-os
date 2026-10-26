import { defineConfig } from "vitest/config";

// Integration tests share one database, so test files must not run in parallel.
export default defineConfig({ test: { fileParallelism: false } });
