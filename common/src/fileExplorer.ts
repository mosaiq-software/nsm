// Pure helpers for the container file explorer. A root id identifies which of a project's
// directories a browse/read targets, without ever exposing an absolute host path. Shared by the
// backend (validation + base-dir resolution) and the frontend (building the root picker).

export type ParsedRoot = { kind: 'volume' } | { kind: 'web'; serverId: string; locationId: string };

// serverId/locationId are UUIDs (no colons), so ':' is a safe separator.
export const serializeRootId = (root: ParsedRoot): string =>
    root.kind === 'volume' ? 'volume' : `web:${root.serverId}:${root.locationId}`;

export const parseRootId = (id: string): ParsedRoot | null => {
    if (id === 'volume') return { kind: 'volume' };
    const m = /^web:([^:]+):([^:]+)$/.exec(id);
    return m ? { kind: 'web', serverId: m[1], locationId: m[2] } : null;
};
