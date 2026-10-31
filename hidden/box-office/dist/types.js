// Shared types for the Box Office API. All times are stored as epoch milliseconds
// internally and rendered with new Date(ms).toISOString() in responses.
/** Throw this from anywhere; the HTTP layer renders { error: message } with the status. */
export class HttpError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
        this.name = "HttpError";
    }
}
export const MAX_TICKETS_PER_EVENT = 6;
