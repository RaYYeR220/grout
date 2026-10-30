# semver

A command-line helper for Semantic Versioning 2.0.0 version strings, used by our release scripts.

## Invocation

It is run through npm from the project directory: `npm start -- <command> [arguments]`. The release scripts call `npm start --silent -- <command> [arguments]`, so what the program itself prints must be exactly what is described below.

## Versions

A version is `MAJOR.MINOR.PATCH`, optionally followed by `-PRERELEASE`, optionally followed by `+BUILD`.

- `MAJOR`, `MINOR` and `PATCH` are non-negative integers without leading zeros (`0` is fine, `01` is not).
- `PRERELEASE` and `BUILD` are dot-separated lists of one or more non-empty identifiers made of `0`-`9`, `A`-`Z`, `a`-`z` and `-`. A purely numeric `PRERELEASE` identifier must not have leading zeros (`rc.01` is invalid); `BUILD` identifiers may (`+001` is fine).
- A single leading `v` is allowed and ignored: `v1.2.3` means `1.2.3`. Nothing else may come before or after the version.

Precedence follows SemVer 2.0.0. Compare `MAJOR`, `MINOR` and `PATCH` numerically, in that order. A version with a `PRERELEASE` is lower than the same version without one. Two `PRERELEASE` lists are compared identifier by identifier from the left: numeric identifiers compare numerically, other identifiers compare by ASCII order, a numeric identifier is lower than a non-numeric one, and when one list runs out first, the shorter list is lower. `BUILD` is ignored for precedence.

## Commands

- `compare <a> <b>` prints `-1` if `a` has lower precedence than `b`, `0` if the same, `1` if higher.
- `bump <level> <version>`, where `<level>` is `major`, `minor` or `patch`, prints the next version: `major` gives `(MAJOR+1).0.0`, `minor` gives `MAJOR.(MINOR+1).0`, `patch` gives `MAJOR.MINOR.(PATCH+1)`. The result never has a `PRERELEASE`, a `BUILD` or a leading `v`, so `bump patch v1.2.3-rc.1+b7` prints `1.2.4`.
- `valid <version>` prints nothing. It exits with 0 if the version is valid and 1 if it is not.
- `sort` reads versions from standard input, one per line, and prints them in ascending precedence, one per line. Whitespace around each line is trimmed (this includes the `\r` of Windows line endings) and empty lines are skipped. Each version is printed exactly as written apart from the trimming, so a `v` or a `BUILD` part stays. Versions of equal precedence keep their input order.

Every printed line ends with a newline. Success exits with code 0.

## Errors

An error prints one line to stderr (ending in a newline) and nothing to stdout. Checks happen in this order: command, number of arguments, level, versions.

- No command, or an unknown one: `usage: semver <command> [arguments]`, exit 2.
- Wrong number of arguments: the command's own usage line, exit 2. These are `usage: semver compare <a> <b>`, `usage: semver bump <level> <version>`, `usage: semver valid <version>` and `usage: semver sort` (`sort` takes no arguments).
- `bump` with a level other than `major`, `minor` or `patch` (case-sensitive): `invalid level: <level>`, exit 2.
- `compare` or `bump` with an invalid version: `invalid version: <argument>`, naming the first invalid argument, exit 1.
- `sort` with an invalid line: `invalid version on line <n>: <line>`, where `<n>` counts every input line from 1 (empty lines included) and `<line>` is the trimmed text. Only the first invalid line is reported, exit 1.

## Example

```
$ npm start --silent -- compare 1.10.0 1.9.0
1
$ npm start --silent -- bump minor 1.2.3-beta.2
1.3.0
$ printf '1.0.0\n1.0.0-rc.1\n0.9.12\n1.0.0-alpha\n' | npm start --silent -- sort
0.9.12
1.0.0-alpha
1.0.0-rc.1
1.0.0
```
