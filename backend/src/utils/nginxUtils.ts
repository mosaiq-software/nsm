// https://www.digitalocean.com/community/tutorials/understanding-nginx-server-and-location-block-selection-algorithms#parsing-the-server_name-directive-to-choose-a-match
import { CustomConfigLocation, DeployableProject, NginxConfigLocationType, Project, ProxyConfigLocation, RedirectConfigLocation, StaticConfigLocation } from '@mosaiq/nsm-common/types';

export const getStaticLocation = (conf: StaticConfigLocation) => {
    const explicitCorsString = conf.explicitCors
        ? `
    if ($request_method = 'OPTIONS') {
        add_header 'Access-Control-Allow-Origin' '*';
        add_header 'Access-Control-Allow-Methods' 'GET, POST, OPTIONS';
        add_header 'Access-Control-Allow-Headers' 'DNT,User-Agent,X-Requested-With,If-Modified-Since,Cache-Control,Content-Type,Range';
        add_header 'Access-Control-Max-Age' 1728000;
        add_header 'Content-Type' 'text/plain; charset=utf-8';
        add_header 'Content-Length' 0;
        return 204;
    }
    add_header 'Access-Control-Allow-Origin' '*' always;
    add_header 'Access-Control-Allow-Methods' 'GET, POST, OPTIONS' always;
    add_header 'Access-Control-Allow-Headers' 'DNT,User-Agent,X-Requested-With,If-Modified-Since,Cache-Control,Content-Type,Range' always;
    add_header 'Access-Control-Expose-Headers' 'Content-Length,Content-Range' always;`
        : '';

    if (conf.spa) {
        return `
    location / {
        ${explicitCorsString}
        root ${conf.serveDir};
        index unresolvable-file-html.html;
        try_files $uri @index;
    }
    location @index {
        root ${conf.serveDir};
        add_header Cache-Control no-cache;
        expires 0;
        try_files /index.html =404;
    }`;
    } else {
        return `
    location ${conf.path} {
        ${explicitCorsString}
        root ${conf.serveDir};
    }`;
    }
};

export const getProxyLocation = (conf: ProxyConfigLocation) => {
    const timeoutString = conf.timeout
        ? `
        proxy_connect_timeout       ${conf.timeout};
        proxy_send_timeout          ${conf.timeout};
        proxy_read_timeout          ${conf.timeout};
        send_timeout                ${conf.timeout};`
        : '';

    const websocketSupportString = conf.websocketSupport
        ? `
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";`
        : '';

    const clientBodySizeString = conf.maxClientBodySizeMb ? `client_max_body_size ${conf.maxClientBodySizeMb}M;` : '';

    return `
    location ${conf.path} {
        proxy_pass ${conf.proxyPass};
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Scheme $scheme;
        ${timeoutString}
        ${websocketSupportString}
        ${clientBodySizeString}
    }`;
};

export const getRedirectLocation = (conf: RedirectConfigLocation) => {
    return `
    location ${conf.path} {
        return 302 ${conf.target};
    }`;
};

export const getCustomLocation = (conf: CustomConfigLocation) => {
    return `
    location ${conf.path} {
        ${conf.content}
    }`;
};

export const get301Redirect = (host: string) => {
    return `
    if ($host = ${host}) {
        return 301 https://$host$request_uri;
    }`;
};

export const getServerName = (hostnames: string[]) => {
    return `server_name ${hostnames.join(' ')};`;
};

export const getSslDirectives = (hostname: string) => {
    return `
    ssl_certificate /etc/letsencrypt/live/${hostname}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${hostname}/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;`;
};

export const get80Server = (hostnames: string[]) => {
    return `
server {
    ${hostnames.map((h) => get301Redirect(h)).join('\n')}
    ${getServerName(hostnames)}
    listen 80;
    return 404;
}`;
};

export const get443Server = (hostnames: string[], locations: string[]) => {
    return `
server {
    ${getServerName(hostnames)}
    listen 443 ssl;
    ${getSslDirectives(hostnames[0])}
    ${locations.join('\n')}
}`;
};

export const getUpstreamServerBlock = (group: string, servers: string[]) => {
    return `
upstream ${group} {
    ${servers.map((s) => `server ${s};`).join('\n    ')}
}`;
};

// export const getControlPlaneNginxConfigForProject = async (project: Project, workerAddress: string) => {
//     const conf = project.nginxConfig;
//     if (!conf) {
//         throw new Error(`Invalid project configuration`);
//     }

//     const servers: string[] = [];
//     for (const server of conf.servers) {
//         const hostnames = server.wildcardSubdomain ? [server.domain, `*.${server.domain}`] : [server.domain];
//         const paths: string[] = server.locations.map((loc) => loc.path);
//         const server80 = getWorkerServer(hostnames, paths, workerAddress, false);
//         servers.push(server80);
//         const server443 = getWorkerServer(hostnames, paths, workerAddress, true);
//         servers.push(server443);
//     }

//     return `
// # Generated by the Node Server Manager ${new Date().toISOString()}
// ${servers.join('\n')}
// `;
// };

const getWorkerServer = (hostnames: string[], paths: string[], worker: string, isHttps: boolean) => {
    return `
server {
    ${getServerName(hostnames)}
    listen ${isHttps ? 443 : 80};
    ${paths.map((p) => getWorkerProxyLocation(p, worker, isHttps)).join('\n')}
}`;
};

const getWorkerProxyLocation = (path: string, worker: string, isHttps: boolean) => {
    return `
    location ${path} {
        proxy_pass ${isHttps ? 'https' : 'http'}://${worker};
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Scheme $scheme;
    }`;
};

export const buildNginxConfigForProject = (project: Project) => {
    const conf = project.nginxConfig;
    if (!conf) return '';
    const servers: string[] = [];
    const upstreams: string[] = [];
    for (const server of conf.servers) {
        const hostnames = server.wildcardSubdomain ? [server.domain, `*.${server.domain}`] : [server.domain];
        const server80 = get80Server(hostnames);
        servers.push(server80);
        const locations: string[] = [];
        for (const location of server.locations) {
            switch (location.type) {
                case NginxConfigLocationType.STATIC:
                    locations.push(getStaticLocation(location));
                    break;
                case NginxConfigLocationType.PROXY:
                    {
                        // const upstreamGroup = `${project.id}_${server.index}_${location.index}`;
                        // const serverNames = server.locations.push(getProxyLocation(location));
                        locations.push(getProxyLocation(location));
                    }
                    break;
                case NginxConfigLocationType.REDIRECT:
                    locations.push(getRedirectLocation(location));
                    break;
                case NginxConfigLocationType.CUSTOM:
                    locations.push(getCustomLocation(location));
                    break;
                default:
                    throw new Error(`Unknown location type: ${(location as any).type}`);
            }
        }
        const server443 = get443Server(hostnames, locations);
        servers.push(server443);
    }

    return `
# Generated by the Node Server Manager ${new Date().toISOString()}
${servers.join('\n')}
`;
};
