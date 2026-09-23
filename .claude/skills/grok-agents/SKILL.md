---
name: grok-agents
description: Dispatch and orchestrate local Cursor Grok 4.6 subagents via the standalone cursor-agent CLI for ferrum-nexus issue/PR work — implementer, fix-round, and shepherd modes, with worktree isolation and the review loop. Use when the user asks Claude to spawn Grok/Cursor Grok agents on issues, PRs, review findings, or red CI.
---

# Cursor Grok 4.6 agents

Act as the orchestrator. Read and follow the shared workflow in
[the canonical skill](../../../.agents/skills/grok-agents/SKILL.md), interpreting its Codex
orchestrator role as your Claude orchestrator role. Use the shared launcher and references;
do not duplicate them in this directory.

```bash
<ABS_REPO>/.agents/skills/grok-agents/scripts/dispatch-agent.sh \
  --worktree <ABS_WORKER_WORKTREE> \
  --prompt-file <ABS_PROMPT_FILE> \
  --effort <low|medium|high|xhigh|max>
```

`--effort` selects the `cursor-grok-4.6-*` SKU (the launcher defaults to `high`). Append
`--fast` only when the user explicitly requests fast mode for that dispatch or fleet, and
`--name NAME` only to label a worker.

Read the canonical skill before dispatch for remote CI validation, effort selection, preflight,
isolation, failure handling, and verification. For implementer mode, read
[agent-brief.md](../../../.agents/skills/grok-agents/references/agent-brief.md).
For fix-round or shepherd mode, also read
[continuation-brief.md](../../../.agents/skills/grok-agents/references/continuation-brief.md).
Resolve all worker paths to absolute paths. Run each worker in its own background or long-lived
execution session and retain that session's identity. Honor the user's selected effort without
clamping or substituting. Never recursively invoke this skill from a dispatched worker. Assign
commit, push, review-trigger, and CI actions only when the user's request includes them; the
canonical skill's stopping-point rules apply to every prompt you construct.
