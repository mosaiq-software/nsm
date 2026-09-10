export interface DockerCompose {
    services: {
        [serviceName: string]: DockerComposeService;
    };
}
export interface DockerComposeService {
    build: string | DockerComposeServiceBuild | undefined;
    cpu_count: number | undefined;
    cpu_percent: number | undefined;
    cpu_shares: number | undefined;
    cpu_period: number | undefined;
    cpu_quota: number | undefined;
    cpu_rt_runtime: number | undefined;
    cpu_rt_period: number | undefined;
    cpus: number | undefined;
    cpuset: string | undefined;
    container_name: string | undefined;
    depends_on: string[] | undefined;
    deploy: DockerComposeServiceDeploy | undefined;
    env_file: string | undefined;
    environment: { [key: string]: string } | string[] | undefined;
    expose: string[] | undefined;
    extends: DockerComposeServiceExtend | undefined;
    healthcheck: DockerComposeServiceHealthCheck | undefined;
    image: string | undefined;
    labels: { [key: string]: string } | string[] | undefined;
    logging: DockerComposeServiceLogging | undefined;
    mem_limit: string | undefined;
    mem_reservation: string | undefined;
    mem_swappiness: number | undefined;
    memswap_limit: string | undefined;
    ports: string[] | undefined | DockerComposeServicePort[];
    post_start: DockerComposeServiceLifecycleHook[] | undefined;
    pre_stop: DockerComposeServiceLifecycleHook[] | undefined;
    privileged: boolean | undefined;
    read_only: boolean | undefined;
    restart: 'no' | 'always' | 'on-failure' | `on-failure:${number}` | 'unless-stopped' | undefined;
    scale: number | undefined;
    stop_signal: string | undefined;
    user: string | undefined;
    volumes: `${string}:${string}` | `${string}:${string}:${'ro' | 'rw' | 'z' | 'Z'}` | DockerComposeServiceVolume[] | undefined;
}
export interface DockerComposeServiceBuild {
    context: string;
    dockerfile: string;
    args: {
        [key: string]: string;
    };
}
export interface DockerComposeServiceDeploy {
    endpoint_mode: 'vip' | 'dnsrr' | undefined;
    mode: 'global' | 'replicated' | 'replicated-job' | 'global-job' | undefined;
    replicas: number | undefined;
}
export interface DockerComposeServiceExtend {
    service: string;
    file: string;
}
export interface DockerComposeServiceHealthCheck {
    test: string[] | string;
    interval?: string;
    timeout?: string;
    retries?: number;
    start_period?: string;
    start_interval?: string;
    disable?: boolean;
}
export interface DockerComposeServiceLogging {
    driver: string;
    options: { [key: string]: string };
}
export interface DockerComposeServicePort {
    name: string | undefined;
    target: number | undefined;
    host_ip: string | undefined;
    published: string | undefined;
    protocol: 'tcp' | 'udp' | undefined;
    mode: 'host' | 'ingress' | undefined;
}
export interface DockerComposeServiceLifecycleHook {
    command: string | string[];
    user?: string;
    privileged?: boolean;
    working_dir?: string;
    environment?: { [key: string]: string } | string[];
}
export interface DockerComposeServiceVolume {
    type: 'volume' | 'bind' | 'tmpfs' | 'image' | 'npipe' | 'cluster';
    source: string;
    target: string;
    read_only?: boolean;
    bind?: {
        propagation: string;
        create_host_path: boolean;
        selinux: 'z' | 'Z' | undefined;
    };
    volume?: {
        nocopy: boolean;
        driver: string;
    };
    tmpfs?: {
        size: number | string;
        mode: string;
    };
    image?: {
        subpath: string;
    };
    consistency?: string;
}
