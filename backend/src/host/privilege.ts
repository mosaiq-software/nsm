import { spawn } from 'child_process';
import { config } from '@/config';

// In production nsmd runs as the unprivileged `nsm` user; a scoped /etc/sudoers.d/nsm policy lets
// it run exactly a few host commands as root. In dev/test (PRODUCTION != true) the prefix is
// omitted so nothing needs sudo. Kept out of host/exec.ts so exec can be freely mocked in tests.
export const sudo = (command: string): string => (config.production ? `sudo -n ${command}` : command);

// Runs a command and pipes `input` to its stdin. Used for the /etc/hosts writer helper, which
// reads the new hosts contents on stdin.
export const execWithInput = async (command: string, input: string, timeoutMs: number): Promise<{ out: string; code: number }> => {
    return new Promise((resolve) => {
        let out = '';
        const child = spawn(command, { shell: true, stdio: ['pipe', 'pipe', 'pipe'] });

        const timer = setTimeout(() => {
            try {
                child.kill('SIGKILL');
            } catch {
                /* ignore */
            }
        }, timeoutMs);

        const handle = (buf: Buffer) => {
            out += buf.toString();
        };
        child.stdout.on('data', handle);
        child.stderr.on('data', handle);

        child.on('error', (err) => {
            clearTimeout(timer);
            resolve({ out: `${out}\n${err.message}`, code: 1 });
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ out, code: code ?? 0 });
        });

        child.stdin.write(input);
        child.stdin.end();
    });
};
