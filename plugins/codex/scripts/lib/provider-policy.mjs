// Opt-in "bedrock-only" mode.
//
// The setup check reports whether Codex is *authenticated*, which OpenAI-hosted
// auth satisfies. Teams that must keep prompts and source inside their own AWS
// account need a stronger signal: that Codex is actually pointed at Amazon
// Bedrock. Turning bedrock-only mode on makes that a hard requirement for
// `ready` and replaces the `codex login` guidance with Bedrock guidance.
//
// Off by default. Enable per workspace with `/codex:setup --enable-bedrock-only`
// or machine-wide with `CODEX_PLUGIN_BEDROCK_ONLY=1`.
//
// Separate module so it stays unit-testable -- codex-companion.mjs calls main()
// at import time.

// The only provider that keeps prompts and source inside your own AWS account.
export const SUPPORTED_MODEL_PROVIDER = "amazon-bedrock";
export const BEDROCK_ONLY_ENV = "CODEX_PLUGIN_BEDROCK_ONLY";
export const BEDROCK_ONLY_CONFIG_KEY = "bedrockOnly";

const TRUTHY = new Set(["1", "true", "yes", "on", "enabled"]);
const FALSY = new Set(["0", "false", "no", "off", "disabled", ""]);

/**
 * Read the environment override, if it is set to something recognizable.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {boolean | null} null when unset or unrecognized
 */
function readEnvOverride(env) {
  const raw = env?.[BEDROCK_ONLY_ENV];
  if (typeof raw !== "string") {
    return null;
  }
  const normalized = raw.trim().toLowerCase();
  if (TRUTHY.has(normalized)) {
    return true;
  }
  if (FALSY.has(normalized)) {
    return false;
  }
  return null;
}

/**
 * Decide whether bedrock-only mode is active.
 *
 * `CODEX_PLUGIN_BEDROCK_ONLY` wins in both directions so an org can pin the
 * policy on (or off) without touching per-workspace state. Otherwise the
 * per-workspace `bedrockOnly` config flag decides. Default is off.
 *
 * @param {{ bedrockOnly?: unknown } | null | undefined} config
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ enabled: boolean, source: "env" | "config" | "default" }}
 */
export function resolveBedrockOnlyMode(config, env = process.env) {
  const fromEnv = readEnvOverride(env);
  if (fromEnv !== null) {
    return { enabled: fromEnv, source: "env" };
  }
  if (config?.[BEDROCK_ONLY_CONFIG_KEY] != null) {
    return { enabled: Boolean(config[BEDROCK_ONLY_CONFIG_KEY]), source: "config" };
  }
  return { enabled: false, source: "default" };
}

/**
 * Classify the configured Codex model provider.
 *
 * `authStatus.provider` is `config.toml`'s `model_provider`, which the app
 * server resolves via `config/read` but which is otherwise never surfaced to the
 * user. The provider is always reported; `enforced` only decides whether a
 * non-Bedrock provider blocks `ready`.
 *
 * @param {{ provider?: string | null, available?: boolean } | null | undefined} authStatus
 * @param {{ enforced?: boolean }} [options]
 * @returns {{ id: string | null, supported: boolean, enforced: boolean, compliant: boolean, detail: string }}
 */
export function buildProviderCompliance(authStatus, options = {}) {
  const enforced = Boolean(options.enforced);
  const provider = typeof authStatus?.provider === "string" ? authStatus.provider.trim() : "";

  if (provider === SUPPORTED_MODEL_PROVIDER) {
    return {
      id: provider,
      supported: true,
      enforced,
      compliant: true,
      detail: `${SUPPORTED_MODEL_PROVIDER} (traffic stays in your own AWS account)`
    };
  }

  if (!provider) {
    const detail =
      authStatus?.available === false
        ? "unknown (Codex unavailable)"
        : enforced
          ? `unknown — no \`model_provider\` configured, so Codex defaults to OpenAI-hosted. Not allowed while bedrock-only mode is on; set \`model_provider = "${SUPPORTED_MODEL_PROVIDER}"\`.`
          : "unknown — no `model_provider` configured, so Codex defaults to OpenAI-hosted.";
    return { id: null, supported: false, enforced, compliant: !enforced, detail };
  }

  const detail = enforced
    ? `${provider} — not allowed while bedrock-only mode is on. Only \`${SUPPORTED_MODEL_PROVIDER}\` keeps prompts and source inside your own AWS account.`
    : provider;

  return { id: provider, supported: false, enforced, compliant: !enforced, detail };
}
