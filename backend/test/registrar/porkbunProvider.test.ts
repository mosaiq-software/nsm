import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';

vi.mock('@/utils/porkbun', () => ({
    ping: vi.fn(),
    listAllDomains: vi.fn(),
    retrieveRecords: vi.fn(),
    createRecord: vi.fn(async () => ({ id: '123' })),
    editRecord: vi.fn(async () => undefined),
    deleteRecord: vi.fn(async () => undefined),
}));

import { RegistrarAccountRecord } from '@mosaiq/nsm-common/clusterOps';
import { RegistrarProvider } from '@mosaiq/nsm-common/types';
import { createRecord as pbCreateRecord, editRecord as pbEditRecord, listAllDomains as pbListAllDomains, retrieveRecords as pbRetrieveRecords } from '@/utils/porkbun';
import { getDnsProvider } from '@/registrar/provider';
import { addDynamicTag, setPortTag } from '@/utils/dnsTags';

const mockCreate = pbCreateRecord as unknown as Mock;
const mockEdit = pbEditRecord as unknown as Mock;
const mockList = pbListAllDomains as unknown as Mock;
const mockRetrieve = pbRetrieveRecords as unknown as Mock;

const account: RegistrarAccountRecord = {
    id: 'porkbun:acme',
    provider: RegistrarProvider.PORKBUN,
    credentials: { apiKey: 'pk1', secretApiKey: 'sk1' },
    createdAt: 0,
};

const zone = { id: 'example.com', name: 'example.com' };

beforeEach(() => {
    vi.clearAllMocks();
});

describe('porkbun adapter: FQDN <-> subdomain', () => {
    it('converts apex, subdomain and wildcard FQDNs to Porkbun subdomain form on create', async () => {
        const p = getDnsProvider(account);
        await p.createRecord(zone, { type: 'A', name: 'example.com', content: '1.2.3.4' });
        await p.createRecord(zone, { type: 'A', name: 'www.example.com', content: '1.2.3.4' });
        await p.createRecord(zone, { type: 'A', name: '*.example.com', content: '1.2.3.4' });

        expect(mockCreate.mock.calls[0][2]).toMatchObject({ name: '' });
        expect(mockCreate.mock.calls[1][2]).toMatchObject({ name: 'www' });
        expect(mockCreate.mock.calls[2][2]).toMatchObject({ name: '*' });
    });

    it('reads records back with their full host name', async () => {
        mockRetrieve.mockResolvedValue([{ id: '1', name: 'www.example.com', type: 'A', content: '1.2.3.4', ttl: '600' }]);
        const p = getDnsProvider(account);
        const recs = await p.listRecords(zone);
        expect(recs[0].name).toBe('www.example.com');
    });
});

describe('porkbun adapter: SRV data <-> content/prio', () => {
    it('writes SRV data as prio + "weight port target" content on create', async () => {
        const p = getDnsProvider(account);
        await p.createRecord(zone, {
            type: 'SRV',
            name: '_sip._tcp.example.com',
            data: { priority: 10, weight: 20, port: 5060, target: 'sip.example.com' },
        });
        expect(mockCreate.mock.calls[0][2]).toMatchObject({ type: 'SRV', name: '_sip._tcp', content: '20 5060 sip.example.com', prio: 10 });
    });

    it('reads SRV back into a structured data object', async () => {
        mockRetrieve.mockResolvedValue([
            { id: '2', name: '_sip._tcp.example.com', type: 'SRV', content: '20 5060 sip.example.com', ttl: '600', prio: '10' },
        ]);
        const p = getDnsProvider(account);
        const recs = await p.listRecords(zone);
        expect(recs[0].data).toEqual({ priority: 10, weight: 20, port: 5060, target: 'sip.example.com' });
        expect(recs[0].priority).toBe(10);
    });
});

describe('porkbun adapter: notes <-> comment tag round trip', () => {
    it('surfaces the dynamic + port tags stored in Porkbun notes', async () => {
        const notes = setPortTag(addDynamicTag(''), 'res-7');
        mockRetrieve.mockResolvedValue([{ id: '3', name: 'example.com', type: 'A', content: '1.2.3.4', ttl: '600', notes }]);
        const p = getDnsProvider(account);
        const recs = await p.listRecords(zone);
        expect(recs[0].comment).toBe(notes);
        expect(recs[0].dynamic).toBe(true);
        expect(recs[0].portReservationId).toBe('res-7');
    });

    it('maps the neutral comment onto Porkbun notes on write', async () => {
        const p = getDnsProvider(account);
        const comment = addDynamicTag('');
        await p.updateRecord(zone, '9', { content: '5.6.7.8', comment });
        expect(mockEdit.mock.calls[0][3]).toMatchObject({ content: '5.6.7.8', notes: comment });
    });
});

describe('porkbun adapter: partial update', () => {
    it('sends only the fields provided (dynamic-IP watcher sends just content)', async () => {
        const p = getDnsProvider(account);
        await p.updateRecord(zone, '4', { content: '9.9.9.9' });
        expect(mockEdit.mock.calls[0][3]).toEqual({ content: '9.9.9.9' });
    });
});

describe('porkbun adapter: capabilities', () => {
    it('returns no analytics', async () => {
        const p = getDnsProvider(account);
        await expect(p.getAnalytics('example.com', '2024-01-01', '2024-01-02')).resolves.toEqual([]);
    });

    it('refuses to delete a zone', async () => {
        const p = getDnsProvider(account);
        await expect(p.deleteZone(zone)).rejects.toThrow(/cannot be deleted/i);
    });

    it('maps domains to zones and registrar domain metadata', async () => {
        mockList.mockResolvedValue([{ domain: 'example.com', status: 'ACTIVE', expireDate: '2030-01-01', autoRenew: '1' }]);
        const p = getDnsProvider(account);
        expect(await p.listZones()).toEqual([{ id: 'example.com', name: 'example.com', status: 'active', paused: false }]);
        expect(await p.listRegistrarDomains()).toEqual([{ name: 'example.com', expiresAt: '2030-01-01', autoRenew: true, status: 'ACTIVE' }]);
    });

    it('reports configured only when both keys are present', () => {
        expect(getDnsProvider(account).hasRemoteConfig()).toBe(true);
        const partial: RegistrarAccountRecord = { ...account, credentials: { apiKey: 'pk1' } };
        expect(getDnsProvider(partial).hasRemoteConfig()).toBe(false);
    });

    it('builds a Porkbun DNS dashboard url', () => {
        expect(getDnsProvider(account).dashboardUrl('example.com')).toBe('https://porkbun.com/account/dns/example.com');
    });
});
