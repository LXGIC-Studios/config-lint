#!/usr/bin/env node

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { extname, basename, join, resolve } from "node:path";

// ── ANSI Colors ──
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  bgRed: "\x1b[41m",
  bgGreen: "\x1b[42m",
};

const VERSION = "1.0.0";

// ── Types ──
interface LintResult {
  file: string;
  format: string;
  valid: boolean;
  errors: LintError[];
  warnings: LintWarning[];
  fixed?: boolean;
}

interface LintError {
  line?: number;
  message: string;
  severity: "error";
}

interface LintWarning {
  line?: number;
  message: string;
  severity: "warning";
}

// ── Format Detection ──
function detectFormat(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const name = basename(filePath).toLowerCase();

  if (ext === ".json" || ext === ".jsonc") return "json";
  if (ext === ".yml" || ext === ".yaml") return "yaml";
  if (ext === ".toml") return "toml";
  if (ext === ".env" || name.startsWith(".env")) return "env";
  if (name === ".env" || name.startsWith(".env.")) return "env";

  return "unknown";
}

// ── JSON Validator ──
function validateJSON(content: string, strict: boolean): { errors: LintError[]; warnings: LintWarning[]; fixed?: string } {
  const errors: LintError[] = [];
  const warnings: LintWarning[] = [];
  let fixed: string | undefined;

  try {
    const parsed = JSON.parse(content);
    fixed = JSON.stringify(parsed, null, 2) + "\n";

    if (strict) {
      // Check for trailing commas (won't parse but just in case of JSONC)
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trimEnd();
        if (/,\s*$/.test(trimmed)) {
          const nextNonEmpty = lines.slice(i + 1).find((l) => l.trim().length > 0);
          if (nextNonEmpty && /^\s*[}\]]/.test(nextNonEmpty)) {
            warnings.push({ line: i + 1, message: "Trailing comma before closing bracket", severity: "warning" });
          }
        }
      }

      // Check for duplicate keys (basic check)
      const keyPattern = /"([^"]+)"\s*:/g;
      const keysByLevel: Map<string, number[]> = new Map();
      const contentLines = content.split("\n");
      let match;
      for (let i = 0; i < contentLines.length; i++) {
        while ((match = keyPattern.exec(contentLines[i])) !== null) {
          const key = match[1];
          if (!keysByLevel.has(key)) keysByLevel.set(key, []);
          keysByLevel.get(key)!.push(i + 1);
        }
      }

      // Simple duplicate detection (same key at root level)
      for (const [key, lineNums] of keysByLevel) {
        if (lineNums.length > 1) {
          warnings.push({
            line: lineNums[1],
            message: `Possible duplicate key "${key}" (also on line ${lineNums[0]})`,
            severity: "warning",
          });
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const lineMatch = msg.match(/position (\d+)/);
    let line: number | undefined;
    if (lineMatch) {
      const pos = parseInt(lineMatch[1]);
      line = content.substring(0, pos).split("\n").length;
    }
    errors.push({ line, message: msg, severity: "error" });
  }

  return { errors, warnings, fixed };
}

