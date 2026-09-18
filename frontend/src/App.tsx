import '@mantine/core/styles.css';
import '@mantine/dropzone/styles.css';
import '@mantine/notifications/styles.css';
import '@mantine/charts/styles.css';

import { UserProvider } from '@/contexts/user-context';
import { MeProvider } from '@/contexts/me-context';
import { ProjectProvider } from '@/contexts/project-context';
import { ClusterProvider } from '@/contexts/cluster-context';
import { createTheme, MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { BrowserRouter } from 'react-router-dom';
import Router from './router';

const theme = createTheme({
    fontFamily: 'Lato, sans-serif',
    headings: { fontFamily: 'Montserrat, sans-serif' },
    primaryColor: 'blue',
});

const App = () => {
    return (
        <MantineProvider theme={theme} defaultColorScheme="light">
            <BrowserRouter>
                <Notifications />
                <UserProvider>
                    <MeProvider>
                        <ProjectProvider>
                            <ClusterProvider>
                                <Router />
                            </ClusterProvider>
                        </ProjectProvider>
                    </MeProvider>
                </UserProvider>
            </BrowserRouter>
        </MantineProvider>
    );
};

export default App;
