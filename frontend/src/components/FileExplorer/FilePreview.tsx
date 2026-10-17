import { useEffect, useState } from 'react';
import { Alert, Box, Button, Center, Drawer, Group, Loader, Stack, Text } from '@mantine/core';
import { CodeHighlight, CodeHighlightAdapterProvider, createHighlightJsAdapter } from '@mantine/code-highlight';
import hljs from 'highlight.js/lib/common';
import { MdDownload } from 'react-icons/md';
import { useAPI } from '@/utils/api';
import { fetchProjectFileBlob, FileApiError, useProjectFile } from '@/hooks/queries/fileHooks';
import { formatBytes } from '@/utils/format';
import { logger } from '@/utils/logger';

// highlight.js (common languages) adapter, created once for all previews.
const highlightAdapter = createHighlightJsAdapter(hljs);

interface FilePreviewProps {
    projectId: string;
    rootId: string;
    path: string;
    name: string;
    onClose: () => void;
}

const statusMessage = (e: unknown): string => {
    if (e instanceof FileApiError) {
        if (e.status === 403) return 'You do not have access to this file.';
        if (e.status === 404) return 'File not found. It may have been removed by a redeploy.';
        if (e.status === 409) return 'This project is not currently deployed.';
        if (e.status === 413) return 'This file is too large to open.';
        if (e.status === 502) return 'The worker node is unreachable.';
        return e.message || 'Failed to load file.';
    }
    return 'Failed to load file.';
};

// Fetches raw bytes (authorized) and renders a media element from an object URL. The URL is revoked
// on unmount / change so blobs don't leak.
const MediaPreview = ({ projectId, rootId, path, kind, token }: { projectId: string; rootId: string; path: string; kind: 'image' | 'video' | 'audio'; token: string }) => {
    const [url, setUrl] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let objectUrl: string | null = null;
        let cancelled = false;
        setUrl(null);
        setError(null);
        fetchProjectFileBlob(token, projectId, rootId, path)
            .then((blob) => {
                if (cancelled) return;
                objectUrl = URL.createObjectURL(blob);
                setUrl(objectUrl);
            })
            .catch((e) => {
                if (!cancelled) setError(statusMessage(e));
            });
        return () => {
            cancelled = true;
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
    }, [token, projectId, rootId, path]);

    if (error) return <Alert color="red" title="Could not load media">{error}</Alert>;
    if (!url)
        return (
            <Center h={200}>
                <Loader />
            </Center>
        );
    if (kind === 'image') return <img src={url} alt={path} style={{ maxWidth: '100%', height: 'auto' }} />;
    if (kind === 'video') return <video src={url} controls style={{ maxWidth: '100%' }} />;
    return <audio src={url} controls style={{ width: '100%' }} />;
};

export const FilePreview = (props: FilePreviewProps) => {
    const { projectId, rootId, path, name, onClose } = props;
    const api = useAPI();
    const { data, isLoading, error } = useProjectFile(projectId, rootId, path);
    const [downloading, setDownloading] = useState(false);

    const download = async () => {
        if (!api.token) return;
        setDownloading(true);
        try {
            const blob = await fetchProjectFileBlob(api.token, projectId, rootId, path);
            const objectUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = objectUrl;
            a.download = name;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(objectUrl);
        } catch (e) {
            logger.error('api', 'file download failed', { err: e, projectId, rootId, path });
        } finally {
            setDownloading(false);
        }
    };

    return (
        <Drawer opened position="right" size="xl" onClose={onClose} title={<Text fw={600} style={{ wordBreak: 'break-all' }}>{name}</Text>}>
            <Stack>
                {isLoading && (
                    <Center h={200}>
                        <Loader />
                    </Center>
                )}
                {error && <Alert color="red" title="Could not load file">{statusMessage(error)}</Alert>}
                {data && (
                    <>
                        <Group justify="space-between" wrap="nowrap">
                            <Text size="sm" c="dimmed">
                                {data.fileClass} · {formatBytes(data.size)}
                            </Text>
                            <Button size="xs" variant="light" leftSection={<MdDownload />} loading={downloading} onClick={download}>
                                Download
                            </Button>
                        </Group>

                        {data.fileClass === 'text' && (
                            <Stack gap="xs">
                                {data.truncated && <Alert color="yellow" variant="light">This file is large; only the first part is shown. Download it to see the full contents.</Alert>}
                                <CodeHighlightAdapterProvider adapter={highlightAdapter}>
                                    <CodeHighlight code={data.text ?? ''} language={data.language ?? 'plaintext'} withCopyButton={false} />
                                </CodeHighlightAdapterProvider>
                            </Stack>
                        )}

                        {(data.fileClass === 'image' || data.fileClass === 'video' || data.fileClass === 'audio') && api.token && (
                            <Box>
                                <MediaPreview projectId={projectId} rootId={rootId} path={path} kind={data.fileClass} token={api.token} />
                            </Box>
                        )}

                        {(data.fileClass === 'pdf' || data.fileClass === 'binary') && (
                            <Alert color="gray" variant="light" title="No preview available">
                                This file type can&apos;t be previewed here. Use the Download button above to view it.
                            </Alert>
                        )}
                    </>
                )}
            </Stack>
        </Drawer>
    );
};
