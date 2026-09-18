// Shared formatters for metrics and chart axes/tooltips.

// Human-readable byte size, e.g. 1536 -> "1.5 KB". Non-finite or non-positive values render as "0 B".
export function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// Byte throughput, e.g. "1.5 KB/s".
export function formatBytesPerSec(bytes: number): string {
    return `${formatBytes(bytes)}/s`;
}

// CPU cores used, e.g. 0.345 -> "0.35".
export function formatCores(cores: number): string {
    if (!Number.isFinite(cores)) return '0.00';
    return cores.toFixed(2);
}

// A 0..1 fraction as a whole percentage, e.g. 0.35 -> "35%".
export function formatPercent01(fraction: number): string {
    if (!Number.isFinite(fraction)) return '0%';
    return `${(fraction * 100).toFixed(0)}%`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Compact axis tick label for a unix-seconds timestamp. Ranges spanning more than a day include the
// month/day; shorter ranges show time-of-day only, keeping ticks short enough to avoid overlap.
export function formatAxisTime(unixSeconds: number, rangeMs: number): string {
    const date = new Date(unixSeconds * 1000);
    if (rangeMs > DAY_MS) {
        return date.toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    }
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
