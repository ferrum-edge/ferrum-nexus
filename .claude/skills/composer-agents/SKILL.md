---
name: composer-agents
description: Dispatch and orchestrate local Cursor Composer 2.5 subagents via the standalone cursor-agent CLI for ferrum-nexus issue/PR work — implementer, fix-round, and shepherd modes, with worktree isolation and the review loop. Composer is the fast tier of the agent fleet. Use when the user asks Claude to spawn Composer/Cursor Composer agents on issues, PRs, review findings, or red CI.
---

# Cursor Composer 2.5 agents

Act as the orchestrator. Read and follow the shared workflow in
[the canonical skill](../../../.agents/skills/composer-agents/SKILL.md), interpreting its Codex
orchestrator role as your Claude orchestrator role. Use the shared launcher and references;
do not duplicate them in this directory.

```bash
<ABS_REPO>/.agents/skills/composer-agents/scripts/dispatch-agent.sh \
  --worktree <ABS_WORKER_WORKTREE> \
  --prompt-file <ABS_PROMPT_FILE> \
  --effort <low|medium|high|xhigh|max>
```

`--effort` is accepted for parity with the sibling skills; the shared launcher pins the Cursor
Composer 2.5 model. Append `--fast` only when the user explicitly requests fast mode for that
dispatch or fleet, and `--name NAME` only to label a worker.

Read the canonical skill before dispatch for remote CI validation, effort selection, preflight,
isolation, failure handling, and verification. For implementer mode, read
[agent-brief.md](../../../.agents/skills/composer-agents/references/agent-brief.md).
For fix-round or shepherd mode, also read
[continuation-brief.md](../../../.agents/skills/composer-agents/references/continuation-brief.md).
Resolve all worker paths to absolute paths. Run each worker in its own background or long-lived
execution session and retain that session's identity. Honor the user's selected effort without
clamping or substituting. Never recursively invoke this skill from a dispatched worker. Assign
commit, push, review-trigger, and CI actions only when the user's request includes them; the
canonical skill's stopping-point rules apply to every prompt you construct.