// ── YAML Validator (basic, no deps) ──
function validateYAML(content: string, strict: boolean): { errors: LintError[]; warnings: LintWarning[] } {
  const errors: LintError[] = [];
  const warnings: LintWarning[] = [];
  const lines = content.split("\n");
  const seenKeys: Map<number, Set<string>> = new Map(); // indent level -> keys

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Skip empty lines and comments
    if (line.trim() === "" || line.trim().startsWith("#")) continue;

    // Check for tabs (YAML doesn't allow tabs for indentation)
    if (line.match(/^\t/)) {
      errors.push({ line: lineNum, message: "Tab character used for indentation (YAML requires spaces)", severity: "error" });
    }

    // Check inconsistent indentation
    const indent = line.match(/^( *)/)?.[1].length || 0;
    if (indent % 2 !== 0 && indent > 0) {
      warnings.push({ line: lineNum, message: `Odd indentation (${indent} spaces). Consider using 2-space increments.`, severity: "warning" });
    }

    // Check for duplicate keys at same level
    if (strict) {
      const keyMatch = line.match(/^(\s*)([^:#\s][^:]*)\s*:/);
      if (keyMatch) {
        const indentLevel = keyMatch[1].length;
        const key = keyMatch[2].trim();

        if (!seenKeys.has(indentLevel)) seenKeys.set(indentLevel, new Set());
        const levelKeys = seenKeys.get(indentLevel)!;

        if (levelKeys.has(key)) {
          warnings.push({ line: lineNum, message: `Duplicate key "${key}" at indentation level ${indentLevel}`, severity: "warning" });
        }
        levelKeys.add(key);

        // Reset deeper levels when we see a key at this level
        for (const [level] of seenKeys) {
          if (level > indentLevel) seenKeys.delete(level);
        }
      }
    }

    // Check for obvious syntax errors
    if (line.includes(": {") && !line.includes("}")) {
      // Flow mapping started but not closed on same line - could be intentional
    }

    // Check for unquoted special values in strict mode
    if (strict) {
      const valueMatch = line.match(/:\s+(.+)$/);
      if (valueMatch) {
        const value = valueMatch[1].trim();
        if (["yes", "no", "on", "off", "true", "false"].includes(value.toLowerCase()) && value !== value.toLowerCase()) {
          warnings.push({
            line: lineNum,
            message: `Ambiguous boolean value "${value}". Consider quoting it.`,
            severity: "warning",
          });
        }
      }
    }
  }

  return { errors, warnings };
}

// ── TOML Validator (basic, no deps) ──
function validateTOML(content: string, _strict: boolean): { errors: LintError[]; warnings: LintWarning[] } {
  const errors: LintError[] = [];
  const warnings: LintWarning[] = [];
  const lines = content.split("\n");
  const seenSections = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const lineNum = i + 1;

    if (line === "" || line.startsWith("#")) continue;

    // Section headers
    const sectionMatch = line.match(/^\[{1,2}([^\]]+)\]{1,2}$/);
    if (sectionMatch) {
      const section = sectionMatch[1].trim();
      if (seenSections.has(section) && !line.startsWith("[[")) {
        errors.push({ line: lineNum, message: `Duplicate section [${section}]`, severity: "error" });
      }
      seenSections.add(section);
      continue;
    }

    // Key-value pairs
    const kvMatch = line.match(/^([^=]+)=(.*)$/);
    if (kvMatch) {
      const key = kvMatch[1].trim();
      const value = kvMatch[2].trim();

      // Check for unquoted strings that aren't valid TOML values
      if (value && !value.startsWith('"') && !value.startsWith("'") && !value.startsWith("[") && !value.startsWith("{")) {
        if (!/^(true|false|\d+(\.\d+)?([eE][+-]?\d+)?|\d{4}-\d{2}-\d{2}.*)$/.test(value)) {
          warnings.push({ line: lineNum, message: `Value for "${key}" might need quoting: ${value}`, severity: "warning" });
        }
      }

      // Check for empty key
      if (!key) {
        errors.push({ line: lineNum, message: "Empty key name", severity: "error" });
      }

      continue;
    }

    // If it doesn't match section or kv, might be an error
    if (!line.startsWith("#")) {
      errors.push({ line: lineNum, message: `Unrecognized syntax: "${line.substring(0, 50)}"`, severity: "error" });
    }
  }

  return { errors, warnings };
}

// ── ENV Validator ──
function validateENV(content: string, strict: boolean): { errors: LintError[]; warnings: LintWarning[]; fixed?: string } {
  const errors: LintError[] = [];
  const warnings: LintWarning[] = [];
  const lines = content.split("\n");
  const seenKeys = new Set<string>();
  const fixedLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (trimmed === "" || trimmed.startsWith("#")) {
      fixedLines.push(line);
      continue;
    }

    // Must have = sign
    if (!trimmed.includes("=")) {
      errors.push({ line: lineNum, message: `Missing = sign. Expected KEY=VALUE format.`, severity: "error" });
      fixedLines.push(line);
      continue;
    }

    const eqIdx = trimmed.indexOf("=");
    const key = trimmed.substring(0, eqIdx);
    const value = trimmed.substring(eqIdx + 1);

    // Key validation
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      errors.push({ line: lineNum, message: `Invalid key "${key}". Keys should be alphanumeric with underscores.`, severity: "error" });
    }

    // Check for spaces around =
    if (line.includes(" = ") || line.match(/\s+=/) || line.match(/=\s+[^'"]/)) {
      if (strict) {
        warnings.push({ line: lineNum, message: `Spaces around = sign. Some parsers don't handle this.`, severity: "warning" });
      }
    }

    // Duplicate keys
    if (seenKeys.has(key)) {
      warnings.push({ line: lineNum, message: `Duplicate key "${key}"`, severity: "warning" });
    }
    seenKeys.add(key);

    // Uppercase convention
    if (strict && key !== key.toUpperCase()) {
      warnings.push({ line: lineNum, message: `Key "${key}" isn't uppercase. Convention is UPPER_SNAKE_CASE.`, severity: "warning" });
    }

    // Fix: ensure no spaces around =
    fixedLines.push(`${key}=${value}`);
  }

  return { errors, warnings, fixed: fixedLines.join("\n") };
}

