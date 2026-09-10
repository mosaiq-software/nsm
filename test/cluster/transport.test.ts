import { describe, it, expect, afterEach } from 'vitest';
import * as net from 'net';
import { RaftTransport } from '@/cluster/transport';
import { RaftMessage } from '@/cluster/raftTypes';
import { NodeInfo } from '@mosaiq/nsm-common/clusterOps';

let toClose: RaftTransport[] = [];
const track = (t: RaftTransport) => {
    toClose.push(t);
    return t;
};
afterEach(() => {
    toClose.forEach((t) => t.close());
    toClose = [];
});

const port = 21000 + Math.floor(Math.random() * 20000);
const peer = (p: number): NodeInfo => ({ nodeId: 'srv', address: '127.0.0.1', raftPort: p, apiPort: p + 1 });

const voteReq = (reqId: string): RaftMessage => ({ kind: 'RequestVote', reqId, term: 1, candidateId: 'c', lastLogIndex: 0, lastLogTerm: 0 });

describe('RaftTransport', () => {
    it('round-trips a request and response over TCP', async () => {
        const server = track(new RaftTransport(async (msg) => ({ kind: 'RequestVoteResp', reqId: (msg as any).reqId, term: 1, voteGranted: true })));
        await server.listen(port, '127.0.0.1');
        const client = track(new RaftTransport(async () => null));
        const resp = await client.send(peer(port), voteReq('r1'), 1000);
        expect(resp).toMatchObject({ kind: 'RequestVoteResp', reqId: 'r1', voteGranted: true });
    });

    it('resolves null when no server is listening (timeout/refused)', async () => {
        const client = track(new RaftTransport(async () => null));
        const resp = await client.send(peer(port + 5000), voteReq('r2'), 300);
        expect(resp).toBeNull();
    });

    it('ignores a malformed frame and still handles a subsequent valid one', async () => {
        const p = port + 1;
        const server = track(new RaftTransport(async (msg) => ({ kind: 'RequestVoteResp', reqId: (msg as any).reqId, term: 1, voteGranted: true })));
        await server.listen(p, '127.0.0.1');
        const got = await new Promise<any>((resolve) => {
            const sock = net.createConnection({ port: p, host: '127.0.0.1' }, () => {
                sock.setEncoding('utf-8');
                let buf = '';
                sock.on('data', (c) => {
                    buf += c;
                    const i = buf.indexOf('\n');
                    if (i >= 0) resolve(JSON.parse(buf.slice(0, i)));
                });
                sock.write('this-is-not-json\n');
                sock.write(JSON.stringify(voteReq('r3')) + '\n');
            });
        });
        expect(got).toMatchObject({ reqId: 'r3', voteGranted: true });
    });
});
