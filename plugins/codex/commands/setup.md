---
description: Check whether the local Codex CLI is ready and optionally toggle the stop-time review gate or bedrock-only mode
argument-hint: '[--enable-review-gate|--disable-review-gate] [--enable-bedrock-only|--disable-bedrock-only]'
allowed-tools: Bash(node:*), Bash(npm:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" setup --json $ARGUMENTS
```

If the result says Codex is unavailable and npm is available:
- Use `AskUserQuestion` exactly once to ask whether Claude should install Codex now.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install Codex (Recommended)`
  - `Skip for now`
- If the user chooses install, run:

```bash
npm install -g @openai/codex
```

- Then rerun:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" setup --json $ARGUMENTS
```

If Codex is already installed or npm is unavailable:
- Do not ask about installation.

Bedrock-only mode:
- Off by default. `--enable-bedrock-only` requires the reported model provider to be `amazon-bedrock` before setup reports ready, which keeps prompts, source code, and diffs inside your own AWS account.
- `CODEX_PLUGIN_BEDROCK_ONLY=1` in the environment turns it on for every workspace and overrides the per-workspace setting.
- Do not toggle it on the user's behalf. Only pass these flags when the user asked for them.

Output rules:
- Present the final setup output to the user.
- If installation was skipped, present the original setup output.
- If bedrock-only mode is off and Codex is installed but not authenticated, preserve the guidance to run `!codex login`.
- If bedrock-only mode is on and the reported model provider is not `amazon-bedrock`, preserve the setup output's guidance verbatim. Never suggest `codex login`, `codex login --with-api-key`, `codex login --device-auth`, or setting `OPENAI_API_KEY` in that case — those route source code to OpenAI, which is exactly what the mode exists to prevent.
