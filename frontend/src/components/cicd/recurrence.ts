// Helpers backing the human-readable schedule builder used for the SCHEDULE continuous-deployment
// trigger. The builder only ever produces standard 5-field cron expressions that node-cron accepts on
// the backend, and it exposes just the cadences a user can reason about: minute intervals, hourly,
// daily, weekly, and monthly. Cron syntax is never shown to the user.

export type RecurrenceFrequency = 'minutes' | 'hourly' | 'daily' | 'weekly' | 'monthly';

export interface RecurrenceState {
    frequency: RecurrenceFrequency;
    // Interval in minutes for the 'minutes' frequency (1-59).
    everyN: number;
    // Minute of the hour (0-59) for hourly/daily/weekly/monthly.
    minute: number;
    // Hour of the day, UTC (0-23) for daily/weekly/monthly.
    hour: number;
    // Days of the week (0=Sunday .. 6=Saturday) for the weekly frequency.
    weekdays: number[];
    // Day of the month (1-31) for the monthly frequency.
    dayOfMonth: number;
}

export const DEFAULT_RECURRENCE: RecurrenceState = {
    frequency: 'daily',
    everyN: 15,
    minute: 0,
    hour: 0,
    weekdays: [1],
    dayOfMonth: 1,
};

export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, Math.round(value)));

const pad = (value: number): string => value.toString().padStart(2, '0');

// Translate the builder state into a standard 5-field cron expression (minute hour day-of-month month
// day-of-week). Always valid for node-cron.
export const buildCron = (state: RecurrenceState): string => {
    const minute = clamp(state.minute, 0, 59);
    const hour = clamp(state.hour, 0, 23);
    switch (state.frequency) {
        case 'minutes':
            return `*/${clamp(state.everyN, 1, 59)} * * * *`;
        case 'hourly':
            return `${minute} * * * *`;
        case 'daily':
            return `${minute} ${hour} * * *`;
        case 'weekly': {
            const days = [...new Set(state.weekdays)].filter((d) => d >= 0 && d <= 6).sort((a, b) => a - b);
            return `${minute} ${hour} * * ${(days.length ? days : [0]).join(',')}`;
        }
        case 'monthly':
            return `${minute} ${hour} ${clamp(state.dayOfMonth, 1, 31)} * *`;
    }
};

const isNumeric = (field: string): boolean => /^\d+$/.test(field);

// Reverse a stored cron expression back into builder state. Returns null when the expression does not
// map onto one of the supported cadences (e.g. a legacy hand-written cron), so callers can fall back
// to a default and inform the user their previous schedule could not be imported.
export const parseCron = (expr: string | undefined): RecurrenceState | null => {
    if (!expr) return null;
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 5) return null;
    const [min, hr, dom, month, dow] = parts;
    // The builder does not model the month field.
    if (month !== '*') return null;

    if (hr === '*' && dom === '*' && dow === '*') {
        const interval = min.match(/^\*\/(\d+)$/);
        if (interval) return { ...DEFAULT_RECURRENCE, frequency: 'minutes', everyN: clamp(Number(interval[1]), 1, 59) };
        if (min === '*') return { ...DEFAULT_RECURRENCE, frequency: 'minutes', everyN: 1 };
        if (isNumeric(min)) return { ...DEFAULT_RECURRENCE, frequency: 'hourly', minute: clamp(Number(min), 0, 59) };
        return null;
    }

    if (!isNumeric(min) || !isNumeric(hr)) return null;
    const minute = clamp(Number(min), 0, 59);
    const hour = clamp(Number(hr), 0, 23);

    if (dom === '*' && dow === '*') return { ...DEFAULT_RECURRENCE, frequency: 'daily', minute, hour };

    if (dom === '*' && dow !== '*') {
        const days = dow.split(',').map((d) => Number(d));
        if (days.some((d) => Number.isNaN(d) || d < 0 || d > 6)) return null;
        return { ...DEFAULT_RECURRENCE, frequency: 'weekly', minute, hour, weekdays: [...new Set(days)].sort((a, b) => a - b) };
    }

    if (isNumeric(dom) && dow === '*') return { ...DEFAULT_RECURRENCE, frequency: 'monthly', minute, hour, dayOfMonth: clamp(Number(dom), 1, 31) };

    return null;
};

const ordinal = (n: number): string => {
    const suffixes = ['th', 'st', 'nd', 'rd'];
    const mod = n % 100;
    return `${n}${suffixes[(mod - 20) % 10] || suffixes[mod] || suffixes[0]}`;
};

// Plain-English description of the schedule, always framed in UTC to match how node-cron evaluates it.
export const describeRecurrence = (state: RecurrenceState): string => {
    const time = `${pad(clamp(state.minute, 0, 59))} past the minute`;
    const clockTime = `${pad(clamp(state.hour, 0, 23))}:${pad(clamp(state.minute, 0, 59))} UTC`;
    switch (state.frequency) {
        case 'minutes':
            return state.everyN <= 1 ? 'Every minute' : `Every ${clamp(state.everyN, 1, 59)} minutes`;
        case 'hourly':
            return state.minute === 0 ? 'Every hour, on the hour (UTC)' : `Every hour at ${time.replace(' past the minute', '')} minutes past (UTC)`;
        case 'daily':
            return `Every day at ${clockTime}`;
        case 'weekly': {
            const days = [...new Set(state.weekdays)].filter((d) => d >= 0 && d <= 6).sort((a, b) => a - b);
            if (!days.length) return `Every week at ${clockTime}`;
            const names = days.map((d) => WEEKDAY_NAMES[d]);
            const joined = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
            return `Every ${joined} at ${clockTime}`;
        }
        case 'monthly':
            return `On the ${ordinal(clamp(state.dayOfMonth, 1, 31))} of every month at ${clockTime}`;
    }
};
