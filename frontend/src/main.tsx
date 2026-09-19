import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { registerServiceWorker } from '@/utils/push';
import { installGlobalErrorCapture } from '@/utils/logger';

// Capture uncaught errors and unhandled rejections into the client logger before rendering, so early
// startup failures are shipped once a session token is available.
installGlobalErrorCapture();

ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <App />
    </React.StrictMode>
);

// Register the service worker so push notifications can be delivered while the app is closed.
void registerServiceWorker();
