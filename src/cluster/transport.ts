import * as net from 'net';
import { NodeInfo } from '@mosaiq/nsm-common/clusterOps';
import { RaftMessage } from './raftTypes';

// Newline-delimited JSON transport over TCP between raft peers.
export class RaftTransport {
    private server?: net.Server;
    private handler: (msg: RaftMessage) => Promise<RaftMessage | null>;
    private clients = new Map<string, net.Socket>();

    constructor(handler: (msg: RaftMessage) => Promise<RaftMessage | null>) {
        this.handler = handler;
    }

    listen(port: number, host: string): Promise<void> {
        return new Promise((resolve, reject) => {
            this.server = net.createServer((socket) => this.onConnection(socket));
            this.server.on('error', reject);
            this.server.listen(port, host, () => resolve());
        });
    }

    private onConnection(socket: net.Socket) {
        let buffer = '';
        socket.setEncoding('utf-8');
        socket.on('data', async (chunk: string) => {
            buffer += chunk;
            let idx: number;
            while ((idx = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, idx);
                buffer = buffer.slice(idx + 1);
                if (!line.trim()) continue;
                try {
                    const msg = JSON.parse(line) as RaftMessage;
                    const resp = await this.handler(msg);
                    if (resp) socket.write(JSON.stringify(resp) + '\n');
                } catch (e) {
                    // ignore malformed frame
                }
            }
        });
        socket.on('error', () => socket.destroy());
    }

    // Fire-and-forget style RPC: sends a message to a peer and resolves with the single
    // response frame (or null on timeout/error). One short-lived connection per peer, reused.
    async send(peer: NodeInfo, msg: RaftMessage, timeoutMs = 1000): Promise<RaftMessage | null> {
        return new Promise((resolve) => {
            const key = peer.nodeId;
            let socket = this.clients.get(key);
            let settled = false;
            const done = (r: RaftMessage | null) => {
                if (settled) return;
                settled = true;
                resolve(r);
            };

            const attach = (s: net.Socket) => {
                let buffer = '';
                const onData = (chunk: string) => {
                    buffer += chunk;
                    const idx = buffer.indexOf('\n');
                    if (idx >= 0) {
                        const line = buffer.slice(0, idx);
                        s.off('data', onData);
                        try {
                            done(JSON.parse(line) as RaftMessage);
                        } catch {
                            done(null);
                        }
                    }
                };
                s.setEncoding('utf-8');
                s.on('data', onData);
            };

            const write = (s: net.Socket) => {
                try {
                    s.write(JSON.stringify(msg) + '\n');
                } catch {
                    this.clients.delete(key);
                    done(null);
                }
            };

            if (socket && !socket.destroyed) {
                attach(socket);
                write(socket);
            } else {
                socket = net.createConnection({ port: peer.raftPort, host: peer.address }, () => {
                    attach(socket!);
                    write(socket!);
                });
                socket.on('error', () => {
                    this.clients.delete(key);
                    done(null);
                });
                socket.on('close', () => this.clients.delete(key));
                this.clients.set(key, socket);
            }

            setTimeout(() => done(null), timeoutMs);
        });
    }

    close() {
        this.server?.close();
        for (const s of this.clients.values()) s.destroy();
        this.clients.clear();
    }
}
