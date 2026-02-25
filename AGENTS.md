# General rules

- Never commit anything.
- Never read or write any file outside the project folder or the open vscode workspace.
- Never read `.env` file, `secrets.json` file, or any file matching `secrets-*.json`.
- For integration tests in `test/integration` folder, use the test structure as in other integration tests, with AssetContext etc. See several other tests for example, e.g. `12-CoreVault.ts`.
- Use `yarn` package manager.
- Use `yarn test <filename>` for running a single test file.
