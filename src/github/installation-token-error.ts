export class InstallationTokenRequestError extends Error {
  constructor(public readonly status: number) {
    super(`GitHub installation token request failed: ${status}`);
    this.name = "InstallationTokenRequestError";
  }
}
