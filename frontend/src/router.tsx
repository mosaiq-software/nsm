import Layout from '@/pages/Layout';
import DashboardPage from '@/pages/DashboardPage';
import ProjectPage from '@/pages/ProjectPage';
import ProjectDeployPage from '@/pages/ProjectDeployPage';
import ProjectConfigPage from '@/pages/ProjectConfigPage';
import ProjectLogsPage from '@/pages/ProjectLogsPage';
import NodesPage from '@/pages/NodesPage';
import NodeDetailPage from '@/pages/NodeDetailPage';
import AllocationsPage from '@/pages/AllocationsPage';
import NsmLogsPage from '@/pages/NsmLogsPage';
import LandingPage from '@/pages/LandingPage';
import UserManagementPage from '@/pages/UserManagementPage';
import TeamDetailPage from '@/pages/TeamDetailPage';
import NoAccessPage from '@/pages/NoAccessPage';
import { Center, Loader } from '@mantine/core';
import { Route, Routes } from 'react-router-dom';
import { useUser } from './contexts/user-context';
import { useMe } from './contexts/me-context';

const Router = () => {
    const userCtx = useUser();
    const meCtx = useMe();

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

    // Signed in, but we need the permission view before we can render the app shell.
    if (!meCtx.ready) {
        return (
            <Center h="100dvh">
                <Loader />
            </Center>
        );
    }

    if (meCtx.hasNoAccess) {
        return <NoAccessPage />;
    }

    return (
        <Layout>
            <Routes>
                <Route path="/" element={<DashboardPage />} />
                <Route path="/p/:projectId" element={<ProjectPage />} />
                <Route path="/p/:projectId/deploy" element={<ProjectDeployPage />} />
                <Route path="/p/:projectId/config" element={<ProjectConfigPage />} />
                <Route path="/p/:projectId/logs" element={<ProjectLogsPage />} />
                {meCtx.isAdmin && <Route path="/nodes" element={<NodesPage />} />}
                {meCtx.isAdmin && <Route path="/nodes/:nodeId" element={<NodeDetailPage />} />}
                {meCtx.isAdmin && <Route path="/allocations" element={<AllocationsPage />} />}
                {meCtx.isAdmin && <Route path="/logs" element={<NsmLogsPage />} />}
                {meCtx.isAdmin && <Route path="/users" element={<UserManagementPage />} />}
                <Route path="/teams/:ownerId" element={<TeamDetailPage />} />
                <Route path="/*" element={<p>404</p>} />
            </Routes>
        </Layout>
    );
};

export default Router;
