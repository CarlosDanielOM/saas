
- Repo state: many project directories are currently untracked by git (`?? dimabot/`, `?? .sisyphus/`). Avoid commits unless explicitly requested.

- `npm -C dimabot run build` originally failed because npm was configured with `omit=dev`; resolved by running `npm -C dimabot install --include=dev`.
