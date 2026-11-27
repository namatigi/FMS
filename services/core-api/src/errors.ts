export class HttpError extends Error {
  constructor(public statusCode: number, public code: string, message: string) {
    super(message);
  }
}
export const notFound = (what = 'resource') => new HttpError(404, 'not_found', `${what} not found`);
export const forbidden = (msg = 'insufficient permissions') => new HttpError(403, 'forbidden', msg);
export const unauthorized = (msg = 'authentication required', code = 'unauthorized') => new HttpError(401, code, msg);
export const badRequest = (msg: string, code = 'bad_request') => new HttpError(400, code, msg);
export const conflict = (msg: string) => new HttpError(409, 'conflict', msg);
export const unprocessable = (msg: string, code = 'unprocessable') => new HttpError(422, code, msg);
