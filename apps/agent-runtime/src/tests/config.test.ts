import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../config.js";

test("loadConfig exposes real provider request timeout instead of fixed provider defaults", () => {
  const previousHivo = process.env.HIVO_PROVIDER_TIMEOUT_MS;
  const previousOrchcode = process.env.ORCHCODE_PROVIDER_TIMEOUT_MS;
  try {
    process.env.HIVO_PROVIDER_TIMEOUT_MS = "12345";
    delete process.env.ORCHCODE_PROVIDER_TIMEOUT_MS;

    assert.equal(loadConfig().providerRequestTimeoutMs, 12345);

    delete process.env.HIVO_PROVIDER_TIMEOUT_MS;
    process.env.ORCHCODE_PROVIDER_TIMEOUT_MS = "23456";
    assert.equal(loadConfig().providerRequestTimeoutMs, 23456);
  } finally {
    restoreEnv("HIVO_PROVIDER_TIMEOUT_MS", previousHivo);
    restoreEnv("ORCHCODE_PROVIDER_TIMEOUT_MS", previousOrchcode);
  }
});

test("loadConfig exposes shared per-run provider call and wall-clock limits", () => {
  const previousCalls = process.env.HIVO_RUN_MAX_PROVIDER_CALLS;
  const previousWallClock = process.env.HIVO_RUN_MAX_WALL_CLOCK_MS;
  try {
    process.env.HIVO_RUN_MAX_PROVIDER_CALLS = "7";
    process.env.HIVO_RUN_MAX_WALL_CLOCK_MS = "90000";

    assert.equal(loadConfig().maxProviderCallsPerRun, 7);
    assert.equal(loadConfig().maxRunWallClockMs, 90_000);

    delete process.env.HIVO_RUN_MAX_PROVIDER_CALLS;
    delete process.env.HIVO_RUN_MAX_WALL_CLOCK_MS;
    assert.equal(loadConfig().maxProviderCallsPerRun, 24);
    assert.equal(loadConfig().maxRunWallClockMs, 1_200_000);
  } finally {
    restoreEnv("HIVO_RUN_MAX_PROVIDER_CALLS", previousCalls);
    restoreEnv("HIVO_RUN_MAX_WALL_CLOCK_MS", previousWallClock);
  }
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
