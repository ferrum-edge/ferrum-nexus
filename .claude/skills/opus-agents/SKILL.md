---
name: opus-agents
description: Dispatch and orchestrate Claude Code Opus 5 1M CLI subagents (low|medium|high|xhigh|max effort) for Ferrum Nexus issue, PR, review-feedback, CI-repair, and shepherding work, with optional fast mode only when the user explicitly requests it. Use when the user asks Claude to delegate to Claude Code Opus 5 1M workers. Do not use when you are a dispatched worker or for ordinary single-agent edits.
---

# Claude Code Opus 5 1M agents

Act as the orchestrator. Read and follow the shared workflow in
[the canonical skill](../../../.agents/skills/opus-agents/SKILL.md), interpreting its Codex
orchestrator role as your Claude orchestrator role. Use the shared launcher and references;
do not duplicate them in this directory.

```bash
<ABS_REPO>/.agents/skills/opus-agents/scripts/dispatch-agent.sh \
  --worktree <ABS_WORKER_WORKTREE> \
  --prompt-file <ABS_PROMPT_FILE> \
  --effort <low|medium|high|xhigh|max>
```

Append `--fast` only when the user explicitly requests fast mode for that dispatch or fleet.
The shared launcher pins `claude-opus-5[1m]`; use `--model 'opus[1m]'` only for an explicit
rolling-latest Opus request.

Read the canonical skill before dispatch for remote CI validation, effort selection, preflight,
isolation, failure handling, and verification. For implementer mode, read
[agent-brief.md](../../../.agents/skills/opus-agents/references/agent-brief.md).
For fix-round or shepherd mode, also read
[continuation-brief.md](../../../.agents/skills/opus-agents/references/continuation-brief.md).
Resolve all worker paths to absolute paths. Run each worker in its own background or long-lived
execution session and retain that session's identity. Honor the user's selected effort without
clamping or substituting. Never recursively invoke this skill from a dispatched worker.
