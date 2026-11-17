# MCP dependencies

The official `@modelcontextprotocol/server`, `@modelcontextprotocol/client` and `@modelcontextprotocol/core` packages are pinned to **2.4.0**. Zod is pinned to **4.6.7**. Exact tarball integrities and transitive versions are retained in `package-lock.json` and `sbom.cdx.json`; lifecycle scripts are disabled during installation.

The SDK package metadata says Apache-2.0. Its bundled license also records a transition: contributions without relicensing consent remain MIT. Preserve the complete [upstream license](licenses/modelcontextprotocol-LICENSE), including both notices. [Zod license](licenses/zod-LICENSE) is MIT. Other dependencies retain their licenses in the installed packages; the SBOM records their declared expressions. No SDK source was copied or modified.

Verified November 5, 2026 against the npm registry packages and the [official repository](https://github.com/modelcontextprotocol/typescript-sdk). Current [SDK documentation](https://ts.sdk.modelcontextprotocol.io/v2/) identifies the v2 server/client packages as the stable line, with legacy negotiation support. The [stdio transport specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio) defines the local process transport.
