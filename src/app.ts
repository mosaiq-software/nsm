import cors from 'cors';
import express from 'express';
import { privateRouter, publicRouter, internalRouter } from './routes';
import { config } from './config';

export const initApp = async () => {
    const app = express();
    app.use(cors());
    app.use(express.json({ limit: '100mb' }));
    app.use(express.urlencoded({ extended: true, limit: '100mb' }));
    app.set('trust proxy', true);

    app.use(publicRouter);
    app.use(internalRouter);
    app.use(privateRouter);

    // Serve the built frontend from every node (reads render from the local replicated view).
    app.use(express.static(config.wwwPath));

    return app;
};
