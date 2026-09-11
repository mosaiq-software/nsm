import { describe, it, expect } from 'vitest';
import { getGitSshUri, getGitHttpsUri } from '@mosaiq/nsm-common/gitUtils';

describe('gitUtils', () => {
    it('builds an SSH clone URI', () => {
        expect(getGitSshUri('mosaiq', 'nsm')).toBe('git@github.com:mosaiq/nsm.git');
    });

    it('builds an HTTPS clone URI', () => {
        expect(getGitHttpsUri('mosaiq', 'nsm')).toBe('https://github.com/mosaiq/nsm.git');
    });
});
