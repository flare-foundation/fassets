import { reportError } from "../helpers";
import { EventScope, ExitScope } from "./ScopedEvents";

export type RunnerThreadBody = (scope: EventScope) => Promise<void>;

export class ScopedRunner {
    logError: (e: unknown) => void = reportError;

    scopes = new Set<EventScope>();

    lastThreadId = 0;
    runningThreads = new Map<number, RunnerThreadBody>();

    uncaughtErrors: unknown[] = [];

    get runningThreadCount() {
        return this.runningThreads.size;
    }

    newScope(parentScope?: EventScope) {
        const scope = new EventScope(parentScope);
        this.scopes.add(scope);
        return scope;
    }

    finishScope(scope: EventScope) {
        scope.finish();
        this.scopes.delete(scope);
    }

    startThread(method: RunnerThreadBody): number {
        const scope = this.newScope();
        const threadId = ++this.lastThreadId;
        this.runningThreads.set(threadId, method);
        void method(scope)
            .catch((e: unknown) => {
                if (e instanceof ExitScope) {
                    if (e.scope == null || e.scope === scope) return;
                }
                this.logError(e);
                this.uncaughtErrors.push(e);
            })
            .finally(() => {
                this.runningThreads.delete(threadId)
                return this.finishScope(scope);
            });
        return threadId;
    }

    async startScope(method: RunnerThreadBody): Promise<void> {
        return this.startScopeIn(undefined, method);
    }

    async startScopeIn(parentScope: EventScope | undefined, method: RunnerThreadBody): Promise<void> {
        const scope = this.newScope(parentScope);
        try {
            await method(scope);
        } finally {
            this.finishScope(scope);
        }
    }
}
