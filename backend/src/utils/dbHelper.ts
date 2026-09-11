import { Sequelize } from 'sequelize';
import * as fs from 'fs';
import { config } from '@/config';

fs.mkdirSync(config.databaseDir, { recursive: true });

export const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: `${config.databaseDir}/${config.databaseName}`,
    logging: process.env.DATABASE_LOGGING === 'true',
});
