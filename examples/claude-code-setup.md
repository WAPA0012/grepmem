# Example 3: Use Grepmem as an MCP tool in Claude Code

This shows how to expose Grepmem to Claude Code (or any MCP-aware agent)
so the agent can store and recall memories autonomously.

## 1. Start the MCP server

```bash
# Run in the background. It speaks stdio MCP.
node /absolute/path/to/grepmem/mcp-server.mjs
```

By default the namespace is `./namespaces/default`. To use a different
namespace (e.g. per-project), set `MEMORY_PATH`:

```bash
MEMORY_PATH=~/.grepmem/my-project node /path/to/mcp-server.mjs
```

## 2. Register with Claude Code

```bash
claude mcp add grepmem -- node /absolute/path/to/grepmem/mcp-server.mjs
```

Verify:

```bash
claude mcp list
# → grepmem  ✓ connected
```

## 3. Use it

Open Claude Code and just ask natural questions. Claude will decide when
to store and recall:

```
You: Hey, the prod Redis password is r3d1s_v2_2025, port 6379.
Claude: [calls memory_store tool] Stored.

You: What's the prod Redis password again?
Claude: [calls memory_recall "Redis password"]
       The prod Redis password is r3d1s_v2_2025, port 6379.
```

## 4. Tools exposed

The MCP server exposes 6 tools. Claude picks which to call based on context:

| Tool | When Claude uses it |
|------|---------------------|
| `memory_store` | You mention a fact / config / decision worth remembering |
| `memory_recall` | You ask a question that needs project context |
| `memory_read` | Claude wants to verify a candidate has the answer |
| `memory_list` | Claude browses what's stored (e.g. "what memories do you have?") |
| `memory_grep` | Claude needs raw regex search (specific IP, exact phrase) |
| `memory_find_symbol` | Claude looks up a function/class/const definition in stored code |

## 5. Inspect what's stored

The memory is a single HTML file:

```bash
# Open in any browser — fully human-readable
open ~/.grepmem/my-project/memory.html

# Or grep it from the CLI
rg "Redis" ~/.grepmem/my-project/memory.html
```

## 6. Switch namespaces per project

The MCP server reads `MEMORY_PATH` at startup. To use different memory
per project, either:

- Run multiple MCP servers with different `MEMORY_PATH` env vars
- Or restart the server with a new env var when switching projects

```bash
# Project A
MEMORY_PATH=~/.grepmem/project-a claude mcp add grepmem-a -- node /path/to/mcp-server.mjs

# Project B
MEMORY_PATH=~/.grepmem/project-b claude mcp add grepmem-b -- node /path/to/mcp-server.mjs
```

Then in Claude Code, switch which MCP server is active per project.
