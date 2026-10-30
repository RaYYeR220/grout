# Hello

A command-line greeter.

## Usage

```
hello <name> [--shout]
```

- `hello Ada` prints `Hello, Ada!` followed by a newline and exits with code 0.
- With `--shout` the whole greeting is upper case: `hello Ada --shout` prints `HELLO, ADA!`.
- Without a name it prints `usage: hello <name> [--shout]` to stderr and exits with code 2.
- Any other flag (for example `--loud`) prints `unknown option: --loud` to stderr and exits with code 2.