// ── Glob matching (basic, no deps) ──
function matchGlob(pattern: string, dir: string = "."): string[] {
  const results: string[] = [];
  const resolvedDir = resolve(dir);

  // Simple glob: support *, **, and ?
  function walk(currentDir: string): void {
    try {
      const entries = readdirSync(currentDir);
      for (const entry of entries) {
        if (entry.startsWith(".") && !pattern.startsWith(".")) continue;
        if (entry === "node_modules") continue;

        const fullPath = join(currentDir, entry);
        try {
          const stat = statSync(fullPath);
          if (stat.isDirectory()) {
            if (pattern.includes("**")) {
              walk(fullPath);
            }
          } else if (stat.isFile()) {
            const relPath = fullPath.replace(resolvedDir + "/", "");
            if (matchesPattern(relPath, pattern)) {
              results.push(fullPath);
            }
          }
        } catch {
          // Skip inaccessible files
        }
      }
    } catch {
      // Skip inaccessible dirs
    }
  }

  function matchesPattern(str: string, pat: string): boolean {
    // Convert glob to regex
    let regex = pat
      .replace(/\./g, "\\.")
      .replace(/\*\*/g, "___DOUBLESTAR___")
      .replace(/\*/g, "[^/]*")
      .replace(/___DOUBLESTAR___/g, ".*")
      .replace(/\?/g, ".");
    return new RegExp(`^${regex}$`).test(str) || new RegExp(`${regex}$`).test(basename(str));
  }

  walk(resolvedDir);
  return results;
}

// ── Validate file ──
function validateFile(filePath: string, strict: boolean, fix: boolean): LintResult {
  const format = detectFormat(filePath);
  const result: LintResult = {
    file: filePath,
    format,
    valid: true,
    errors: [],
    warnings: [],
  };

  if (format === "unknown") {
    result.errors.push({ message: `Can't detect format for "${basename(filePath)}"`, severity: "error" });
    result.valid = false;
    return result;
  }

  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch (err) {
    result.errors.push({ message: `Can't read file: ${err instanceof Error ? err.message : String(err)}`, severity: "error" });
    result.valid = false;
    return result;
  }

  let validation: { errors: LintError[]; warnings: LintWarning[]; fixed?: string };

  switch (format) {
    case "json":
      validation = validateJSON(content, strict);
      break;
    case "yaml":
      validation = validateYAML(content, strict);
      break;
    case "toml":
      validation = validateTOML(content, strict);
      break;
    case "env":
      validation = validateENV(content, strict);
      break;
    default:
      validation = { errors: [], warnings: [] };
  }

  result.errors = validation.errors;
  result.warnings = validation.warnings;
  result.valid = validation.errors.length === 0;

  if (fix && validation.fixed && result.valid) {
    if (content !== validation.fixed) {
      writeFileSync(filePath, validation.fixed, "utf-8");
      result.fixed = true;
    }
  }

  return result;
}

