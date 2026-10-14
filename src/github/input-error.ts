export class GitHubInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubInputError";
  }
}
