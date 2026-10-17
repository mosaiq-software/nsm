import { DirectoryListing, FileBrowseResult, FileContent, FileRootInfo, NginxConfigLocationType, Project, StaticConfigLocation } from '@mosaiq/nsm-common/types';
import { ParsedRoot, parseRootId } from '@mosaiq/nsm-common/fileExplorer';
import { config } from '@/config';
import { getNodeByIdModel } from '@/persistence/nodePersistence';
import { postToNode } from '@/cluster/leaderClient';
import { FileAccessError, FileErrorCode, listDirectoryLocal, readFileLocal, RawFileStream, openFileStreamLocal } from '@/reconcile/fileAccess';

// Project is not deployed anywhere yet, so it has no worker node to read files from.
export class NotDeployedError extends Error {
    constructor() {
        super('project is not deployed');
        this.name = 'NotDeployedError';
    }
}
// The owning node is unknown to the registry or could not be reached.
export class NodeUnreachableError extends Error {
    constructor() {
        super('worker node unreachable');
        this.name = 'NodeUnreachableError';
    }
}

// Envelope used for the leader -> node JSON RPCs so a FileAccessError keeps its code across the hop
// (postToNode collapses any non-2xx to null, which would otherwise mask a 403/404 as a 502).
export type NodeFileResult<T> = { ok: true; result: T } | { ok: false; code: FileErrorCode };

// The browsable roots for a project: the persistent volume plus one entry per static web location.
export const resolveRoots = (project: Project): FileRootInfo[] => {
    const roots: FileRootInfo[] = [{ id: 'volume', kind: 'volume', label: 'Volume' }];
    for (const server of project.nginxConfig?.servers ?? []) {
        for (const location of server.locations) {
            if (location.type === NginxConfigLocationType.STATIC) {
                const loc = location as StaticConfigLocation;
                const suffix = loc.path && loc.path !== '/' ? ` ${loc.path}` : '';
                roots.push({ id: `web:${server.serverId}:${loc.locationId}`, kind: 'web', label: `Web: ${server.domain}${suffix}` });
            }
        }
    }
    return roots;
};

// Parse a client-supplied root id and verify it belongs to THIS project (reject unknown/foreign
// roots). A web root must match a real static location in the project's nginx config.
export const assertRootBelongsToProject = (project: Project, rootId: string): ParsedRoot => {
    const parsed = parseRootId(rootId);
    if (!parsed) throw new FileAccessError('not_found', 'unknown root');
    if (parsed.kind === 'volume') return parsed;
    const server = project.nginxConfig?.servers?.find((s) => s.serverId === parsed.serverId);
    const location = server?.locations.find((l) => l.locationId === parsed.locationId && l.type === NginxConfigLocationType.STATIC);
    if (!server || !location) throw new FileAccessError('not_found', 'unknown root');
    return parsed;
};

// Run a validated JSON op on the project's owning node: locally when this node owns it, otherwise
// over the cluster-secret RPC. Preserves FileAccessError codes via the result envelope.
const onOwningNode = async <T>(project: Project, localFn: () => Promise<T>, rpcPath: string, rpcBody: Record<string, unknown>): Promise<T> => {
    const nodeId = project.workerNodeId;
    if (!nodeId) throw new NotDeployedError();
    if (nodeId === config.nodeId) return localFn();
    const node = await getNodeByIdModel(nodeId);
    if (!node) throw new NodeUnreachableError();
    const res = await postToNode<NodeFileResult<T>>(node.address, node.apiPort, rpcPath, rpcBody);
    if (!res) throw new NodeUnreachableError();
    if (!res.ok) throw new FileAccessError(res.code);
    return res.result;
};

// Browse: always returns the roots; `listing` is null at the virtual top level (root picker) or
// when no root is requested. Listing a root's contents requires the project to be deployed.
export const browseProjectFiles = async (project: Project, rootId: string | undefined, relPath: string): Promise<FileBrowseResult> => {
    const roots = resolveRoots(project);
    const workerNodeId = project.workerNodeId ?? null;
    if (!rootId) return { projectId: project.id, workerNodeId, roots, listing: null };
    const root = assertRootBelongsToProject(project, rootId);
    const listing = await onOwningNode<DirectoryListing>(project, () => listDirectoryLocal(project.id, root, relPath), '/node/files-list', { projectId: project.id, root: rootId, path: relPath });
    return { projectId: project.id, workerNodeId, roots, listing };
};

export const readProjectFile = async (project: Project, rootId: string, relPath: string): Promise<FileContent> => {
    const root = assertRootBelongsToProject(project, rootId);
    return onOwningNode<FileContent>(project, () => readFileLocal(project.id, root, relPath), '/node/file-read', { projectId: project.id, root: rootId, path: relPath });
};

// Raw bytes for media rendering / downloads. Returns a local stream when this node owns the project,
// or the owning node's URL so the route can proxy-stream it (with Range) without buffering.
export type StreamDispatch = { kind: 'local'; data: RawFileStream } | { kind: 'remote'; url: string };

export const streamProjectFile = async (project: Project, rootId: string, relPath: string, rangeHeader: string | undefined): Promise<StreamDispatch> => {
    const root = assertRootBelongsToProject(project, rootId);
    const nodeId = project.workerNodeId;
    if (!nodeId) throw new NotDeployedError();
    if (nodeId === config.nodeId) {
        return { kind: 'local', data: await openFileStreamLocal(project.id, root, relPath, rangeHeader) };
    }
    const node = await getNodeByIdModel(nodeId);
    if (!node) throw new NodeUnreachableError();
    const query = new URLSearchParams({ projectId: project.id, root: rootId, path: relPath }).toString();
    return { kind: 'remote', url: `http://${node.address}:${node.apiPort}/node/file-raw?${query}` };
};
