import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { resetDb } from '../helpers/db';

vi.mock('@/cluster/node', () => ({ cluster: { propose: vi.fn(), isLeader: () => true } }));
vi.mock('@/controllers/userController', () => ({ signOutAllUsers: vi.fn() }));

import { cluster } from '@/cluster/node';
import { applyOp } from '@/cluster/stateMachine';
import { setAllowedEntities, getAllowedEntities } from '@/controllers/allowedEntityController';
import { signOutAllUsers } from '@/controllers/userController';
import { AllowedEntityType } from '@mosaiq/nsm-common/types';

const propose = cluster.propose as unknown as Mock;
const mockSignOutAll = signOutAllUsers as unknown as Mock;
let idx = 0;

beforeEach(async () => {
    await resetDb();
    idx = 0;
    propose.mockReset().mockImplementation(async (op: any) => applyOp(op, ++idx));
    mockSignOutAll.mockReset();
});

describe('setAllowedEntities', () => {
    it('replaces the allow-list and does not sign everyone out when only adding', async () => {
        await setAllowedEntities([{ id: 'octocat', type: AllowedEntityType.USER, avatarUrl: '' }]);
        expect((await getAllowedEntities()).map((e) => e.id)).toEqual(['octocat']);
        expect(mockSignOutAll).not.toHaveBeenCalled();
    });

    it('signs out all users when an entity is removed', async () => {
        await setAllowedEntities([{ id: 'a', type: AllowedEntityType.USER, avatarUrl: '' }, { id: 'b', type: AllowedEntityType.USER, avatarUrl: '' }]);
        mockSignOutAll.mockClear();
        await setAllowedEntities([{ id: 'a', type: AllowedEntityType.USER, avatarUrl: '' }]);
        expect((await getAllowedEntities()).map((e) => e.id)).toEqual(['a']);
        expect(mockSignOutAll).toHaveBeenCalledTimes(1);
    });
});
