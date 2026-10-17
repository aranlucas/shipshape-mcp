interface TokenFailureResponse {
  headers: Record<string, string>;
}

export class InstallationTokenRequestError extends Error {
  readonly response: TokenFailureResponse;

  constructor(
    public readonly status: number,
    headers = new Headers(),
  ) {
    super(`GitHub installation token request failed: ${status}`);
    this.name = "InstallationTokenRequestError";
    this.response = { headers: Object.fromEntries(headers) };
  }
}
