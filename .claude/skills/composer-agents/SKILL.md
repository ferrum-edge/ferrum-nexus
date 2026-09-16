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

Read the canonical skill before dispatch for effort selection, preflight, isolation, failure
handling, and verification. For implementer mode, read
[agent-brief.md](../../../.agents/skills/composer-agents/references/agent-brief.md).
For fix-round or shepherd mode, also read
[continuation-brief.md](../../../.agents/skills/composer-agents/references/continuation-brief.md).
Resolve all worker paths to absolute paths. Run each worker in its own background or long-lived
execution session and retain that session's identity. Honor the user's selected effort without
clamping or substituting. Never recursively invoke this skill from a dispatched worker. Assign
commit, push, review-trigger, and CI actions only when the user's request includes them; the
canonical skill's stopping-point rules apply to every prompt you construct.

## Remote CI validation

Do not run local builds, tests, benchmarks, or compilation-based checks, including `npm run build`,
`npm test`, `npm run typecheck`, `npm run lint`, and their workspace-scoped forms, or wrappers that
invoke them. Do not make an exception for a targeted check, an ambiguous failure, or a controller's
routine validation request. Local source inspection, formatting with `npx prettier --write`, and
`git diff --check` are allowed.

Use remote CI results for the exact pushed head SHA as build/test confirmation. Inspect failed
job logs, fix the demonstrated failure, push the change, and use the next CI run to confirm it.
Pending, skipped, unavailable, or earlier-head checks are not evidence that the change passed.
Keep adding or updating relevant tests; remote CI executes them.

The controller owns post-push CI monitoring unless the worker is explicitly assigned a CI repair
or shepherd round. A worker assigned to exit after pushing must report the head SHA and CI status
as pending or unverified and exit; the controller continues the CI-driven fix loop. Never report
build/test success without matching remote evidence.

Include the no-local-build/test rule and remote CI confirmation requirement in every dispatch
prompt, including continuation prompts and any permitted nested delegation.
