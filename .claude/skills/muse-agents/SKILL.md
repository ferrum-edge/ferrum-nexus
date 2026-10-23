---
name: muse-agents
description: Dispatch and orchestrate local Muse Wonder Full subagents via the standalone Muse Code muse CLI harness for ferrum-nexus issue/PR work — implementer, fix-round, shepherd, and read-only reviewer modes, with low/medium/high/xhigh/max/ultra reasoning effort, worktree isolation, and the review loop. Use when the user asks Claude to spawn Muse/Muse Wonder Full agents on issues, PRs, review findings, red CI, or an independent PR review.
---

# Muse Wonder Full agents

Act as the orchestrator. Read and follow the shared workflow in
[the canonical skill](../../../.agents/skills/muse-agents/SKILL.md), interpreting its Codex
orchestrator role as your Claude orchestrator role. Use the shared launcher and references;
do not duplicate them in this directory.

```bash
<ABS_REPO>/.agents/skills/muse-agents/scripts/dispatch-agent.sh \
  --worktree <ABS_WORKER_WORKTREE> \
  --prompt-file <ABS_PROMPT_FILE> \
  --effort <low|medium|high|xhigh|max|ultra>
```

`--effort` passes straight through as Muse's `--reasoning-effort` (default `high`; `ultra` only
when explicitly requested). Muse Wonder Full has no fast tier; there is no `--fast` flag.
Pass `--name NAME` only to label a worker.

Read the canonical skill before dispatch for remote CI validation, effort selection, preflight,
isolation, failure handling, and verification. For implementer mode, read
[agent-brief.md](../../../.agents/skills/muse-agents/references/agent-brief.md).
For fix-round or shepherd mode, also read
[continuation-brief.md](../../../.agents/skills/muse-agents/references/continuation-brief.md).
Resolve all worker paths to absolute paths. Run each worker in its own background or long-lived
execution session and retain that session's identity. Honor the user's selected effort without
clamping or substituting. Never recursively invoke this skill from a dispatched worker. Assign
commit, push, review-trigger, and CI actions only when the user's request includes them; the
canonical skill's stopping-point rules apply to every prompt you construct.
