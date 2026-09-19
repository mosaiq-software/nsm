import * as addSecretComment from './0001-secrets-add-comment';
import * as addProjectColumns from './0002-projects-add-additive-columns';
import * as migrateAdmins from './0003-access-control-migrate-admins';
import * as addProjectCicdColumn from './0004-projects-add-cicd-column';
import * as addProjectResourceQuotaColumn from './0005-projects-add-resource-quota-column';
import * as dropServiceInstanceCollectLogs from './0006-service-instances-drop-collect-logs';

// Ordered list of migrations. Statically imported (rather than glob-loaded) so module resolution
// is identical under tsx, the test runner, and production. Append new migrations to the end.
export const migrations = [addSecretComment, addProjectColumns, migrateAdmins, addProjectCicdColumn, addProjectResourceQuotaColumn, dropServiceInstanceCollectLogs].map((m) => ({
    name: m.name,
    up: m.up,
    down: m.down,
}));
