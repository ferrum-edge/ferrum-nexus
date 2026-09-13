import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState, type ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_SPEC_BYTES, MAX_SPEC_OPERATIONS } from '@ferrum-nexus/shared';
import { RAW_SPEC } from '../../../test/fixtures';
import { SpecEditor, isSpecValid } from './SpecEditor';

function Editor({ initialValue = '' }: { initialValue?: string }): ReactElement {
  const [value, setValue] = useState(initialValue);
  return <SpecEditor value={value} onChange={setValue} />;
}

function operationSpec(count: number): string {
  const paths: Record<string, Record<string, object>> = {};
  for (let index = 0; index < count; index += 1) {
    const path = `/resource-${Math.floor(index / 2)}`;
    paths[path] ??= {};
    paths[path][index % 2 === 0 ? 'get' : 'post'] = {
      responses: { '200': { description: 'OK' } },
    };
  }
  return JSON.stringify({ openapi: '3.0.3', info: { title: 'Large API', version: '1' }, paths });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('OpenAPI specification editor', () => {
  it('starts quietly, reports parse errors, and updates the summary when corrected', () => {
    render(<Editor />);
    const input = screen.getByLabelText(/OpenAPI specification/);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('Valid')).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: '{ invalid JSON' } });
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('Valid')).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: RAW_SPEC } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('Valid')).toBeInTheDocument();
    expect(screen.getByText('Billing specification v1.0.0 · 2 operations')).toBeInTheDocument();
    expect(input).toHaveValue(RAW_SPEC);
    fireEvent.change(input, { target: { value: '  ' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('Valid')).not.toBeInTheDocument();
  });

  it('accepts YAML and preserves the original text', () => {
    const yaml = 'openapi: 3.0.3\ninfo:\n  title: YAML API\npaths: {}\n';
    render(<Editor initialValue={yaml} />);
    expect(screen.getByText('YAML API · 0 operations')).toBeInTheDocument();
    expect(screen.getByLabelText(/OpenAPI specification/)).toHaveValue(yaml);
    expect(isSpecValid(yaml)).toBe(true);
    expect(isSpecValid('plain text')).toBe(false);
    expect(isSpecValid('')).toBe(false);
  });

  it('opens the file picker and permits uploading the same file again', async () => {
    const { container } = render(<Editor />);
    // The file input is intentionally hidden from the accessibility tree.
    const picker = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const click = vi.spyOn(picker, 'click');
    fireEvent.click(screen.getByRole('button', { name: 'Upload file' }));
    expect(click).toHaveBeenCalledTimes(1);
    const file = new File([RAW_SPEC], 'billing.json', { type: 'application/json' });
    // jsdom's File does not implement Blob.text; supply that browser primitive.
    const text = vi.fn().mockResolvedValue(RAW_SPEC);
    Object.defineProperty(file, 'text', { value: text });
    fireEvent.change(picker, { target: { files: [file] } });
    await waitFor(() => {
      expect(screen.getByLabelText(/OpenAPI specification/)).toHaveValue(RAW_SPEC);
    });
    expect(picker.value).toBe('');
    fireEvent.change(picker, { target: { files: [] } });
    expect(text).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText(/OpenAPI specification/), { target: { value: '' } });
    fireEvent.change(picker, { target: { files: [file] } });
    await waitFor(() => {
      expect(screen.getByLabelText(/OpenAPI specification/)).toHaveValue(RAW_SPEC);
    });
    expect(text).toHaveBeenCalledTimes(2);
  });

  it('counts UTF-8 bytes when warning about the upload size', () => {
    const text = JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'Large description', description: 'é'.repeat(MAX_SPEC_BYTES / 2) },
      paths: {},
    });
    expect(text.length).toBeLessThan(MAX_SPEC_BYTES);
    render(<Editor initialValue={text} />);
    expect(screen.getByText('Larger than the 2.00 MB limit')).toBeInTheDocument();
  });

  it('accepts the operation limit and refuses a document one operation over it', () => {
    const accepted = operationSpec(MAX_SPEC_OPERATIONS);
    const rejected = operationSpec(MAX_SPEC_OPERATIONS + 1);
    expect(isSpecValid(accepted)).toBe(true);
    expect(isSpecValid(rejected)).toBe(false);
    const { rerender } = render(<SpecEditor value={rejected} onChange={() => undefined} />);
    expect(screen.getByText('Too many operations')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Split it into several APIs.');
    expect(screen.queryByText('Valid')).not.toBeInTheDocument();
    rerender(<SpecEditor value={accepted} onChange={() => undefined} />);
    expect(screen.getByText('Valid')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
