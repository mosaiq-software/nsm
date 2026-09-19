import { DeploymentState } from '@mosaiq/nsm-common/types';

// Bridges the leader's serial deploy queue to the node-reported terminal state of a deploy. The
// queue proposes a deployment and then blocks on waitForDeployCompletion until the owning node
// reports the instance DEPLOYED (or FAILED/CANCELLED after its stack is torn down). updateDeploymentLog
// calls notifyDeployTerminal on the first terminal transition. Kept in its own module so both
// deployQueue and deployController can import it without a cycle.

interface Waiter {
    resolve: (state: DeploymentState) => void;
    timer: NodeJS.Timeout;
}

const waiters = new Map<string, Waiter>();

// Block until the given instance reaches a terminal state, or until timeoutMs elapses. On timeout it
// resolves with FAILED so a node that never reports back cannot stall the queue forever. Register
// this before triggering the deploy so an early terminal transition (e.g. a planning failure) is not
// missed.
export const waitForDeployCompletion = (instanceId: string, timeoutMs: number): Promise<DeploymentState> => {
    return new Promise<DeploymentState>((resolve) => {
        const existing = waiters.get(instanceId);
        if (existing) {
            clearTimeout(existing.timer);
            waiters.delete(instanceId);
            existing.resolve(DeploymentState.CANCELLED);
        }
        const timer = setTimeout(() => {
            waiters.delete(instanceId);
            resolve(DeploymentState.FAILED);
        }, timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
        waiters.set(instanceId, { resolve, timer });
    });
};

// Resolve the pending waiter (if any) for an instance that just transitioned into a terminal state.
export const notifyDeployTerminal = (instanceId: string, state: DeploymentState): void => {
    const waiter = waiters.get(instanceId);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    waiters.delete(instanceId);
    waiter.resolve(state);
};
