import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import App from './App';
import { queryClient } from '@/query/client';
import { registerServiceWorker } from '@/utils/push';
import { installGlobalErrorCapture } from '@/utils/logger';

// Capture uncaught errors and unhandled rejections into the client logger before rendering, so early
// startup failures are shipped once a session token is available.
installGlobalErrorCapture();

ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <QueryClientProvider client={queryClient}>
            <App />
            <ReactQueryDevtools initialIsOpen={false} />
        </QueryClientProvider>
    </React.StrictMode>
);

// Register the service worker so push notifications can be delivered while the app is closed.
void registerServiceWorker();
