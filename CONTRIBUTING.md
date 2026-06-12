# Contributing to Grepmem

Thanks for considering a contribution! This project is small and the surface area is well-defined — most contributions fall into one of these buckets.

## What kind of contributions are welcome

### Definitely welcome

- **Bug reports** — something doesn't work as documented. Open an issue.
- **Bug fixes** — open a PR with a test that reproduces the bug, plus the fix.
- **New test cases** — edge cases that aren't covered by the existing 85 tests.
- **Documentation improvements** — typos, clearer explanations, more examples.
- **New built-in synonyms** — common cross-language mappings (e.g. `崩溃 → crash`).
- **Performance benchmarks** — ran the eval scripts on your hardware? Share numbers.
- **Support for new MCP hosts** — verified working with Cline / Windsurf / etc.? Add a section to `examples/`.

### Welcome but needs discussion first

- **New MCP tools** — open an issue first to discuss the use case. We want to keep the tool surface small.
- **New retrieval strategies** — additional grep passes, new synonym learning rules, etc.
- **New benchmarks** — if you've run Grepmem on a public benchmark (LongMemEval-V2, LoCoMo, etc.), share the methodology and numbers.
- **Support for non-English languages** — Chinese is supported via built-in synonyms; other CJK / Cyrillic / etc. welcome.

### Probably won't be accepted

- **Adding an embedding backend** — defeats the core "vectorless" principle.
- **Adding a vector DB integration** — same.
- **Adding LLM calls at ingestion** — same.
- **Rewriting the engine in another language** — fork instead.

## Setup

```bash
git clone https://github.com/WAPA0012/grepmem
cd grepmem
npm install
npm test               # 76 unit tests
npm run test:scale     # 9 scale tests
```

All tests must pass before a PR is merged.

## Workflow

1. **Open an issue first** for anything beyond a small bug fix or doc typo. This avoids wasted work if the direction doesn't fit.
2. Fork the repo, create a branch (`git checkout -b fix/my-bug`).
3. Make changes. Add tests for any new behavior.
4. Run `npm test` and `npm run test:scale` locally.
5. Commit with a clear message. Reference the issue (`Fixes #12`).
6. Open a PR.

## Code style

- **No Prettier / ESLint config** — match the surrounding style.
- Use **ES modules** (`.mjs` for scripts that need it; `.js` for library code).
- 2-space indent. Single quotes. Trailing commas in multi-line objects/arrays.
- Comments: explain *why*, not *what*. The code already says what.

## Tests

- Unit tests in `eval/test-*.mjs`.
- Use Node's built-in `node:test` runner.
- A test file per concern: `test-engine.mjs` (engine behavior), `test-html.mjs` (HTML round-trip), `test-errors.mjs` (bad input handling), `test-scale.mjs` (concurrency + scale).
- Aim for one assertion per test name. Test names are sentences: `add() returns the article ID and stores it`.

## Commit messages

Format:

```
<one-line summary>

<optional body explaining why, not what>
```

Examples:

```
Fix: dedup check now happens before ID generation

Previously, _generateId added a -N suffix before _checkDup ran, so two
articles with the same summary text both got written. Move dedup check
before ID allocation.

Fixes #42
```

```
Add Chinese synonym for 崩溃 → crash
```

## Reporting bugs

Open an issue with:

- What you did (exact commands or API calls).
- What you expected.
- What happened instead.
- The output of `node -v` and `npm -v`.
- If retrieval-related: a snippet of the relevant `memory.html` (you can redact content).

## Reporting security issues

Don't open a public issue. Email the maintainer directly.

## Licensing

By contributing, you agree that your contributions will be licensed under the MIT license.

## Code of conduct

Be kind. Assume good faith. Disagree about code, not people.
