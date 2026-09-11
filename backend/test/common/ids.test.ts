import { describe, it, expect } from 'vitest';
import { isUUID } from '@mosaiq/nsm-common/ids';

describe('ids.isUUID', () => {
    it('accepts a 32-character token', () => {
        expect(isUUID('a'.repeat(32))).toBe(true);
    });

    it('rejects tokens that are not 32 characters after sanitization', () => {
        expect(isUUID('too-short')).toBe(false);
        expect(isUUID('a'.repeat(31))).toBe(false);
        expect(isUUID('a'.repeat(33))).toBe(false);
    });
});
