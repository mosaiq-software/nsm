import { NginxEditor } from '@/components/NginxEditor';
import { useProjectConfig } from './projectConfigContext';

const ConfigRoutingPage = () => {
    const { project, updateProject } = useProjectConfig();
    return <NginxEditor current={project.nginxConfig || { servers: [] }} onSave={(config) => updateProject({ nginxConfig: config })} project={project} />;
};

export default ConfigRoutingPage;
