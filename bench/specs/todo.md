# todo

A to-do list for the terminal. Items are kept in a JSON file, so the list survives between runs.

## Invocation

The package declares a command named `todo` in the `bin` field of its `package.json`, pointing at the compiled entry point. It is run as `todo <command> [arguments]`.

## Storage

Items live in the file named by the `TODO_FILE` environment variable, or in `todo.json` in the current working directory when `TODO_FILE` is not set.

- A missing file means an empty list. The file is created by the first command that changes something; `list` never creates it.
- The file holds JSON. Its layout is up to you, but it is rewritten after every change, so the next run sees the change.
- A command that fails leaves the file exactly as it was (and does not create it).

## Items

An item has an id, a text and a done flag. Ids are positive integers. The first item gets `1`; every new item gets one more than the highest id ever handed out for that file. Ids are never reused, even after items are removed.

## Commands

| command | effect | prints |
|---|---|---|
| `todo add <text...>` | adds an open item; its text is all the arguments after `add` joined with single spaces, then trimmed | `added #<id>` |
| `todo list` | lists all items in id order | one line per item |
| `todo list --open` | lists only open items | one line per item |
| `todo list --done` | lists only done items | one line per item |
| `todo done <id>` | marks the item done; an item that is already done stays done and this is not an error | `done #<id>` |
| `todo remove <id>` | deletes the item | `removed #<id>` |
| `todo clear` | deletes every done item | `cleared <n>`, where `<n>` is how many were deleted (it may be `0`) |

A list line is `[ ] #<id> <text>` for an open item and `[x] #<id> <text>` for a done one. When no item matches, `list` prints `no items`.

An `<id>` argument may be written with or without a leading `#`: `todo done 2` and `todo done '#2'` mean the same item.

Output goes to stdout; every line ends with a newline. Successful commands exit with code 0.

## Errors

An error prints one line to stderr (ending in a newline), nothing to stdout, and exits with the code below.

| situation | message | exit |
|---|---|---|
| no command, or an unknown command | `usage: todo <command> [arguments]` | 2 |
| `list` with any argument other than `--open` or `--done` | `usage: todo <command> [arguments]` | 2 |
| `add` whose text is empty | `error: text is required` | 2 |
| `done` or `remove` without an id, or with an id that is not a positive integer | `error: invalid id` | 2 |
| `done` or `remove` with an id that no item has | `error: no item #<id>` | 1 |
| the data file exists but is not valid JSON | `error: cannot read data file` | 1 |

## Example

```
$ todo add buy oat milk
added #1
$ todo add call the plumber
added #2
$ todo done 1
done #1
$ todo list
[x] #1 buy oat milk
[ ] #2 call the plumber
$ todo done 7
error: no item #7
$ echo $?
1
```
