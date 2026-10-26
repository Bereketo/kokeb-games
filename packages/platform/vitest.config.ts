import { defineConfig } from "vitest/config";

// These tests talk to a real Postgres. Against a remote database (e.g. Neon
// from a laptop far from its region) every round trip can take 100-300 ms,
// so the default 5 s per test is too tight. The concurrency tests queue 25
// operations behind one player's lock, so they need the most time.
export default defineConfig({
  test: {
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
