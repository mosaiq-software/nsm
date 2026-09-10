// Direct host command execution. Runs on the host via systemd (no container, no named pipe).
// Replaces server-manager/backend/src/utils/execUtils.ts and server-manager-worker/src/execUtils.ts
// (the old NSM_PIPE_PATH + nsmExecHandle.mjs + .out.working polling mechanism is deleted entirely).
import * as util from 'util';
import * as child_process from 'child_process';

const execAsync = util.promisify(child_process.exec);

export const execSafe = async (command: string, timeoutMs?: number): Promise<{ out: string; code: number }> => {
    let out = '';
    let code = 0;
    try {
        const co = await execAsync(command, { timeout: timeoutMs, maxBuffer: 1024 * 1024 * 64 });
        out += `${co.stdout}\n${co.stderr}\n`;
    } catch (error: any) {
        code = error.code ?? 1;
        out += `${error.stdout ?? ''}\n${error.stderr ?? ''}\n${error.message ?? ''}`;
    }
    return { out, code };
};

// Streams stdout/stderr to onData as it arrives; enforces a hard timeout via child.kill().
export const execStream = async (command: string, timeoutMs: number, onData?: (data: string) => void): Promise<{ out: string; code: number }> => {
    return new Promise((resolve) => {
        let out = '';
        const child = child_process.spawn(command, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });

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
