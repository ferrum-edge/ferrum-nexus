---
name: antigravity-neon-agents
description: Dispatch and orchestrate local Gemini 4 Neon subagents via the standalone Google Antigravity agy CLI harness for ferrum-nexus issue/PR work — implementer, fix-round, shepherd, and read-only reviewer modes, with low/medium/high/xhigh thinking (default high), worktree isolation, and the review loop. Use when the user asks Claude to spawn Antigravity, agy, Gemini, or Gemini 4 Neon agents on issues, PRs, review findings, red CI, or an independent PR review.
---

# Antigravity Gemini 4 Neon agents

Act as the orchestrator. Read and follow the shared workflow in
[the canonical skill](../../../.agents/skills/antigravity-neon-agents/SKILL.md), interpreting its
Codex orchestrator role as your Claude orchestrator role. Use the shared launcher and references;
do not duplicate them in this directory.

```bash
<ABS_REPO>/.agents/skills/antigravity-neon-agents/scripts/dispatch-agent.sh \
  --worktree <ABS_WORKER_WORKTREE> \
  --prompt-file <ABS_PROMPT_FILE> \
  --effort <low|medium|high|xhigh>
```

The launcher pins `gemini-4-neon` and passes `--effort` straight through as `agy --effort`
(default `high`). Gemini 4 Neon publishes only `low`, `medium`, `high`, and `xhigh`; the launcher
rejects `max` and `ultra` rather than clamping, and there is no fast tier or `--fast` flag.
Pass `--name NAME` only to label a worker.

Read the canonical skill before dispatch for remote CI validation, effort selection, preflight,
isolation, failure handling, and verification. For implementer mode, read
[agent-brief.md](../../../.agents/skills/antigravity-neon-agents/references/agent-brief.md).
For fix-round or shepherd mode, also read
[continuation-brief.md](../../../.agents/skills/antigravity-neon-agents/references/continuation-brief.md).
Resolve all worker paths to absolute paths. Run each worker in its own background or long-lived
execution session and retain that session's identity. Honor the user's selected effort without
clamping or substituting. Never recursively invoke this skill from a dispatched worker. Assign
commit, push, review-trigger, and CI actions only when the user's request includes them; the
canonical skill's stopping-point rules apply to every prompt you construct.
