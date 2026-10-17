// Provider-neutral DNS record tag helpers. NSM stores two pieces of per-record state inside the
// record's free-text annotation field (Cloudflare's `comment`, Porkbun's `notes`) so the flag lives
// at the registrar and survives a re-sync, keeping the registrar authoritative for which records NSM
// drives. Both the Cloudflare and Porkbun adapters share these helpers.

// Marker written into a record's annotation to mark it as NSM-managed dynamic-IP.
export const DYNAMIC_TAG = 'nsm-dynamic-ip';

export const hasDynamicTag = (comment?: string | null): boolean => !!comment && comment.includes(DYNAMIC_TAG);
export const addDynamicTag = (comment?: string | null): string => {
    const base = (comment || '').replace(DYNAMIC_TAG, '').trim();
    return base ? `${base} ${DYNAMIC_TAG}` : DYNAMIC_TAG;
};
export const removeDynamicTag = (comment?: string | null): string => (comment || '').replace(DYNAMIC_TAG, '').replace(/\s+/g, ' ').trim();

// Marker binding a record's port (e.g. SRV data.port) to a port reservation. Like DYNAMIC_TAG the
// binding lives in the annotation (`nsm-port:<reservationId>`) so it survives a re-sync and the
// registrar stays authoritative for which records NSM drives.
export const PORT_TAG_PREFIX = 'nsm-port:';
const PORT_TAG_RE = new RegExp(`${PORT_TAG_PREFIX}([A-Za-z0-9_-]+)`);

export const getPortReservationIdFromComment = (comment?: string | null): string | undefined => {
    const m = (comment || '').match(PORT_TAG_RE);
    return m ? m[1] : undefined;
};
export const setPortTag = (comment: string | null | undefined, reservationId: string): string => {
    const base = removePortTag(comment);
    return base ? `${base} ${PORT_TAG_PREFIX}${reservationId}` : `${PORT_TAG_PREFIX}${reservationId}`;
};
export const removePortTag = (comment?: string | null): string => (comment || '').replace(PORT_TAG_RE, '').replace(/\s+/g, ' ').trim();
