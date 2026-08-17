import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('index.html has no #root to mount into');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

/*
 * The service worker is what makes this an app rather than a web page.
 *
 * Registered after load, not during it: the first visit is already downloading the catalog,
 * and competing with that for bandwidth would make the one screen the user is waiting on
 * slower in order to make a later one faster.
 *
 * Absent in dev. A cached shell in front of a Vite dev server means editing a file and
 * being served yesterday's build, which costs more debugging time than it saves.
 */
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    /*
     * Resolved against the DOCUMENT, not this module. The bundle lives in assets/, so a URL
     * relative to import.meta.url would register assets/sw.js -- which does not exist, and
     * whose scope would be assets/ even if it did.
     *
     * The version in the query string is load-bearing: the browser compares the worker's
     * URL byte for byte, so this is what makes a new release install a new worker and throw
     * away the previous build's cached catalog.
     */
    void navigator.serviceWorker.register(`./sw.js?v=${__APP_VERSION__}`);
  });
}
