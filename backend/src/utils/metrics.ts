import client from 'prom-client';
import { config } from '@/config';

// Single process-wide Prometheus registry, scraped at GET /metrics on every node.
export const registry = new client.Registry();
registry.setDefaultLabels({ nodeId: config.nodeId, role: config.role });
client.collectDefaultMetrics({ register: registry });

export const deploysTotal = new client.Counter({
    name: 'nsm_deploys_total',
    help: 'Number of deployment attempts by result',
    labelNames: ['result'] as const,
    registers: [registry],
});

export const deployDuration = new client.Histogram({
    name: 'nsm_deploy_duration_seconds',
    help: 'Duration of applyDeployment in seconds',
    buckets: [1, 5, 15, 30, 60, 120, 300],
    registers: [registry],
});

export const reconcileDuration = new client.Histogram({
    name: 'nsm_reconcile_duration_seconds',
    help: 'Duration of a reconcile tick in seconds',
    buckets: [0.05, 0.1, 0.5, 1, 5, 15],
    registers: [registry],
});

export const errorsTotal = new client.Counter({
    name: 'nsm_errors_total',
    help: 'Number of errors by area',
    labelNames: ['area'] as const,
    registers: [registry],
});

// Per-project disk usage on this node, split by kind (volume vs deployed code) and by the
// filesystem (device + mountpoint) the data lives on. nodeId comes free from the registry's
// default labels. Populated by the disk-usage collector and scraped into Prometheus so per-project
// storage becomes a time series alongside CPU/mem/net.
export const projectDiskUsageBytes = new client.Gauge({
    name: 'nsm_project_disk_usage_bytes',
    help: 'Disk bytes used per project split by kind, filesystem',
    labelNames: ['projectId', 'kind', 'device', 'mountpoint'] as const,
    registers: [registry],
});
