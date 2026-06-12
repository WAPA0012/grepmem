---
name: Bug report
about: Something doesn't work as documented
title: "[Bug] "
labels: bug
body:
  - type: textarea
    id: what-happened
    attributes:
      label: What happened?
      description: Also tell us what you expected to happen.
      placeholder: "I tried to ... but ..."
    validations:
      required: true
  - type: textarea
    id: repro
    attributes:
      label: Steps to reproduce
      description: Exact commands or API calls.
      placeholder: |
        ```bash
        node server.mjs
        curl -X POST http://localhost:18234/add -d '...'
        ```
    validations:
      required: true
  - type: input
    id: node-version
    attributes:
      label: Node version
      description: Output of `node -v`
    validations:
      required: true
  - type: textarea
    id: memory-html
    attributes:
      label: Relevant memory.html snippet (optional)
      description: Redact sensitive content. Wrap in triple-backtick.
    validations:
      required: false
---

## What happened?

<!-- Describe what you did, what you expected, and what actually happened. -->

**Expected:**

**Actual:**

## Steps to reproduce

```bash
# Exact commands
```

## Environment

- Node version: 
- Grepmem version / commit: 
- OS: 

## Relevant `memory.html` snippet (optional)

```html
<!-- Paste the relevant <article> block here. Redact secrets. -->
```
