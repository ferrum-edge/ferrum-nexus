import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CallApiPanel, exampleRequest, shellQuote } from './CallApiPanel';

const writeText = vi.fn<(value: string) => Promise<void>>();

beforeEach(() => {
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
    writable: true,
  });
});

afterEach(cleanup);

/**
 * Split a command line the way a POSIX shell does for the only forms the
 * example uses: bare words, single-quoted strings and `\` escapes.
 */
function shellWords(command: string): string[] {
  const words: string[] = [];
  let word: string | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command.charAt(index);
    if (char === "'") {
      const close = command.indexOf("'", index + 1);
      if (close === -1) throw new Error('unterminated quote');
      word = (word ?? '') + command.slice(index + 1, close);
      index = close;
    } else if (char === '\\') {
      const next = command.charAt(index + 1);
      index += 1;
      // A backslash-newline is a line continuation, not part of any word.
      if (next !== '\n') word = (word ?? '') + next;
    } else if (char === ' ' || char === '\n') {
      if (word !== null) words.push(word);
      word = null;
    } else {
      word = (word ?? '') + char;
    }
  }
  if (word !== null) words.push(word);
  return words;
}

/** The `Authorization` header curl derives from a `--user` argument (ASCII here). */
function curlBasicHeader(userArgument: string): string {
  return `Basic ${btoa(userArgument)}`;
}

const TARGET = 'https://gateway.example.test/team/billing';
const CONSUMER = 'nexus-app-app-a';

describe('shellQuote', () => {
  it.each(['plain', "it's", 'p@ss:w\'rd"$!`\\ ;&|', "''", ''])('round-trips %j', (value) => {
    expect(shellWords(`curl ${shellQuote(value)}`)).toEqual(['curl', value]);
  });
});

describe('exampleRequest', () => {
  it('authenticates HTTP Basic with --user, never a literal base64(...) header', () => {
    const command = exampleRequest(TARGET, 'basic_auth', CONSUMER);
    expect(command).toBe(`curl '${TARGET}' \\\n  --user '${CONSUMER}:<your password>'`);
    expect(command).not.toContain('base64(');
    expect(command).not.toContain('Authorization');
  });

  it('carries a punctuated password through to a correctly encoded Basic header', () => {
    const password = `p@ss:w'rd"$!\\`;
    const template = exampleRequest(TARGET, 'basic_auth', CONSUMER);
    // What a caller does with the placeholder: put their password in, quoted
    // for the shell the same way the example quotes the rest.
    const filled = template.replace(
      shellQuote(`${CONSUMER}:<your password>`),
      shellQuote(`${CONSUMER}:${password}`),
    );
    const words = shellWords(filled);
    expect(words).toEqual(['curl', TARGET, '--user', `${CONSUMER}:${password}`]);
    const header = curlBasicHeader(words[3] ?? '');
    expect(header).toBe(`Basic ${btoa(`${CONSUMER}:${password}`)}`);
    const decoded = atob(header.slice('Basic '.length));
    expect(decoded).toBe(`${CONSUMER}:${password}`);
  });

  it.each([
    ['key_auth', ['-H', 'X-API-Key: <your key>']],
    ['jwt_auth', ['-H', 'Authorization: Bearer <token you sign>']],
  ] as const)('sends the %s header as one shell word', (authPlugin, auth) => {
    expect(shellWords(exampleRequest(TARGET, authPlugin, CONSUMER))).toEqual([
      'curl',
      TARGET,
      ...auth,
    ]);
  });
});

describe('CallApiPanel', () => {
  it.each(['nexus-user-user-1', 'nexus-app-app-a'])(
    'shows and copies the same Basic example for %s',
    async (consumer) => {
      render(
        <CallApiPanel
          invokeUrl={TARGET}
          listenPath="/team/billing"
          authPlugin="basic_auth"
          consumer={consumer}
          holder="Billing worker"
        />,
      );
      const snippet = exampleRequest(TARGET, 'basic_auth', consumer);
      const shown = screen.getByText(
        (_, element) => element?.tagName === 'CODE' && element.textContent === snippet,
      );
      expect(shown).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Copy example request' }));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(snippet));
      expect(shellWords(snippet)[3]).toBe(`${consumer}:<your password>`);
    },
  );

  it('names the selected identity as the JWT subject', () => {
    render(
      <CallApiPanel
        invokeUrl={null}
        listenPath="/team/billing"
        authPlugin="jwt_auth"
        consumer={CONSUMER}
        holder="Billing worker"
      />,
    );
    expect(screen.getByText(/claim must be/).querySelectorAll('code')[1]).toHaveTextContent(
      CONSUMER,
    );
    expect(screen.getByText(/to Billing worker from the credentials page/)).toBeInTheDocument();
  });
});
