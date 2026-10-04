import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers';
import 'vitest';

// jest-dom 7 registers the runtime matchers in vitest.setup.ts, but its old
// Assertion<T> augmentation does not describe Vitest 5's Assertion<R, T>.
// Extend the supported matcher interface, retaining argument and return types
// for synchronous assertions and promise assertions (resolves/rejects).
declare module 'vitest' {
  interface Matchers<R extends void | Promise<void> = void | Promise<void>, T = unknown>
    extends TestingLibraryMatchers<T, R> {}
}
