import cors from 'cors';
import express from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { privateRouter, publicRouter, internalRouter, apiKeyRouter } from './routes';
import { config } from './config';
import { requestLogger } from './middleware/requestLog';

export const initApp = async () => {
    const app = express();
    app.use(requestLogger);
    app.use(cors());
    app.use(express.json({ limit: '100mb' }));
    app.use(express.urlencoded({ extended: true, limit: '100mb' }));
    app.set('trust proxy', true);

    app.use(publicRouter);
    app.use(internalRouter);
    // Public API-key-authenticated JSON API. Mounted before the static/SPA handlers so /api/v1 paths
    // are never swallowed by the app-shell fallback.
    app.use(apiKeyRouter);

    // The built UI and its assets are public: the sign-in page must load before a token exists.
    // Static file serving calls next() for non-file paths, so API routes below are unaffected.
    app.use(express.static(config.wwwPath));

    // SPA history fallback for deep links (e.g. /p/:id, /nodes). Gate on an HTML Accept header so
    // only browser navigations resolve to the app shell; API fetches (Accept */*) fall through to
    // the auth-guarded private router below.
    const indexHtml = path.resolve(config.wwwPath, 'index.html');
    app.get('*', (req, res, next) => {
        const accept = req.headers.accept || '';
        if (!accept.includes('text/html')) return next();
        if (!fs.existsSync(indexHtml)) return next();
        res.sendFile(indexHtml);
    });

    app.use(privateRouter);

    return app;
};
