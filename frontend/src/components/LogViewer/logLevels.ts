// pino numeric log levels -> display name + Mantine color, used for the level column badge and the
// level facet. Values arrive from Loki as numeric strings (e.g. "30").
export interface LevelInfo {
    name: string;
    color: string;
}

const LEVELS: Record<number, LevelInfo> = {
    10: { name: 'trace', color: 'gray' },
    20: { name: 'debug', color: 'gray' },
    30: { name: 'info', color: 'blue' },
    40: { name: 'warn', color: 'yellow' },
    50: { name: 'error', color: 'red' },
    60: { name: 'fatal', color: 'grape' },
};

// Resolve a (possibly string) pino level to its display name + color. Falls back to the raw value.
export const levelInfo = (lvl: unknown): LevelInfo => {
    const n = Number(lvl);
    if (!Number.isNaN(n) && LEVELS[n]) return LEVELS[n];
    return { name: lvl != null && lvl !== '' ? String(lvl) : 'unknown', color: 'gray' };
};

// A stable-ish CSS color per facet value (for non-level facets), so the same area/action keeps a
// consistent hue. Mantine palette color names.
const PALETTE = ['blue', 'teal', 'grape', 'orange', 'cyan', 'lime', 'pink', 'indigo', 'green', 'violet'];
export const colorForValue = (value: string): string => {
    let h = 0;
    for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) >>> 0;
    return PALETTE[h % PALETTE.length];
};
