export class HttpError extends Error {
    status;
    code;
    body;
    constructor(status, message, code = 'upstream_error', body) {
        super(message);
        this.status = status;
        this.code = code;
        this.body = body;
    }
}
/** Simple serial rate limiter: at most one request per `intervalMs`. */
export class RateLimiter {
    intervalMs;
    last = 0;
    chain = Promise.resolve();
    constructor(intervalMs) {
        this.intervalMs = intervalMs;
    }
    schedule(fn) {
        const run = this.chain.then(async () => {
            const wait = this.last + this.intervalMs - Date.now();
            if (wait > 0)
                await new Promise((r) => setTimeout(r, wait));
            this.last = Date.now();
        });
        this.chain = run.catch(() => { });
        return run.then(fn);
    }
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
