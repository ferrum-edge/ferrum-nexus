import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installCspNonce } from './lib/csp-nonce';
import './styles/globals.css';

// Before the first render, so the first injected <style> already carries it.
installCspNonce();

const container = document.getElementById('root');
if (!container) throw new Error('Root container #root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
