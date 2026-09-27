# Contributing

Changes are welcome through focused pull requests. Please describe the user-visible or security behavior, add negative tests for every changed rejection path, and keep browser, host, and plugin documentation aligned.

Run the local checks before opening a pull request:

```sh
npm ci
npm run verify
```

Never commit TLS private keys, device registries, credentials, or tokens.

The project follows the [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/). Be respectful, keep reports reproducible, and use private vulnerability reporting for security findings.
