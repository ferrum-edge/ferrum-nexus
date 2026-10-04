import { useMemo, type ReactElement } from 'react';
import {
  AGENT_TOOL_CALL_LIMIT,
  AGENT_TOOL_NAME_PATTERN,
  MAX_AGENT_DESCRIPTION_LENGTH,
  agentOperations,
  type ApiAgents,
  type AgentTool,
  type SpecEnforcementLevel,
} from '@ferrum-nexus/shared';
import { parseSpecText } from '../openapi/parse';
import { Checkbox, LabeledInput, LabeledTextarea } from '../ui/Input';
import { Badge } from '../ui/Badge';

export interface AgentOperationPickerProps {
  spec: string;
  value: ApiAgents | null;
  onChange(value: ApiAgents | null): void;
  enforcement: SpecEnforcementLevel;
  requestable: boolean;
}

/** Selection and descriptions are portal settings, never unchecked spec extensions. */
export function AgentOperationPicker({
  spec,
  value,
  onChange,
  enforcement,
  requestable,
}: AgentOperationPickerProps): ReactElement {
  const parsed = useMemo(() => {
    const result = parseSpecText(spec);
    if (!result.ok) return { operations: [], error: result.error };
    try {
      return { operations: agentOperations(result.spec.doc), error: null };
    } catch (error) {
      return {
        operations: [],
        error: error instanceof Error ? error.message : 'Invalid operations',
      };
    }
  }, [spec]);
  const selected = value?.operations ?? [];
  const ready = enforcement === 'routes' && requestable && parsed.error === null;
  const changeTool = (tool: AgentTool, fields: Partial<AgentTool>): void => {
    onChange({
      operations: selected.map((item) =>
        item.method === tool.method && item.path === tool.path ? { ...item, ...fields } : item,
      ),
    });
  };
  return (
    <div className="flex flex-col gap-4">
      <Checkbox
        label="Available to AI agents"
        description="Requires routes enforcement and approved access. GET operations are preselected; mutations require an explicit tick."
        checked={value !== null}
        disabled={value === null && !ready}
        onChange={(event) =>
          onChange(
            event.target.checked
              ? {
                  operations: parsed.operations
                    .filter((item) => item.supported && item.read_only)
                    .map(({ path, method, name, description }) => ({
                      path,
                      method,
                      name,
                      description,
                    })),
                }
              : null,
          )
        }
      />
      {value ? (
        <>
          <p className="text-xs text-fg-muted">
            Every exposed tool requires this API’s approval group. Fixed protection denies
            unselected tools, scans MCP arguments for sensitive data, and limits each consumer to{' '}
            {AGENT_TOOL_CALL_LIMIT} tool calls per minute per gateway process (shared with operator
            Redis configuration). Transcript sinks are managed by the gateway operator.
          </p>
          {parsed.error ? <p role="alert">{parsed.error}</p> : null}
          {selected.length === 0 ? (
            <p role="alert">Select at least one supported operation.</p>
          ) : null}
          {parsed.operations.map((operation) => {
            const key = `${operation.method} ${operation.path}`;
            const tool = selected.find(
              (item) => item.method === operation.method && item.path === operation.path,
            );
            return (
              <fieldset
                key={key}
                className="flex flex-col gap-3 rounded-md border border-border p-3"
              >
                <legend className="font-mono text-xs">{key}</legend>
                <Badge tone={operation.read_only ? 'info' : 'warning'}>
                  {operation.read_only ? 'Read-only' : 'Destructive opt-in'}
                </Badge>
                <Checkbox
                  label={`Expose ${key}`}
                  checked={tool !== undefined}
                  disabled={!operation.supported}
                  description={
                    operation.supported ? undefined : 'Not supported by the paired Edge MCP bridge.'
                  }
                  onChange={(event) => {
                    const { path, method, name, description } = operation;
                    onChange({
                      operations: event.target.checked
                        ? [...selected, { path, method, name, description }]
                        : selected.filter((item) => item !== tool),
                    });
                  }}
                />
                {tool ? (
                  <>
                    <LabeledInput
                      label={`Tool name for ${key}`}
                      value={tool.name}
                      maxLength={128}
                      required
                      pattern={AGENT_TOOL_NAME_PATTERN.source}
                      onChange={(event) => changeTool(tool, { name: event.target.value })}
                      hint="Unique letters, digits, underscores, dots or hyphens. Prefixed with the API slug."
                    />
                    <LabeledTextarea
                      label={`Tool description for ${key}`}
                      value={tool.description}
                      maxLength={MAX_AGENT_DESCRIPTION_LENGTH}
                      required
                      rows={2}
                      onChange={(event) => changeTool(tool, { description: event.target.value })}
                    />
                  </>
                ) : null}
              </fieldset>
            );
          })}
        </>
      ) : null}
    </div>
  );
}
