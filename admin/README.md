# Admin

Internal administration and system observability UI for DomDimaBot. The application uses Angular 21. See [`AGENTS.md`](AGENTS.md) for access-control, UX, and production workflow details.

## Development server

To start a local development server, run:

```bash
ng serve
```

Once the server is running, open your browser and navigate to `http://localhost:4200/`. The application will automatically reload whenever you modify any of the source files.

The development server uses the development configuration by default. Check API and environment targets before exercising actions that write data.

## Code scaffolding

Angular CLI includes powerful code scaffolding tools. To generate a new component, run:

```bash
ng generate component component-name
```

For a complete list of available schematics (such as `components`, `directives`, or `pipes`), run:

```bash
ng generate --help
```

## Building and deployment

Production output is served from a live bind mount on this host. Do not run an in-place production build here. Use the repository helper to build an isolated candidate, verify the changed behavior, and publish that candidate:

```bash
scripts/saas-ops build admin
# Use the generated run ID:
scripts/saas-ops verify admin-<run-id> --check <behavior-script>
scripts/saas-ops deploy admin-<run-id>
scripts/saas-ops cleanup admin-<run-id>
```

See [`../ops/README.md`](../ops/README.md) and [`AGENTS.md`](AGENTS.md#production-verification--deployment) for preview, verification, rollback, and output details.

## Running unit tests

To execute unit tests with the [Vitest](https://vitest.dev/) test runner, use the following command:

```bash
ng test
```

## End-to-end checks

This project does not define an Angular CLI e2e target. Use the behavior checks documented in the repository operations guide for supported release validation.

## Additional Resources

For more information on using the Angular CLI, including detailed command references, visit the [Angular CLI Overview and Command Reference](https://angular.dev/tools/cli) page.
