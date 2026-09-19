import { useEffect, useState } from 'react';

// Returns the current epoch ms, re-rendering on a fixed interval while `enabled` is true so callers
// can show live-ticking elapsed times. When disabled it stops the timer and stops updating.
export const useNow = (enabled: boolean, intervalMs = 1000): number => {
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        if (!enabled) return;
        setNow(Date.now());
        const id = setInterval(() => setNow(Date.now()), intervalMs);
        return () => clearInterval(id);
    }, [enabled, intervalMs]);

    return now;
};
