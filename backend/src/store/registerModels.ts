// Importing each persistence module registers its Sequelize model as a side effect.
// Import this before calling sequelize.sync().
import '@/persistence/projectPersistence';
import '@/persistence/secretPersistence';
import '@/persistence/projectInstancePersistence';
import '@/persistence/serviceInstancePersistence';
import '@/persistence/userPersistence';
import '@/persistence/pushSubscriptionPersistence';
import '@/persistence/allowedEntitiesPersistence';
import '@/persistence/nodePersistence';
import '@/persistence/desiredDeploymentPersistence';
import '@/persistence/certPersistence';
import '@/persistence/clusterMetaPersistence';
