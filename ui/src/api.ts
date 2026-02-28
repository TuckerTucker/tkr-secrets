/**
 * Typed fetch wrapper for the tkr-secrets API.
 *
 * All API responses follow the `{ success, data?, error? }` envelope.
 * On `!success`, throws an `ApiError` with the server-provided message.
 *
 * @module api
 */

/**
 * Standard API response envelope returned by the server.
 */
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * Error thrown when the API returns `success: false`.
 */
export class ApiError extends Error {
  /** HTTP status code from the response, if available. */
  status: number;

  constructor(message: string, status: number = 0) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/**
 * Makes a typed request to the tkr-secrets API.
 *
 * @typeParam T - The expected shape of the `data` field on success.
 * @param method - HTTP method (GET, POST, PUT, DELETE, etc.).
 * @param path - API path relative to origin (e.g. `/api/vaults`).
 * @param body - Optional request body, serialized as JSON.
 * @returns The `data` field from the API response.
 * @throws {ApiError} When the server returns `success: false`.
 * @throws {Error} When the network request or JSON parsing fails.
 */
export async function api<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${window.location.origin}${path}`;

  const headers: Record<string, string> = {
    Accept: "application/json",
  };

  const init: RequestInit = { method, headers };

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  const response = await fetch(url, init);
  const json: ApiResponse<T> = await response.json();

  if (!json.success) {
    throw new ApiError(
      json.error ?? `Request failed: ${method} ${path}`,
      response.status,
    );
  }

  return json.data as T;
}
