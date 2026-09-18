import * as addSecretComment from './0001-secrets-add-comment';
import * as addProjectColumns from './0002-projects-add-additive-columns';
import * as migrateAdmins from './0003-access-control-migrate-admins';

// Ordered list of migrations. Statically imported (rather than glob-loaded) so module resolution
// is identical under tsx, the test runner, and production. Append new migrations to the end.
export const migrations = [addSecretComment, addProjectColumns, migrateAdmins].map((m) => ({
    name: m.name,
    up: m.up,
    down: m.down,
}));
