// Every error carries a stable `code`, a human/agent readable `message`, and a
// `hint` that tells the caller what to do next. Agents recover from errors far
// more reliably when the next step is spelled out.

export class ApiError extends Error {
  constructor(status, code, message, { hint, param, details } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.hint = hint;
    this.param = param;
    this.details = details;
  }

  toJSON() {
    const e = { code: this.code, message: this.message };
    if (this.param) e.param = this.param;
    if (this.hint) e.hint = this.hint;
    if (this.details) e.details = this.details;
    return { error: e };
  }
}

export const badRequest = (code, message, opts) => new ApiError(400, code, message, opts);
export const notFound = (what, id, hint) =>
  new ApiError(404, `${what}_not_found`, `No ${what} with id '${id}'.`, { hint });
export const unauthorized = (message, hint) => new ApiError(401, 'unauthorized', message, { hint });
export const forbidden = (message, hint) => new ApiError(403, 'forbidden', message, { hint });
export const conflict = (code, message, opts) => new ApiError(409, code, message, opts);
