import { type ReactElement } from 'react';
import {
  DEFAULT_BACKEND_CONNECT_TIMEOUT_MS,
  DEFAULT_BACKEND_READ_TIMEOUT_MS,
  DEFAULT_BACKEND_WRITE_TIMEOUT_MS,
  HTTP_METHODS,
  MAX_BACKEND_TIMEOUT_MS,
  MIN_BACKEND_TIMEOUT_MS,
  type ApiTimeouts,
  type HttpMethod,
} from '@ferrum-nexus/shared';
import { Button } from '../ui/Button';
import { Checkbox, Field, Input } from '../ui/Input';

/** The three timeout boxes as the provider typed them; blank means "default". */
export interface TimeoutDraft {
  connect: string;
  read: string;
  write: string;
}

/** All three boxes empty — the API keeps the gateway's own timeouts. */
export const EMPTY_TIMEOUT_DRAFT: TimeoutDraft = { connect: '', read: '', write: '' };

/** Fill the boxes from a stored value; `null` leaves them blank. */
export function timeoutDraftFrom(timeouts: ApiTimeouts | null): TimeoutDraft {
  if (!timeouts) return EMPTY_TIMEOUT_DRAFT;
  return {
    connect: String(timeouts.connect_ms),
    read: String(timeouts.read_ms),
    write: String(timeouts.write_ms),
  };
}

/**
 * Turn the three boxes into the wire value.
 *
 * `null` means "leave the gateway defaults alone" — the only reading of three
 * empty boxes. A `string` is a message to show the provider. A box left blank
 * next to a filled one takes the gateway default rather than failing, because
 * the three travel together: Edge's proxy `PUT` is a whole-resource replace, so
 * the portal never sends a partial set.
 */
export function parseTimeoutDraft(draft: TimeoutDraft): ApiTimeouts | null | string {
  const fields = [
    ['Connect', draft.connect, DEFAULT_BACKEND_CONNECT_TIMEOUT_MS],
    ['Read', draft.read, DEFAULT_BACKEND_READ_TIMEOUT_MS],
    ['Write', draft.write, DEFAULT_BACKEND_WRITE_TIMEOUT_MS],
  ] as const;

  if (fields.every(([, raw]) => raw.trim() === '')) return null;

  const values: number[] = [];
  for (const [label, raw, fallback] of fields) {
    if (raw.trim() === '') {
      values.push(fallback);
      continue;
    }
    const parsed = Number.parseInt(raw, 10);
    if (
      !Number.isFinite(parsed) ||
      parsed < MIN_BACKEND_TIMEOUT_MS ||
      parsed > MAX_BACKEND_TIMEOUT_MS
    ) {
      return `The ${label.toLowerCase()} timeout must be a whole number of milliseconds between ${MIN_BACKEND_TIMEOUT_MS} and ${MAX_BACKEND_TIMEOUT_MS.toLocaleString()}.`;
    }
    values.push(parsed);
  }
  return { connect_ms: values[0] ?? 0, read_ms: values[1] ?? 0, write_ms: values[2] ?? 0 };
}

export interface AdvancedProxySettingsProps {
  /** Selected methods; an empty list means "accept every method". */
  methods: HttpMethod[];
  onMethodsChange: (next: HttpMethod[]) => void;
  timeouts: TimeoutDraft;
  onTimeoutsChange: (next: TimeoutDraft) => void;
  circuitBreaker: boolean;
  onCircuitBreakerChange: (next: boolean) => void;
  /**
   * Methods the current OpenAPI document declares. Omit it (or pass an empty
   * list) and the "use the spec's methods" shortcut is not offered — which is
   * what happens when no document is available to read.
   */
  specMethods?: HttpMethod[];
}

/**
 * Proxy settings that are neither identity nor a plugin: the method allow-list,
 * the backend timeouts and the circuit breaker.
 *
 * Shared by the publish form and the API settings tab so the two cannot drift.
 */
export function AdvancedProxySettings({
  methods,
  onMethodsChange,
  timeouts,
  onTimeoutsChange,
  circuitBreaker,
  onCircuitBreakerChange,
  specMethods = [],
}: AdvancedProxySettingsProps): ReactElement {
  const toggle = (method: HttpMethod, checked: boolean): void => {
    onMethodsChange(
      checked
        ? HTTP_METHODS.filter((entry) => entry === method || methods.includes(entry))
        : methods.filter((entry) => entry !== method),
    );
  };

  return (
    <div className="flex flex-col gap-4 md:col-span-2">
      <Field
        label="Allowed HTTP methods"
        htmlFor="allowed-methods"
        hint={
          methods.length === 0
            ? 'Nothing selected: the gateway accepts every method. Select some to have it answer 405 to the rest — before any plugin runs, so OPTIONS is added for you when a CORS policy is set.'
            : 'The gateway answers 405 to every other method, before any plugin runs. OPTIONS is added for you when a CORS policy is set.'
        }
      >
        <div id="allowed-methods" className="flex flex-wrap gap-x-4 gap-y-2">
          {HTTP_METHODS.map((method) => (
            <Checkbox
              key={method}
              label={method}
              checked={methods.includes(method)}
              onChange={(event) => toggle(method, event.target.checked)}
            />
          ))}
        </div>
      </Field>

      {specMethods.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" onClick={() => onMethodsChange([...specMethods])}>
            Use the methods declared in the spec
          </Button>
          <span className="text-xs text-fg-subtle">{specMethods.join(', ')}</span>
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-3">
        <Field label="Connect timeout (ms)" htmlFor="timeout-connect">
          <Input
            id="timeout-connect"
            type="number"
            min={MIN_BACKEND_TIMEOUT_MS}
            max={MAX_BACKEND_TIMEOUT_MS}
            placeholder={String(DEFAULT_BACKEND_CONNECT_TIMEOUT_MS)}
            value={timeouts.connect}
            onChange={(event) => onTimeoutsChange({ ...timeouts, connect: event.target.value })}
          />
        </Field>
        <Field label="Read timeout (ms)" htmlFor="timeout-read">
          <Input
            id="timeout-read"
            type="number"
            min={MIN_BACKEND_TIMEOUT_MS}
            max={MAX_BACKEND_TIMEOUT_MS}
            placeholder={String(DEFAULT_BACKEND_READ_TIMEOUT_MS)}
            value={timeouts.read}
            onChange={(event) => onTimeoutsChange({ ...timeouts, read: event.target.value })}
          />
        </Field>
        <Field
          label="Write timeout (ms)"
          htmlFor="timeout-write"
          className="md:col-span-1"
          hint="Blank uses the gateway defaults shown as placeholders."
        >
          <Input
            id="timeout-write"
            type="number"
            min={MIN_BACKEND_TIMEOUT_MS}
            max={MAX_BACKEND_TIMEOUT_MS}
            placeholder={String(DEFAULT_BACKEND_WRITE_TIMEOUT_MS)}
            value={timeouts.write}
            onChange={(event) => onTimeoutsChange({ ...timeouts, write: event.target.value })}
          />
        </Field>
      </div>

      <Checkbox
        label="Trip a circuit breaker when the backend fails"
        description="After 5 consecutive failures (500/502/503/504 or a connection error) the gateway stops forwarding for 30 seconds, then probes until 3 calls succeed."
        checked={circuitBreaker}
        onChange={(event) => onCircuitBreakerChange(event.target.checked)}
      />
    </div>
  );
}
