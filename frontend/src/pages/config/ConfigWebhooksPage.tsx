import { WebhooksSection } from '@/components/WebhooksSection';
import { useProjectConfig } from './projectConfigContext';

const ConfigWebhooksPage = () => {
    const { project } = useProjectConfig();
    return <WebhooksSection projectId={project.id} />;
};

export default ConfigWebhooksPage;
