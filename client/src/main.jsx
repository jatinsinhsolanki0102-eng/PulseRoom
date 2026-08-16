import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './index.css';

// Register the service worker immediately (even before login) so the app is
// installable as a PWA and the offline shell is ready on first visit. The push
// effect in App.jsx reuses this same registration (register() is idempotent).
// The worker skips Vite dev module paths, so HMR keeps working locally.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
