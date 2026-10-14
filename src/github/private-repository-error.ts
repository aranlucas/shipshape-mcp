import type { RepositoryCoordinates } from "./schemas";

export class PrivateRepositoryError extends Error {
  constructor(readonly repository: RepositoryCoordinates) {
    super(
      `Private repositories are outside the read-only portfolio scope: ${repository.owner}/${repository.repo}`,
    );
    this.name = "PrivateRepositoryError";
  }
}
