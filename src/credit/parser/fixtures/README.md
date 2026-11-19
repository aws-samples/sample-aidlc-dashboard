# Parser golden fixtures

The `*.txt` files in this directory are golden fixtures that check the parsing of `/usage` output
deterministically.

**Caution — handling sensitive data (team-practices security practice):**
- These fixtures are **synthetic examples**, not real account data; a real capture would be stored only
  **after redacting** sensitive values such as account identifiers, tokens and e-mail addresses.
- Never commit raw `/usage` output as is (with sensitive values).
- Every number, plan name and date here is a dummy example value.

`normal-ko.txt` and `zero-credits.txt` are in Korean on purpose: they stand for kiro-cli output in a
Korean locale, which the parser's Korean label keys must match.

The parser tests (`../usage-parser.test.ts`) take these strings as input and do not call the CLI.
