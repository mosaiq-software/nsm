import { createContext, useContext } from 'react';
import { DynamicEnvVariable, PortReservation, Project, Secret } from '@mosaiq/nsm-common/types';

// Shared editing state for the project configuration subpages. The layout owns the editable draft
// (project + secrets) and the single save flow; each subpage reads and mutates it through here.
export interface ProjectConfigContextValue {
    project: Project;
    projectId: string;
    updateProject: (updatedFields: Partial<Project>) => void;
    secrets: Secret[];
    setSecrets: React.Dispatch<React.SetStateAction<Secret[]>>;
    updateSecret: (secret: Secret) => void;
    dynamicEnvVariables: DynamicEnvVariable[];
    portReservations: PortReservation[];
    isSame: boolean;
    saveChanges: () => Promise<void>;
}

export const ProjectConfigContext = createContext<ProjectConfigContextValue | undefined>(undefined);

export const useProjectConfig = (): ProjectConfigContextValue => {
    const ctx = useContext(ProjectConfigContext);
    if (ctx === undefined) {
        throw new Error('useProjectConfig must be used within a ProjectConfigLayout');
    }
    return ctx;
};
