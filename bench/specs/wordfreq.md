# wordfreq

A command-line tool that counts how often each word occurs in a text. We point it at changelogs and support tickets to spot recurring terms.

## Invocation

Run it as `node dist/wordfreq.js [options] [file]`.

- With a `file` argument the text is read from that file (a relative path is resolved against the current working directory).
- Without a `file` argument, or when the argument is `-`, the text is read from standard input.
- Options and the file argument may come in any order. All arguments are checked before any input is read.

| option | meaning |
|---|---|
| `--top N` or `--top=N` | print only the first `N` entries. `N` must be a positive integer written with the digits `0`-`9` only (`3` is fine; `0`, `-1`, `2.5` and `three` are not) |
| `--json` | print JSON instead of text |

## Words

- A word is a maximal run of ASCII letters (`a`-`z`, `A`-`Z`), digits (`0`-`9`) and apostrophes (`'`). Every other character separates words, so `state-of-the-art` is four words and `snake_case` is two.
- Apostrophes at the start or end of a run are removed (`'tis` becomes `tis`, `dogs'` becomes `dogs`); apostrophes inside a word stay (`don't`, `rock'n'roll`). A run with nothing left after that is not a word.
- Words are case-insensitive and always printed in lower case.

## Ordering

Entries are sorted by count, highest first. Words with the same count are sorted by plain character-code order of the lower-cased word, so `2nd` comes before `apple`, which comes before `banana`.

`--top N` keeps the first `N` entries of that ordering. If there are fewer than `N` distinct words, all of them are printed.

## Output

Text (the default): one line per entry: the count, one tab character, the word, a newline. Nothing else is printed. An input without words prints nothing.

JSON (`--json`): one line holding a single object, followed by a newline:

```
{"total":8,"unique":5,"words":[{"word":"the","count":3},{"word":"cat","count":2}]}
```

`total` is the number of words in the whole input and `unique` the number of distinct words, both counted before `--top` is applied. `words` holds the printed entries, in order. An input without words gives `{"total":0,"unique":0,"words":[]}`.

The exit code is 0 on success.

## Errors

An error prints one line to stderr (ending in a newline), nothing to stdout, and exits with the code below.

| situation | message | exit |
|---|---|---|
| `--top` without a valid value (including no value at all) | `wordfreq: --top must be a positive integer` | 2 |
| any other argument starting with `-`, except `-` itself | `wordfreq: unknown option <arg>` | 2 |
| more than one file argument | `wordfreq: too many arguments` | 2 |
| the file cannot be read | `wordfreq: cannot read <file>` (the argument exactly as given) | 1 |

## Example

```
$ printf 'The cat saw the other cat. THE END' | node dist/wordfreq.js --top 2
3	the
2	cat
$ printf 'The cat saw the other cat. THE END' | node dist/wordfreq.js --top 2 --json
{"total":8,"unique":5,"words":[{"word":"the","count":3},{"word":"cat","count":2}]}
```
