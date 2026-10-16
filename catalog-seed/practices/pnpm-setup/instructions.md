Replace every pnpm/action-setup reference with pnpm/setup pinned to a full commit SHA.
Use pnpm v11 or newer. Pin the pnpm version in package.json and configure the runtime
and cache in pnpm/setup. The action installs dependencies by default: require a lockfile
with require-lockfile: true, and avoid a duplicate install. Bun setup actions are allowed.
