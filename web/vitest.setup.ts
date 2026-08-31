import '@testing-library/jest-dom/vitest';

// jsdom does not implement scrolling; TanStack Router's scroll restoration calls
// it on every navigation, which would otherwise log a "Not implemented" error.
window.scrollTo = () => undefined;
