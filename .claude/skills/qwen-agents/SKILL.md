---
name: qwen-agents
description: Dispatch and orchestrate local opencode Qwen3.8 Max subagents via the opencode CLI harness for ferrum-nexus issue/PR work — implementer, fix-round, and shepherd modes, with worktree isolation and the review loop. Qwen3.8 Max is the large-context tier (~983k context), suited to wide refactors and whole-subsystem audits. Use when the user asks Claude to spawn Qwen/qwen3.8-max agents on issues, PRs, review findings, or red CI.
---

# Qwen3.8 Max agents

Act as the orchestrator. Read and follow the shared workflow in
[the canonical skill](../../../.agents/skills/qwen-agents/SKILL.md), interpreting its Codex
orchestrator role as your Claude orchestrator role. Use the shared launcher and references;
do not duplicate them in this directory.

```bash
<ABS_REPO>/.agents/skills/qwen-agents/scripts/dispatch-agent.sh \
  --worktree <ABS_WORKER_WORKTREE> \
  --prompt-file <ABS_PROMPT_FILE> \
  --effort <medium|high|xhigh|max>
```

The shared launcher pins `alibaba-token-plan/qwen3.8-max`; `--effort` is accepted for parity
with the sibling skills and `--model` only re-states the pinned model.

Read the canonical skill before dispatch for remote CI validation, effort selection, preflight,
isolation, failure handling, and verification. For implementer mode, read
[agent-brief.md](../../../.agents/skills/qwen-agents/references/agent-brief.md).
For fix-round or shepherd mode, also read
[continuation-brief.md](../../../.agents/skills/qwen-agents/references/continuation-brief.md).
Resolve all worker paths to absolute paths. Run each worker in its own background or long-lived
execution session and retain that session's identity. Honor the user's selected effort without
clamping or substituting. Never recursively invoke this skill from a dispatched worker. Assign
commit, push, review-trigger, and CI actions only when the user's request includes them; the
canonical skill's stopping-point rules apply to every prompt you construct.
