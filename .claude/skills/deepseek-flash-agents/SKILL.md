---
name: deepseek-flash-agents
description: Dispatch and orchestrate local opencode DeepSeek V4 Flash subagents via the opencode CLI harness for ferrum-nexus issue/PR work — implementer, fix-round, and shepherd modes, with worktree isolation and the review loop. DeepSeek V4 Flash is the fast tier, suited to mechanical well-scoped edits and breadth-first fan-out. Use when the user asks Claude to spawn DeepSeek Flash/deepseek-v4-flash agents on issues, PRs, review findings, or red CI.
---

# DeepSeek V4 Flash agents

Act as the orchestrator. Read and follow the shared workflow in
[the canonical skill](../../../.agents/skills/deepseek-flash-agents/SKILL.md), interpreting its Codex
orchestrator role as your Claude orchestrator role. Use the shared launcher and references;
do not duplicate them in this directory.

```bash
<ABS_REPO>/.agents/skills/deepseek-flash-agents/scripts/dispatch-agent.sh \
  --worktree <ABS_WORKER_WORKTREE> \
  --prompt-file <ABS_PROMPT_FILE> \
  --effort <medium|high|xhigh|max>
```

The shared launcher pins `alibaba-token-plan/deepseek-v4-flash-0731`; `--effort` is accepted for
parity with the sibling skills and `--model` only re-states the pinned model.

Read the canonical skill before dispatch for remote CI validation, effort selection, preflight,
isolation, failure handling, and verification. For implementer mode, read
[agent-brief.md](../../../.agents/skills/deepseek-flash-agents/references/agent-brief.md).
For fix-round or shepherd mode, also read
[continuation-brief.md](../../../.agents/skills/deepseek-flash-agents/references/continuation-brief.md).
Resolve all worker paths to absolute paths. Run each worker in its own background or long-lived
execution session and retain that session's identity. Honor the user's selected effort without
clamping or substituting. Never recursively invoke this skill from a dispatched worker. Assign
commit, push, review-trigger, and CI actions only when the user's request includes them; the
canonical skill's stopping-point rules apply to every prompt you construct.
