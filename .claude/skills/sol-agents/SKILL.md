---
name: sol-agents
description: Dispatch and orchestrate GPT-6.1 Sol CLI subagents (low|medium|high|xhigh|max|ultra effort) for Ferrum Nexus issue, PR, review-feedback, CI-repair, and shepherding work. Fast mode is optional and requires an explicit user request. Use when the user asks Claude to delegate to GPT-6.1 Sol workers. Do not use when you are a dispatched worker or for ordinary single-agent edits.
---

# GPT-6.1 Sol agents

Act as the orchestrator. Read and follow the shared workflow in
[the canonical skill](../../../.agents/skills/sol-agents/SKILL.md), interpreting its Codex
orchestrator role as your Claude orchestrator role. Use the shared launcher and references;
do not duplicate them in this directory.

```bash
<ABS_REPO>/.agents/skills/sol-agents/scripts/dispatch-agent.sh \
  --worktree <ABS_WORKER_WORKTREE> \
  --prompt-file <ABS_PROMPT_FILE> \
  --effort <low|medium|high|xhigh|max|ultra>
```

Append `--fast` only when the user explicitly requests fast mode for that dispatch or fleet,
for example "Sol high with fast mode". Use `--no-fast` for "fast mode off", "without fast mode",
or "standard mode". Omit both flags for standard mode when no speed is specified. Carry an
explicit choice through continuations of the same task until the user changes it; never pass both
flags. The shared launcher pins `gpt-6.1-sol`, `service_tier="default"` and
`features.fast_mode=false` normally, or `service_tier="fast"` and `features.fast_mode=true` with
`--fast`. Keep the selected reasoning effort unchanged and report an unavailable tier.

Read the canonical skill before dispatch for remote CI validation, effort selection, preflight,
isolation, failure handling, and verification. For implementer mode, read
[agent-brief.md](../../../.agents/skills/sol-agents/references/agent-brief.md).
For fix-round or shepherd mode, also read
[continuation-brief.md](../../../.agents/skills/sol-agents/references/continuation-brief.md).
Resolve all worker paths to absolute paths. Run each worker in its own background or long-lived
execution session and retain that session's identity. Honor the user's selected effort without
clamping or substituting. Never recursively invoke this skill from a dispatched worker.
