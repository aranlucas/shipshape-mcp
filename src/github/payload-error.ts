export class GitHubPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubPayloadError";
  }
}
