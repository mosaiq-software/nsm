import { WebhooksSection } from '@/components/WebhooksSection';
import { useMe } from '@/contexts/me-context';
import { useProjectConfig } from './projectConfigContext';

const ConfigWebhooksPage = () => {
    const { project } = useProjectConfig();
    const meCtx = useMe();
    const projectTeam = meCtx.teams.find((t) => t.projects.some((p) => p.id === project.id));
    return <WebhooksSection projectId={project.id} githubAppInstalled={!!projectTeam?.installed} />;
};

export default ConfigWebhooksPage;
