import { useMemo, useState } from 'react';
import { ActionIcon, Alert, Anchor, Badge, Breadcrumbs, Center, Group, Loader, Paper, Stack, Table, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { MdArrowBack, MdAudiotrack, MdFolder, MdImage, MdInsertDriveFile, MdLink, MdMovie, MdPictureAsPdf } from 'react-icons/md';
import { FileEntry, FileRootInfo } from '@mosaiq/nsm-common/types';
import { FileApiError, useProjectFiles } from '@/hooks/queries/fileHooks';
import { formatBytes } from '@/utils/format';
import { FilePreview } from './FilePreview';

const joinPath = (base: string, name: string): string => (base ? `${base}/${name}` : name);

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg']);
const VIDEO_EXT = new Set(['mp4', 'webm', 'ogv', 'mov', 'mkv']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac']);

const entryIcon = (entry: FileEntry) => {
    if (entry.type === 'dir') return <MdFolder />;
    if (entry.type === 'symlink') return <MdLink />;
    const ext = entry.name.split('.').pop()?.toLowerCase() ?? '';
    if (IMAGE_EXT.has(ext)) return <MdImage />;
    if (VIDEO_EXT.has(ext)) return <MdMovie />;
    if (AUDIO_EXT.has(ext)) return <MdAudiotrack />;
    if (ext === 'pdf') return <MdPictureAsPdf />;
    return <MdInsertDriveFile />;
};

const listErrorMessage = (e: unknown): string => {
    if (e instanceof FileApiError) {
        if (e.status === 403) return 'You do not have access to these files.';
        if (e.status === 404) return 'This directory could not be found.';
        if (e.status === 409) return 'This project is not currently deployed, so there are no container files to browse.';
        if (e.status === 502) return 'The worker node hosting this project is unreachable.';
        return e.message || 'Failed to load files.';
    }
    return 'Failed to load files.';
};

export const FileExplorer = ({ projectId }: { projectId: string }) => {
    // rootId '' => virtual top level (root picker); path '' => top of the selected root.
    const [rootId, setRootId] = useState('');
    const [path, setPath] = useState('');
    const [preview, setPreview] = useState<{ rootId: string; path: string; name: string } | null>(null);

    const { data, isLoading, error, isFetching } = useProjectFiles(projectId, rootId, path);

    const roots: FileRootInfo[] = data?.roots ?? [];
    const notDeployed = data?.workerNodeId === null;
    const rootLabel = useMemo(() => roots.find((r) => r.id === rootId)?.label ?? rootId, [roots, rootId]);
    const segments = path ? path.split('/') : [];

    const openRoot = (id: string) => {
        setRootId(id);
        setPath('');
    };
    const goBack = () => {
        if (path) setPath(segments.slice(0, -1).join('/'));
        else setRootId('');
    };

    const breadcrumbs = (
        <Breadcrumbs>
            <Anchor
                component="button"
                type="button"
                onClick={() => {
                    setRootId('');
                    setPath('');
                }}
            >
                Files
            </Anchor>
            {rootId && (
                <Anchor component="button" type="button" onClick={() => setPath('')}>
                    {rootLabel}
                </Anchor>
            )}
            {segments.map((seg, i) => (
                <Anchor component="button" type="button" key={`${seg}-${i}`} onClick={() => setPath(segments.slice(0, i + 1).join('/'))}>
                    {seg}
                </Anchor>
            ))}
        </Breadcrumbs>
    );

    return (
        <Stack>
            <Group gap="xs" wrap="nowrap">
                <ActionIcon variant="default" onClick={goBack} disabled={!rootId && !path} aria-label="Back">
                    <MdArrowBack />
                </ActionIcon>
                {breadcrumbs}
                {isFetching && <Loader size="xs" />}
            </Group>

            {notDeployed && (
                <Alert color="yellow" variant="light" title="Not deployed">
                    This project has not been deployed yet, so there are no container files to browse. Deploy it to inspect its volume and web directories.
                </Alert>
            )}

            {error && !notDeployed && (
                <Alert color="red" variant="light" title="Could not load files">
                    {listErrorMessage(error)}
                </Alert>
            )}

            {isLoading && (
                <Center h={160}>
                    <Loader />
                </Center>
            )}

            {!isLoading && !notDeployed && !error && (
                <Paper withBorder radius="md">
                    {/* Root picker (virtual top level) */}
                    {!rootId && (
                        <Stack gap={0} p="xs">
                            {roots.map((root) => (
                                <UnstyledButton key={root.id} onClick={() => openRoot(root.id)} p="sm" style={{ borderRadius: 8 }}>
                                    <Group gap="sm">
                                        <MdFolder />
                                        <Text>{root.label}</Text>
                                        <Badge size="xs" variant="light" color="gray">
                                            {root.kind}
                                        </Badge>
                                    </Group>
                                </UnstyledButton>
                            ))}
                            {roots.length === 0 && (
                                <Text c="dimmed" p="sm">
                                    No browsable directories for this project.
                                </Text>
                            )}
                        </Stack>
                    )}

                    {/* Directory listing */}
                    {rootId && data?.listing && (
                        <Stack gap={0}>
                            {data.listing.entries.length === 0 && (
                                <Text c="dimmed" p="md">
                                    This folder is empty.
                                </Text>
                            )}
                            {data.listing.entries.length > 0 && (
                                <Table highlightOnHover>
                                    <Table.Thead>
                                        <Table.Tr>
                                            <Table.Th>Name</Table.Th>
                                            <Table.Th w={120}>Size</Table.Th>
                                            <Table.Th w={200}>Modified</Table.Th>
                                        </Table.Tr>
                                    </Table.Thead>
                                    <Table.Tbody>
                                        {data.listing.entries.map((entry) => {
                                            const isSymlink = entry.type === 'symlink';
                                            const isNavigable = entry.type === 'dir' || entry.type === 'file';
                                            const onClick = () => {
                                                if (entry.type === 'dir') setPath(joinPath(path, entry.name));
                                                else if (entry.type === 'file') setPreview({ rootId, path: joinPath(path, entry.name), name: entry.name });
                                            };
                                            const row = (
                                                <Table.Tr
                                                    key={entry.name}
                                                    onClick={isNavigable ? onClick : undefined}
                                                    style={{ cursor: isNavigable ? 'pointer' : 'default', opacity: isNavigable ? 1 : 0.55 }}
                                                >
                                                    <Table.Td>
                                                        <Group gap="xs" wrap="nowrap">
                                                            {entryIcon(entry)}
                                                            <Text style={{ wordBreak: 'break-all' }}>{entry.name}</Text>
                                                            {isSymlink && (
                                                                <Badge size="xs" variant="light" color="gray">
                                                                    symlink
                                                                </Badge>
                                                            )}
                                                        </Group>
                                                    </Table.Td>
                                                    <Table.Td>{entry.type === 'file' ? formatBytes(entry.size) : ''}</Table.Td>
                                                    <Table.Td>{entry.mtimeMs ? new Date(entry.mtimeMs).toLocaleString() : ''}</Table.Td>
                                                </Table.Tr>
                                            );
                                            return isSymlink ? (
                                                <Tooltip key={entry.name} label="Symlinks are not accessible" withArrow>
                                                    {row}
                                                </Tooltip>
                                            ) : (
                                                row
                                            );
                                        })}
                                    </Table.Tbody>
                                </Table>
                            )}
                            {data.listing.truncated && (
                                <Text c="dimmed" size="sm" p="xs">
                                    Showing the first 2000 entries; this folder has more.
                                </Text>
                            )}
                        </Stack>
                    )}
                </Paper>
            )}

            {preview && <FilePreview projectId={projectId} rootId={preview.rootId} path={preview.path} name={preview.name} onClose={() => setPreview(null)} />}
        </Stack>
    );
};
