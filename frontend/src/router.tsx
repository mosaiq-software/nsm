import Layout from '@/pages/Layout';
import DashboardPage from '@/pages/DashboardPage';
import ProjectPage from '@/pages/ProjectPage';
import ProjectDeployPage from '@/pages/ProjectDeployPage';
import ProjectConfigLayout from '@/pages/config/ProjectConfigLayout';
import ConfigProjectPage from '@/pages/config/ConfigProjectPage';
import ConfigRoutingPage from '@/pages/config/ConfigRoutingPage';
import ConfigSystemPage from '@/pages/config/ConfigSystemPage';
import ConfigResourcesPage from '@/pages/config/ConfigResourcesPage';
import ConfigKeysPage from '@/pages/config/ConfigKeysPage';
import ConfigWebhooksPage from '@/pages/config/ConfigWebhooksPage';
import MonitoringLogsPage from '@/pages/monitoring/MonitoringLogsPage';
import MonitoringMetricsPage from '@/pages/monitoring/MonitoringMetricsPage';
import MonitoringStatusPage from '@/pages/monitoring/MonitoringStatusPage';
import MonitoringIncidentsPage from '@/pages/monitoring/MonitoringIncidentsPage';
import NodesPage from '@/pages/NodesPage';
import NodeDetailLayout from '@/pages/node/NodeDetailLayout';
import NodeOverviewPage from '@/pages/node/NodeOverviewPage';
import NodeConfigPage from '@/pages/node/NodeConfigPage';
import NodeStoragePage from '@/pages/node/NodeStoragePage';
import DomainsPage from '@/pages/DomainsPage';
import DomainDetailPage from '@/pages/DomainDetailPage';
import NsmLogsPage from '@/pages/NsmLogsPage';
import LandingPage from '@/pages/LandingPage';
import UserManagementPage from '@/pages/UserManagementPage';
import SettingsPage from '@/pages/SettingsPage';
import TeamDetailPage from '@/pages/TeamDetailPage';
import NoAccessPage from '@/pages/NoAccessPage';
import { Center, Loader } from '@mantine/core';
import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import { useUser } from './contexts/user-context';
import { useMe } from '@/hooks/queries/useMe';

// Redirect the retired flat project routes (/p/:id/logs, /p/:id/status) to their Monitoring homes.
const MonitoringRedirect = ({ sub }: { sub: string }) => {
    const { projectId } = useParams();
    return <Navigate to={`/p/${projectId}/monitoring/${sub}`} replace />;
};

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
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="/p/:projectId" element={<ProjectPage />} />
                <Route path="/p/:projectId/deploy" element={<ProjectDeployPage />} />
                <Route path="/p/:projectId/config" element={<ProjectConfigLayout />}>
                    <Route index element={<Navigate to="project" replace />} />
                    <Route path="project" element={<ConfigProjectPage />} />
                    <Route path="routing" element={<ConfigRoutingPage />} />
                    <Route path="system" element={<ConfigSystemPage />} />
                    <Route path="resources" element={<ConfigResourcesPage />} />
                    <Route path="keys" element={<ConfigKeysPage />} />
                    <Route path="webhooks" element={<ConfigWebhooksPage />} />
                </Route>
                <Route path="/p/:projectId/monitoring" element={<MonitoringRedirect sub="status" />} />
                <Route path="/p/:projectId/monitoring/logs" element={<MonitoringLogsPage />} />
                <Route path="/p/:projectId/monitoring/metrics" element={<MonitoringMetricsPage />} />
                <Route path="/p/:projectId/monitoring/status" element={<MonitoringStatusPage />} />
                <Route path="/p/:projectId/monitoring/incidents" element={<MonitoringIncidentsPage />} />
                {/* Redirects from the old flat routes to their new Monitoring homes. */}
                <Route path="/p/:projectId/logs" element={<MonitoringRedirect sub="logs" />} />
                <Route path="/p/:projectId/status" element={<MonitoringRedirect sub="status" />} />
                {meCtx.isAdmin && <Route path="/nodes" element={<NodesPage />} />}
                {meCtx.isAdmin && (
                    <Route path="/nodes/:nodeId" element={<NodeDetailLayout />}>
                        <Route index element={<NodeOverviewPage />} />
                        <Route path="config" element={<NodeConfigPage />} />
                        <Route path="storage" element={<NodeStoragePage />} />
                    </Route>
                )}
                <Route path="/domains" element={<DomainsPage />} />
                <Route path="/domains/:zoneId" element={<DomainDetailPage />} />

                {meCtx.isAdmin && <Route path="/logs" element={<NsmLogsPage />} />}
                {meCtx.isAdmin && <Route path="/users" element={<UserManagementPage />} />}
                <Route path="/teams/:ownerId" element={<TeamDetailPage />} />
                <Route path="/*" element={<p>404</p>} />
            </Routes>
        </Layout>
    );
};

export default Router;
