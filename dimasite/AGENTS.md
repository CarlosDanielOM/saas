
## Project Structure

This workspace contains multiple projects. It is important to distinguish between them:

- **`@dimasite/`** (this directory): The **NEW** site we are actively building. This is Angular v21+ with modern signals, standalone components, and the latest patterns. **All new development happens here.**
- **`@dima-site/`**: The **OLD** legacy site (Angular v17). This is used **ONLY as a reference** for design, layouts, UI patterns, and business logic. Do not modify files in this directory.

When implementing features:
1. Reference `@dima-site/` for design inspiration and UX patterns
2. Build all new code in `@dimasite/` using modern Angular v21+ patterns
3. Port logic from `@dima-site/` to `@dimasite/` with improvements (better security, typing, performance)

---

You are an expert in TypeScript, Angular, and scalable web application development. You write functional, maintainable, performant, and accessible code following Angular and TypeScript best practices.

## TypeScript Best Practices

- Use strict type checking
- Prefer type inference when the type is obvious
- Avoid the `any` type; use `unknown` when type is uncertain

## Angular Best Practices

- Always use standalone components over NgModules
- Must NOT set `standalone: true` inside Angular decorators. It's the default in Angular v20+.
- Use signals for state management
- Implement lazy loading for feature routes
- Do NOT use the `@HostBinding` and `@HostListener` decorators. Put host bindings inside the `host` object of the `@Component` or `@Directive` decorator instead
- Use `NgOptimizedImage` for all static images.
  - `NgOptimizedImage` does not work for inline base64 images.

## Styling Policy

- Use a hybrid CSS approach.
- Put shared and non-trivial styling in `src/styles.css` by default.
- Use `*.component.css` only for tiny, truly component-scoped overrides.
- Do not keep large page-level or reusable styling in a component stylesheet unless there is a strong encapsulation reason.
- If Angular reports `anyComponentStyle` budget warnings, treat that as a signal to move bulky or reusable styles into `src/styles.css`.
- Current frontend build budgets in `angular.json` are `1.5MB` warning / `3MB` error for `initial`, and `50kB` warning / `100kB` error for `anyComponentStyle`.

## Accessibility Requirements

- It MUST pass all AXE checks.
- It MUST follow all WCAG AA minimums, including focus management, color contrast, and ARIA attributes.

### Components

- Keep components small and focused on a single responsibility
- Use `input()` and `output()` functions instead of decorators
- Use `computed()` for derived state
- Set `changeDetection: ChangeDetectionStrategy.OnPush` in `@Component` decorator
- Prefer inline templates for small components
- Prefer Reactive forms instead of Template-driven ones
- Do NOT use `ngClass`, use `class` bindings instead
- Do NOT use `ngStyle`, use `style` bindings instead
- When using external templates/styles, use paths relative to the component TS file.

## State Management

- Use signals for local component state
- Use `computed()` for derived state
- Keep state transformations pure and predictable
- Do NOT use `mutate` on signals, use `update` or `set` instead

## Templates

- Keep templates simple and avoid complex logic
- Use native control flow (`@if`, `@for`, `@switch`) instead of `*ngIf`, `*ngFor`, `*ngSwitch`
- Use the async pipe to handle observables
- Do not assume globals like (`new Date()`) are available.
- Do not write arrow functions in templates (they are not supported).

## Services

- Design services around a single responsibility
- Use the `providedIn: 'root'` option for singleton services
- Use the `inject()` function instead of constructor injection
