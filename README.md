# SaaS Workspace

Monorepo containing:
- `dimabot/` - Backend + Twitch bot (Node.js/TypeScript)
- `dimasite/` - Angular frontend application
- `dimadocs/` - Documentation

## Git Configuration

This workspace includes optimized git configurations for development:

### Files

- `.gitignore` - Comprehensive ignore patterns for Node.js, TypeScript, Angular, and build outputs
- `.gitattributes` - Line ending normalization and file type detection
- `.gitconfig-workspace` - Recommended git settings (optional to include)
- `.editorconfig` - Editor-agnostic configuration for consistent formatting

### Applied Local Git Settings

The following git configurations are already applied locally:

- `rebase.autoStash = true` - Automatically stash changes before rebase
- `diff.algorithm = histogram` - Better diff algorithm for complex changes
- `core.fileMode = false` - Ignore file mode changes (cross-platform)
- `core.whitespace = fix,-indent-with-non-tab,trailing-space,cr-at-eol` - Fix common whitespace issues
- `color.ui = true` - Colored git output

### To Apply Additional Workspace Settings

If you want to apply all recommended settings from `.gitconfig-workspace`:

```bash
git config --local include.path ../.gitconfig-workspace
```

### Branch Configuration

Default branch is `master` (currently). To rename to `main`:

```bash
git branch -m master main
git config --local init.defaultBranch main
```

### Setting Up Git Identity

If you haven't set up your git identity globally, configure it locally:

```bash
git config --local user.name "Your Name"
git config --local user.email "your.email@example.com"
```

## Ignored Files

Common patterns ignored across the workspace:

- `node_modules/` - Dependencies
- `dist/`, `build/` - Build outputs
- `.env*` - Environment files
- Logs and cache directories
- IDE-specific files (VSCode settings are preserved)
- OS-specific files (.DS_Store, Thumbs.db)

See `.gitignore` for the complete list.

## Line Endings

All text files use LF (`\n`) line endings enforced by `.gitattributes`.

## Code Style

Editor configuration is provided in `.editorconfig`. Ensure your editor supports it for consistent formatting.

## Project Structure

```
saas/
├── dimabot/         # Main backend + bot (TypeScript)
├── dimasite/         # Main frontend (Angular)
├── dimadocs/         # Documentation
├── olddimabot/       # Reference: Old JS build (Mar 2)
└── olddimasite/       # Reference: Minified JS build (Mar 3)
```

## Initial Commit

After reviewing the configuration, make your initial commit:

```bash
git add .
git commit -m "Initial commit: Set up workspace configuration and reference folders"
```

## Recovery Summary

**Recent data loss recovery:** Due to a catastrophic error, TypeScript source files were lost. Recovered code is now in the `olddimabot` and `olddimasite` reference folders.

**Recovery status:**
- **olddimabot/** - 271 readable JS files (4MB, Mar 2 build) - Full functionality intact
- **olddimasite/** - 2 JS files (minified main.js, styles.css, Mar 3 build) - Minified but usable for reference

**Next steps:**
1. Gradually reconstruct TypeScript code using reference folders
2. Add proper type annotations
3. Rebuild component by component