// ── Output formatters ──
function printResult(result: LintResult): void {
  const icon = result.valid ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`;
  const formatTag = `${c.dim}[${result.format.toUpperCase()}]${c.reset}`;

  console.log(`  ${icon} ${formatTag} ${result.file}${result.fixed ? ` ${c.blue}(fixed)${c.reset}` : ""}`);

  for (const err of result.errors) {
    const loc = err.line ? `${c.dim}L${err.line}:${c.reset} ` : "";
    console.log(`    ${c.red}error${c.reset} ${loc}${err.message}`);
  }

  for (const warn of result.warnings) {
    const loc = warn.line ? `${c.dim}L${warn.line}:${c.reset} ` : "";
    console.log(`    ${c.yellow}warn${c.reset}  ${loc}${warn.message}`);
  }
}

function printSummary(results: LintResult[]): void {
  const total = results.length;
  const passed = results.filter((r) => r.valid).length;
  const failed = total - passed;
  const totalErrors = results.reduce((sum, r) => sum + r.errors.length, 0);
  const totalWarnings = results.reduce((sum, r) => sum + r.warnings.length, 0);
  const totalFixed = results.filter((r) => r.fixed).length;

  console.log("");
  if (failed === 0) {
    console.log(`  ${c.green}${c.bold}All ${total} files passed${c.reset}`);
  } else {
    console.log(`  ${c.red}${c.bold}${failed}/${total} files failed${c.reset}`);
  }

  const parts: string[] = [];
  if (totalErrors) parts.push(`${c.red}${totalErrors} errors${c.reset}`);
  if (totalWarnings) parts.push(`${c.yellow}${totalWarnings} warnings${c.reset}`);
  if (totalFixed) parts.push(`${c.blue}${totalFixed} fixed${c.reset}`);
  if (parts.length) console.log(`  ${parts.join("  ")}`);
  console.log("");
}

// ── Help ──
function printHelp(): void {
  console.log(`
${c.bold}${c.cyan}  config-lint${c.reset} ${c.dim}v${VERSION}${c.reset}
${c.dim}  Validate config files: JSON, YAML, TOML, ENV${c.reset}

${c.bold}  USAGE${c.reset}
    ${c.green}$ config-lint <files...>${c.reset}
    ${c.green}$ config-lint config.json .env settings.yaml${c.reset}
    ${c.green}$ config-lint "**/*.json" --strict${c.reset}

${c.bold}  ARGUMENTS${c.reset}
    ${c.yellow}<files...>${c.reset}    Config files or glob patterns to validate

${c.bold}  OPTIONS${c.reset}
    ${c.yellow}--strict${c.reset}      Enable strict mode (extra checks for best practices)
    ${c.yellow}--fix${c.reset}         Auto-format valid files (JSON formatting, ENV cleanup)
    ${c.yellow}--json${c.reset}        Output results as JSON
    ${c.yellow}--help${c.reset}        Show this help message
    ${c.yellow}--version${c.reset}     Show version number

${c.bold}  SUPPORTED FORMATS${c.reset}
    ${c.blue}.json${c.reset}         JSON syntax validation + duplicate key detection
    ${c.blue}.yml/.yaml${c.reset}    YAML syntax, indentation, and duplicate key checks
    ${c.blue}.toml${c.reset}         TOML syntax and section validation
    ${c.blue}.env${c.reset}          ENV format validation, key naming conventions

${c.bold}  EXAMPLES${c.reset}
    ${c.dim}# Validate a single file${c.reset}
    ${c.green}$ config-lint tsconfig.json${c.reset}

    ${c.dim}# Batch validate all configs${c.reset}
    ${c.green}$ config-lint "**/*.json" "**/*.yaml" .env${c.reset}

    ${c.dim}# Strict mode with auto-fix${c.reset}
    ${c.green}$ config-lint config.json --strict --fix${c.reset}

    ${c.dim}# JSON output for CI/CD${c.reset}
    ${c.green}$ config-lint "**/*.json" --json${c.reset}
`);
}

// ── Main ──
function main(): void {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  if (args.includes("--version") || args.includes("-v")) {
    console.log(VERSION);
    process.exit(0);
  }

  const flags = {
    json: args.includes("--json"),
    strict: args.includes("--strict"),
    fix: args.includes("--fix"),
  };

  const positional = args.filter((a) => !a.startsWith("--"));

  if (positional.length === 0) {
    if (!flags.json) {
      console.error(`\n  ${c.red}${c.bold}Error:${c.reset} No files specified.\n`);
      console.error(`  ${c.dim}Usage: config-lint <files...>${c.reset}\n`);
      console.error(`  ${c.dim}Run config-lint --help for more info${c.reset}\n`);
    } else {
      console.log(JSON.stringify({ error: "No files specified" }, null, 2));
    }
    process.exit(1);
  }

  // Resolve files from positional args (could be glob patterns or direct paths)
  let files: string[] = [];
  for (const arg of positional) {
    if (arg.includes("*")) {
      files = files.concat(matchGlob(arg));
    } else {
      files.push(arg);
    }
  }

  if (files.length === 0) {
    if (!flags.json) {
      console.error(`\n  ${c.yellow}${c.bold}Warning:${c.reset} No matching files found.\n`);
    } else {
      console.log(JSON.stringify({ error: "No matching files found", results: [] }, null, 2));
    }
    process.exit(1);
  }

  if (!flags.json) {
    console.log(`\n${c.bold}${c.cyan}  config-lint${c.reset} ${c.dim}validating ${files.length} file${files.length === 1 ? "" : "s"}${c.reset}\n`);
  }

  const results: LintResult[] = [];
  for (const file of files) {
    const result = validateFile(file, flags.strict, flags.fix);
    results.push(result);
    if (!flags.json) printResult(result);
  }

  if (flags.json) {
    console.log(JSON.stringify({ results, summary: {
      total: results.length,
      passed: results.filter((r) => r.valid).length,
      failed: results.filter((r) => !r.valid).length,
      errors: results.reduce((sum, r) => sum + r.errors.length, 0),
      warnings: results.reduce((sum, r) => sum + r.warnings.length, 0),
    }}, null, 2));
  } else {
    printSummary(results);
  }

  const hasErrors = results.some((r) => !r.valid);
  process.exit(hasErrors ? 1 : 0);
}

main();
