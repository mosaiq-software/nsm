// Direct host command execution. Runs on the host via systemd (no container, no named pipe).
// Replaces server-manager/backend/src/utils/execUtils.ts and server-manager-worker/src/execUtils.ts
// (the old NSM_PIPE_PATH + nsmExecHandle.mjs + .out.working polling mechanism is deleted entirely).
import * as util from 'util';
import * as os from 'os';
import * as child_process from 'child_process';

const execAsync = util.promisify(child_process.exec);

// Best current LAN IP for this host. Prefer the source address of the route to the default
// gateway; fall back to the first non-internal IPv4 interface.
export const getPrimaryIp = async (): Promise<string> => {
    const { out, code } = await execSafe('ip route get 1.1.1.1', 3000);
    if (code === 0) {
        const m = out.match(/\bsrc\s+(\d+\.\d+\.\d+\.\d+)/);
        if (m) return m[1];
    }
    for (const list of Object.values(os.networkInterfaces())) {
        for (const ni of list || []) if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
    return '127.0.0.1';
};

export const execSafe = async (command: string, timeoutMs?: number, env?: NodeJS.ProcessEnv): Promise<{ out: string; code: number }> => {
    let out = '';
    let code = 0;
    try {
        const co = await execAsync(command, { timeout: timeoutMs, maxBuffer: 1024 * 1024 * 64, env });
        out += `${co.stdout}\n${co.stderr}\n`;
    } catch (error: any) {
        code = error.code ?? 1;
        out += `${error.stdout ?? ''}\n${error.stderr ?? ''}\n${error.message ?? ''}`;
    }
    return { out, code };
};

// Streams stdout/stderr to onData as it arrives; enforces a hard timeout via child.kill(). The
// optional onSpawn hook hands the caller the spawned child so it can be killed early (e.g. to cancel
// an in-flight deployment before its timeout elapses).
export const execStream = async (
    command: string,
    timeoutMs: number,
    onData?: (data: string) => void,
    env?: NodeJS.ProcessEnv,
    onSpawn?: (child: child_process.ChildProcess) => void
): Promise<{ out: string; code: number }> => {
    return new Promise((resolve) => {
        let out = '';
        const child = child_process.spawn(command, { shell: true, stdio: ['ignore', 'pipe', 'pipe'], env });
        if (onSpawn) {
            try {
                onSpawn(child);
            } catch {
                /* ignore consumer errors */
            }
        }

        const timer = setTimeout(() => {
            try {
                child.kill('SIGKILL');
            } catch {
                /* ignore */
            }
        }, timeoutMs);

        const handle = (buf: Buffer) => {
            const text = buf.toString();
            out += text;
            if (onData) {
                try {
                    onData(text);
                } catch {
                    /* ignore consumer errors */
                }
            }
        };

        child.stdout.on('data', handle);
        child.stderr.on('data', handle);

        child.on('error', (err) => {
            clearTimeout(timer);
            out += `\n${err.message}`;
            resolve({ out, code: 1 });
        });

        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ out, code: code ?? 0 });
        });
    });
};
