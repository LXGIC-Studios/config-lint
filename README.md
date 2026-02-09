# @lxgicstudios/config-lint

[![npm version](https://img.shields.io/npm/v/@lxgicstudios/config-lint)](https://www.npmjs.com/package/@lxgicstudios/config-lint)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-blue)](https://www.npmjs.com/package/@lxgicstudios/config-lint)

Validate your config files in one shot. Supports JSON, YAML, TOML, and ENV files. Auto-detects format from file extension, catches syntax errors, flags duplicate keys, and can auto-fix formatting. Zero dependencies.

## Install

```bash
# Run directly with npx
npx @lxgicstudios/config-lint config.json .env

# Or install globally
npm install -g @lxgicstudios/config-lint
```

## Usage

```bash
# Validate a single file
config-lint tsconfig.json

# Multiple files at once
config-lint config.json .env settings.yaml

# Glob patterns for batch validation
config-lint "**/*.json" "**/*.yaml"

# Strict mode catches more issues
config-lint config.json --strict

# Auto-fix formatting
config-lint config.json --fix

# JSON output for CI pipelines
config-lint "**/*.json" --json
```

## Features

- **Auto-detection** - Picks the right validator based on file extension
- **JSON** - Syntax validation, duplicate key detection, trailing comma warnings
- **YAML** - Tab detection, indentation checks, duplicate keys, ambiguous booleans
- **TOML** - Section validation, key-value syntax, duplicate sections
- **ENV** - Format checking, key naming conventions, duplicate key warnings
- **Batch mode** - Validate many files at once with glob patterns
- **Strict mode** - Extra checks for best practices and conventions
- **Auto-fix** - Format JSON and clean up ENV files automatically
- **Zero dependencies** - Just Node.js builtins. Fast and lightweight.

## Options

| Option | Description |
|--------|-------------|
| `--strict` | Enable strict mode with additional best-practice checks |
| `--fix` | Auto-format valid files (JSON pretty-print, ENV cleanup) |
| `--json` | Output results as JSON for CI/CD integration |
| `--help` | Show help message |
| `--version` | Show version number |

## What Gets Checked

| Format | Checks |
|--------|--------|
| JSON | Syntax errors, duplicate keys, trailing commas |
| YAML | Tab indentation, inconsistent spacing, duplicate keys, ambiguous booleans |
| TOML | Duplicate sections, key-value syntax, unquoted strings |
| ENV | Missing `=`, invalid key names, duplicate keys, spacing, uppercase convention |

## CI/CD Integration

```bash
# Fails with exit code 1 if any file has errors
config-lint "**/*.json" "**/*.yaml" .env || exit 1

# Parse JSON output in scripts
config-lint --json "**/*.json" | jq '.summary.errors'
```

## License

MIT - [LXGIC Studios](https://lxgicstudios.com)
