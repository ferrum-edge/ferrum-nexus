import { useMemo, useRef, type ChangeEvent, type ReactElement } from 'react';
import { MAX_SPEC_BYTES } from '@ferrum-nexus/shared';
import { formatBytes } from '../../lib/format';
import { parseSpecText } from '../openapi/parse';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Field, Textarea } from '../ui/Input';
import { Icon } from '../ui/Icon';

export interface SpecEditorProps {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  id?: string;
}

/**
 * OpenAPI document editor: paste or upload, with client-side parse validation
 * so obvious mistakes are caught before the server round-trip.
 */
export function SpecEditor({
  value,
  onChange,
  label = 'OpenAPI specification',
  id = 'spec-editor',
}: SpecEditorProps): ReactElement {
  const fileInput = useRef<HTMLInputElement | null>(null);
  const byteLength = useMemo(() => new TextEncoder().encode(value).length, [value]);
  const result = useMemo(() => (value.trim() ? parseSpecText(value) : null), [value]);
  const tooLarge = byteLength > MAX_SPEC_BYTES;

  const onFile = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    if (!file) return;
    void file.text().then(onChange);
    event.target.value = '';
  };

  return (
    <div className="flex flex-col gap-2">
      <Field
        label={label}
        htmlFor={id}
        hint="YAML or JSON. The document is stored exactly as uploaded."
        required
      >
        <Textarea
          id={id}
          mono
          rows={16}
          spellCheck={false}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={'openapi: 3.0.3\ninfo:\n  title: My API\n  version: 1.0.0\npaths: {}'}
        />
      </Field>

      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileInput}
          type="file"
          accept=".yaml,.yml,.json,application/json,text/yaml"
          className="hidden"
          aria-hidden="true"
          tabIndex={-1}
          onChange={onFile}
        />
        <Button size="sm" variant="secondary" onClick={() => fileInput.current?.click()}>
          <Icon name="download" className="rotate-180" />
          Upload file
        </Button>
        {value ? <span className="text-xs text-fg-subtle">{formatBytes(byteLength)}</span> : null}
        {tooLarge ? (
          <Badge tone="danger">Larger than the {formatBytes(MAX_SPEC_BYTES)} limit</Badge>
        ) : null}
        {result?.ok ? (
          <>
            <Badge tone="success">Valid</Badge>
            <span className="text-xs text-fg-muted">
              {result.spec.title}
              {result.spec.version ? ` v${result.spec.version}` : ''} · {result.spec.operationCount}{' '}
              operations
            </span>
          </>
        ) : null}
      </div>

      {result && !result.ok ? (
        <p className="text-xs text-danger" role="alert">
          {result.error}
        </p>
      ) : null}
    </div>
  );
}

/** True when `text` parses as a usable OpenAPI document. */
export function isSpecValid(text: string): boolean {
  return parseSpecText(text).ok;
}
