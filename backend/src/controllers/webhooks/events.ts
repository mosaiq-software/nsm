import { DeploymentState, HealthStatus, Incident, IncidentImpact, IncidentKind, IncidentUpdate, Project, ProjectEvent, ProjectEventSeverity, ProjectEventType } from '@mosaiq/nsm-common/types';
import { config } from '@/config';
import type { QuotaBreachInfo } from '@/controllers/pushController';

// Absolute deep link back into the NSM dashboard for a project (Discord embeds need absolute URLs).
export const projectEventUrl = (projectId: string, path = ''): string => {
    const base = config.publicUrl.replace(/\/$/, '');
    return `${base}/p/${projectId}${path}`;
};

const impactSeverity = (impact: IncidentImpact): ProjectEventSeverity => {
    switch (impact) {
        case IncidentImpact.CRITICAL:
            return ProjectEventSeverity.ERROR;
        case IncidentImpact.MAJOR:
        case IncidentImpact.MINOR:
            return ProjectEventSeverity.WARNING;
        default:
            return ProjectEventSeverity.INFO;
    }
};

const formatGiB = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(2)} GB`;

const quotaBreachLine = (b: QuotaBreachInfo): string => {
    switch (b.resource) {
        case 'cpu':
            return `CPU: ${b.usage.toFixed(2)} / ${b.limit.toFixed(2)} cores`;
        case 'memory':
            return `Memory: ${formatGiB(b.usage)} / ${formatGiB(b.limit)}`;
        case 'storage':
            return `Storage: ${formatGiB(b.usage)} / ${formatGiB(b.limit)}`;
    }
};

// Map a deployment state transition to a deploy event. Returns null for states we do not surface
// (e.g. DEPLOYING/DESTROYING/READY). QUEUED is the first observable signal, treated as "started".
export const buildDeployEvent = (project: Project, state: DeploymentState): ProjectEvent | null => {
    const base = { projectId: project.id, timestamp: Date.now(), url: projectEventUrl(project.id, '/deploy') };
    switch (state) {
        case DeploymentState.QUEUED:
            return { ...base, type: ProjectEventType.DEPLOY_STARTED, severity: ProjectEventSeverity.INFO, title: `Deploy started: ${project.id}`, description: `${project.id} was queued for deployment.` };
        case DeploymentState.DEPLOYED:
        case DeploymentState.HEALTHY:
            return { ...base, type: ProjectEventType.DEPLOY_SUCCEEDED, severity: ProjectEventSeverity.SUCCESS, title: `Deployed: ${project.id}`, description: `${project.id} finished deploying.` };
        case DeploymentState.FAILED:
            return { ...base, type: ProjectEventType.DEPLOY_FAILED, severity: ProjectEventSeverity.ERROR, title: `Deploy failed: ${project.id}`, description: `${project.id} failed to deploy.` };
        case DeploymentState.CANCELLED:
            return { ...base, type: ProjectEventType.DEPLOY_CANCELLED, severity: ProjectEventSeverity.WARNING, title: `Deploy cancelled: ${project.id}`, description: `The deployment of ${project.id} was cancelled.` };
        default:
            return null;
    }
};

export const buildIncidentCreatedEvent = (incident: Incident): ProjectEvent => {
    const maintenance = incident.kind === IncidentKind.MAINTENANCE;
    return {
        type: ProjectEventType.INCIDENT_CREATED,
        projectId: incident.projectId,
        severity: maintenance ? ProjectEventSeverity.INFO : impactSeverity(incident.impact),
        title: `${maintenance ? 'Maintenance scheduled' : 'Incident opened'}: ${incident.title}`,
        description: `A new ${maintenance ? 'maintenance window' : 'incident'} was created for ${incident.projectId}.`,
        url: projectEventUrl(incident.projectId, '/status'),
        fields: [
            { name: 'Status', value: incident.status },
            { name: 'Impact', value: incident.impact },
        ],
        timestamp: Date.now(),
    };
};

export const buildIncidentUpdatedEvent = (incident: Incident, update: IncidentUpdate): ProjectEvent => ({
    type: ProjectEventType.INCIDENT_UPDATED,
    projectId: incident.projectId,
    severity: impactSeverity(incident.impact),
    title: `Incident updated: ${incident.title}`,
    description: update.body,
    url: projectEventUrl(incident.projectId, '/status'),
    fields: [{ name: 'Status', value: update.status }],
    timestamp: Date.now(),
});

export const buildIncidentResolvedEvent = (incident: Incident, update: IncidentUpdate): ProjectEvent => ({
    type: ProjectEventType.INCIDENT_RESOLVED,
    projectId: incident.projectId,
    severity: ProjectEventSeverity.SUCCESS,
    title: `Resolved: ${incident.title}`,
    description: update.body,
    url: projectEventUrl(incident.projectId, '/status'),
    fields: [{ name: 'Status', value: update.status }],
    timestamp: Date.now(),
});

// Map an overall-health transition to an event. Caller guarantees prev !== next and neither is
// UNKNOWN. Returns null when the transition is not one we notify on.
export const buildHealthTransitionEvent = (projectId: string, prev: HealthStatus, next: HealthStatus): ProjectEvent | null => {
    const base = { projectId, timestamp: Date.now(), url: projectEventUrl(projectId, '/status') };
    if (next === HealthStatus.DOWN && prev !== HealthStatus.DOWN) {
        return { ...base, type: ProjectEventType.HEALTH_DOWN, severity: ProjectEventSeverity.ERROR, title: `Down: ${projectId}`, description: `${projectId} is no longer serving.` };
    }
    if (next === HealthStatus.DEGRADED && prev !== HealthStatus.DEGRADED) {
        return { ...base, type: ProjectEventType.HEALTH_DEGRADED, severity: ProjectEventSeverity.WARNING, title: `Degraded: ${projectId}`, description: `${projectId} is answering but impaired.` };
    }
    if (next === HealthStatus.UP && prev !== HealthStatus.UP) {
        return { ...base, type: ProjectEventType.HEALTH_RECOVERED, severity: ProjectEventSeverity.SUCCESS, title: `Recovered: ${projectId}`, description: `${projectId} is serving normally again.` };
    }
    return null;
};

export const buildQuotaBreachEvent = (project: Project, breaches: QuotaBreachInfo[]): ProjectEvent => ({
    type: ProjectEventType.QUOTA_BREACHED,
    projectId: project.id,
    severity: ProjectEventSeverity.WARNING,
    title: `Over allocation: ${project.id}`,
    description: `${project.id} has exceeded its resource allocation.`,
    url: projectEventUrl(project.id, '/logs'),
    fields: breaches.map((b) => ({ name: b.resource.toUpperCase(), value: quotaBreachLine(b) })),
    timestamp: Date.now(),
});
