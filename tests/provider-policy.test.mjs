// Covers the opt-in bedrock-only provider policy. The load-bearing assertions:
// the mode is off unless someone turns it on, and once it is on an OpenAI-hosted
// provider is never reported as compliant, however Codex is authenticated.

import assert from "node:assert/strict";
import test from "node:test";

import {
  BEDROCK_ONLY_CONFIG_KEY,
  BEDROCK_ONLY_ENV,
  buildProviderCompliance,
  resolveBedrockOnlyMode,
  SUPPORTED_MODEL_PROVIDER
} from "../plugins/codex/scripts/lib/provider-policy.mjs";

const ENFORCED = { enforced: true };

test("bedrock-only mode is off by default", () => {
  assert.deepEqual(resolveBedrockOnlyMode(undefined, {}), { enabled: false, source: "default" });
  assert.deepEqual(resolveBedrockOnlyMode({}, {}), { enabled: false, source: "default" });
  assert.deepEqual(resolveBedrockOnlyMode({ stopReviewGate: true }, {}), {
    enabled: false,
    source: "default"
  });
});

test("the per-workspace config flag turns bedrock-only mode on", () => {
  assert.deepEqual(resolveBedrockOnlyMode({ [BEDROCK_ONLY_CONFIG_KEY]: true }, {}), {
    enabled: true,
    source: "config"
  });
  assert.deepEqual(resolveBedrockOnlyMode({ [BEDROCK_ONLY_CONFIG_KEY]: false }, {}), {
    enabled: false,
    source: "config"
  });
});

test("the environment override wins over the per-workspace config, in both directions", () => {
  const on = { [BEDROCK_ONLY_ENV]: "1" };
  const off = { [BEDROCK_ONLY_ENV]: "0" };

  assert.deepEqual(resolveBedrockOnlyMode({ [BEDROCK_ONLY_CONFIG_KEY]: false }, on), {
    enabled: true,
    source: "env"
  });
  assert.deepEqual(resolveBedrockOnlyMode({ [BEDROCK_ONLY_CONFIG_KEY]: true }, off), {
    enabled: false,
    source: "env"
  });

  for (const truthy of ["1", "true", "TRUE", "yes", "on", " enabled "]) {
    assert.equal(resolveBedrockOnlyMode({}, { [BEDROCK_ONLY_ENV]: truthy }).enabled, true, truthy);
  }
  for (const falsy of ["0", "false", "no", "off", "disabled", ""]) {
    assert.equal(resolveBedrockOnlyMode({}, { [BEDROCK_ONLY_ENV]: falsy }).enabled, false, falsy);
  }
});

test("an unrecognized environment value falls through to the config", () => {
  const env = { [BEDROCK_ONLY_ENV]: "maybe" };

  assert.deepEqual(resolveBedrockOnlyMode({ [BEDROCK_ONLY_CONFIG_KEY]: true }, env), {
    enabled: true,
    source: "config"
  });
  assert.deepEqual(resolveBedrockOnlyMode({}, env), { enabled: false, source: "default" });
});

test("amazon-bedrock is the supported provider", () => {
  assert.equal(SUPPORTED_MODEL_PROVIDER, "amazon-bedrock");

  const compliance = buildProviderCompliance({ provider: "amazon-bedrock", available: true }, ENFORCED);
  assert.equal(compliance.supported, true);
  assert.equal(compliance.compliant, true);
  assert.equal(compliance.id, "amazon-bedrock");
});

test("surrounding whitespace in the provider id still resolves as supported", () => {
  const compliance = buildProviderCompliance({ provider: "  amazon-bedrock  ", available: true }, ENFORCED);
  assert.equal(compliance.supported, true);
  assert.equal(compliance.id, "amazon-bedrock");
});

test("with the mode off, any provider is compliant but still reported", () => {
  for (const provider of ["openai", "azure", "openrouter", "ollama", null]) {
    const compliance = buildProviderCompliance({ provider, available: true, loggedIn: true });

    assert.equal(compliance.compliant, true, `${provider} must not block readiness when the mode is off`);
    assert.equal(compliance.enforced, false);
    assert.equal(compliance.supported, false);
    assert.doesNotMatch(compliance.detail, /bedrock-only mode/);
  }
});

test("with the mode on, OpenAI-hosted providers are never compliant, even when authenticated", () => {
  for (const provider of ["openai", "azure", "openrouter", "ollama", "amazon-bedrock-runtime"]) {
    const compliance = buildProviderCompliance(
      { provider, available: true, loggedIn: true, authMethod: "chatgpt" },
      ENFORCED
    );

    assert.equal(compliance.supported, false, `${provider} must not be supported`);
    assert.equal(compliance.compliant, false, `${provider} must not be compliant`);
    assert.match(compliance.detail, /not allowed while bedrock-only mode is on/);
  }
});

test("with the mode on, an unset provider is called out as OpenAI-hosted by default", () => {
  for (const authStatus of [
    { available: true },
    { available: true, provider: null },
    { available: true, provider: "   " }
  ]) {
    const compliance = buildProviderCompliance(authStatus, ENFORCED);

    assert.equal(compliance.compliant, false);
    assert.equal(compliance.id, null);
    assert.match(compliance.detail, /defaults to OpenAI-hosted/);
  }
});

test("a missing or unavailable auth status does not throw", () => {
  for (const authStatus of [null, undefined, {}]) {
    assert.equal(buildProviderCompliance(authStatus, ENFORCED).compliant, false);
    assert.equal(buildProviderCompliance(authStatus).compliant, true);
  }

  const unavailable = buildProviderCompliance({ available: false, provider: null }, ENFORCED);
  assert.equal(unavailable.compliant, false);
  assert.match(unavailable.detail, /Codex unavailable/);
});

test("no provider detail ever suggests an OpenAI-hosted auth path", () => {
  const details = [
    buildProviderCompliance({ provider: "amazon-bedrock", available: true }, ENFORCED).detail,
    buildProviderCompliance({ provider: "openai", available: true }, ENFORCED).detail,
    buildProviderCompliance({ available: true }, ENFORCED).detail,
    buildProviderCompliance({ available: false }, ENFORCED).detail
  ];

  for (const detail of details) {
    assert.doesNotMatch(detail, /codex login|OPENAI_API_KEY|with-api-key|device-auth/i);
  }
});
