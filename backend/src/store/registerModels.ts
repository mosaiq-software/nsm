// Importing each persistence module registers its Sequelize model as a side effect.
// Import this before calling sequelize.sync().
import '@/persistence/projectPersistence';
import '@/persistence/secretPersistence';
import '@/persistence/projectInstancePersistence';
import '@/persistence/serviceInstancePersistence';
import '@/persistence/userPersistence';
import '@/persistence/pushSubscriptionPersistence';
import '@/persistence/notificationMutePersistence';
import '@/persistence/allowedEntitiesPersistence';
import '@/persistence/teamConfigPersistence';
import '@/persistence/teamOverridePersistence';
import '@/persistence/adminPersistence';
import '@/persistence/nodePersistence';
import '@/persistence/desiredDeploymentPersistence';
import '@/persistence/certPersistence';
import '@/persistence/clusterMetaPersistence';
import '@/persistence/dnsZonePersistence';
import '@/persistence/dnsRecordPersistence';
import '@/persistence/dnsZoneAssignmentPersistence';
import '@/persistence/domainTeamAllocationPersistence';
import '@/persistence/domainRequestPersistence';
import '@/persistence/quotaBreachPersistence';
import '@/persistence/portReservationPersistence';
