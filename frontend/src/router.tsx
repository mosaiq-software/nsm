import Layout from '@/pages/Layout';
import DashboardPage from '@/pages/DashboardPage';
import ProjectPage from '@/pages/ProjectPage';
import ProjectDeployPage from '@/pages/ProjectDeployPage';
import ProjectConfigPage from '@/pages/ProjectConfigPage';
import ProjectLogsPage from '@/pages/ProjectLogsPage';
import NodesPage from '@/pages/NodesPage';
import ClusterStatusPage from '@/pages/ClusterStatusPage';
import LandingPage from '@/pages/LandingPage';
import AllowedEntitiesPage from '@/pages/AllowedEntitiesPage';
import { Center, Loader } from '@mantine/core';
import { Route, Routes } from 'react-router-dom';
import { useUser } from './contexts/user-context';

const Router = () => {
    const userCtx = useUser();

    if (!userCtx.user) {
        if (!userCtx.ready) {
            return (
                <Center h="100dvh">
                    <Loader />
                </Center>
            );
        }
        return (
            <Routes>
                <Route path="/" element={<LandingPage />} />
                <Route path="/*" element={<LandingPage />} />
            </Routes>
        );
    }

    return (
        <Layout>
            <Routes>
                <Route path="/" element={<DashboardPage />} />
                <Route path="/p/:projectId" element={<ProjectPage />} />
                <Route path="/p/:projectId/deploy" element={<ProjectDeployPage />} />
                <Route path="/p/:projectId/config" element={<ProjectConfigPage />} />
                <Route path="/p/:projectId/logs" element={<ProjectLogsPage />} />
                <Route path="/nodes" element={<NodesPage />} />
                <Route path="/status" element={<ClusterStatusPage />} />
                <Route path="/access" element={<AllowedEntitiesPage />} />
                <Route path="/*" element={<p>404</p>} />
            </Routes>
        </Layout>
    );
};

export default Router;
