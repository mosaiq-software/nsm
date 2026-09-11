import { sequelize } from '@/utils/dbHelper';
import '@/store/registerModels';

// Recreate all tables for a clean slate. Call in beforeEach for DB-backed tests.
export const resetDb = async (): Promise<void> => {
    await sequelize.sync({ force: true });
};

export { sequelize };
