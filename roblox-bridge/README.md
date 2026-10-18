# roblox-bridge

A local-first bridge that lets a CLI drive Roblox Studio over HTTP, with optional Cloudflare Tunnel exposure and token protection.

## Structure
- `bridge/`: The local HTTP server that acts as the relay between the CLI and Studio.
- `plugin/`: The Roblox Studio plugin that connects to the bridge and executes commands.
- `cli/`: The `rbb` command-line tool.
- `tests/`: End-to-end and unit tests.

See `INSTALL_WINDOWS.md` for full installation instructions.
