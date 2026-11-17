# Opt-in Claude Code hook beta

This connector receives documented command-hook JSON through stdin. It never reads `transcript_path`, searches session files, installs settings, starts a daemon, opens a listener or calls a model provider. Installation is a separate, explicit project-scoped choice. Source tests are synthetic; a real installed Claude version and a permitted session still need acceptance before this is called working native collection.

See the [setup guide](../public/agent-setup.html#claude-hooks) and [merge-only settings example](../public/examples/claude-hooks.settings.json). Requires POSIX macOS/Linux, Python 3 with `fcntl` and main-thread `SIGALRM`, and `claude_hook.py` beside `upload.py`. Do not use a symlinked script/config/spool/workspace path. Scripts and private state should be outside the captured project and not committed.

## Scope and consent

An existing approved connection binds the exact Supatrace HTTPS origin and project. `init` requires an existing workspace, approved owner-only config and a new private spool outside that workspace. It never replaces an existing spool or changes its source, destination or mode. `--content` requires the additional `--allow-content` flag. `--upload-on-stop` separately opts into automatic bounded uploads at a completion hook; otherwise capture is local only until explicit `flush`.

Default **metadata mode** retains hook type, tool name, hashed session/agent/prompt/tool references, local capture sequence and receipt time. It excludes prompts, tool arguments/results, final text, transcript/scratch paths, environment and unknown fields. It does not hash excluded content for deduplication. Metadata is still account data and can reveal activity. **Content mode** additionally preserves prompt, tool input/result and final response fields. These may contain passwords, keys, personal information and file paths. There is no automatic redaction. Approve the exact source workspace, destination project and content mode before enabling ongoing capture or automatic upload. A prior one-time test is not standing permission.

Never reuse a content spool as metadata-only. Changing source/mode needs a new explicit setup; keep the old spool and its receipt state. Do not reset/delete state or recreate keys to fix uncertain uploads. Use existing account key revocation to stop future acceptance, and remove only the hook entries you installed to stop capture. Revocation does not delete already stored traces or private pending data.

## Coverage and identity

This beta projects only UserPromptSubmit, successful PostToolUse and main-agent Stop events. UserPromptSubmit is a prompt submission, not necessarily a human message. Tool input/result share one event; receipt time is not a tool-start timestamp. Interruptions, failed tools, API errors, reasoning, intermediate model spans and full-session completeness are not covered. A missing Stop does not synthesize a final response.

It requires native `session_id` and `prompt_id`, and `tool_use_id` for tools. Optional native `agent_id` namespaces subagents. Verify those fields with the actual installed Claude version in a deliberately nonsensitive session; no minimum version is guessed. Missing IDs are counted omissions, never recovered by reading transcripts. The source contract is [Claude Code command hooks](https://code.claude.com/docs/en/hooks), not proof of installed-version behavior.

Prompt/tool identity is installation + session + agent + prompt + event + tool ID where applicable. Repeated delivery with the same selected payload retains the first event, time, ID and batch even after acceptance. Changed selected payload under one stable identity is a conflict, not an overwrite. Equal text under different native identities stays distinct. Stop lacks a universal delivery ID: each received Stop gets a local occurrence ID. Duplicate source Stop delivery can therefore remain duplicated; no native exactly-once claim is made.

## Bounds and recovery

- Read at most 256 KiB of stdin, validate duplicate keys, finite safe numbers and nesting before projection. Event data remains at most 32 KiB. Oversize/unsupported input is omitted with health reporting, never silently truncated.
- Private journal: at most 2,000 events and 8 MiB. Aggregate spool: at most 24 MiB including atomic-write reserve. Retained accepted records preserve deduplication history. No automatic deletion or rollover is implemented. Stop recording when capacity is reached; do not clear state and replay an old session.
- Owner-only directory/files, no symlinks/hardlinks or traversal; bounded OS-released journal locks serialize concurrent hooks. Unknown/orphan files halt the spool for inspection, never disappear through cleanup. A crash during atomic writing can require local reconciliation.
- CLI capture has a two-second interrupt deadline. Controlled failure paths return zero with no stdout or hook decisions. Failures emit only a sanitized health code to stderr and attempt a durable omission counter. If the counter cannot be saved, the error says so; a clean counter is not proof of no lost events.
- Optional Stop flush has an eight-second POSIX interrupt deadline, at most two uploads, and a delay before a second request. The example sets a twelve-second host hook timeout as an external guard and to allow local cleanup. Python signal delivery can be deferred by C/library calls, so the timer alone is not a universal wall-clock kill; installed host timeout behavior still needs native verification. Large backlogs may remain pending; use `status` and an explicit bounded `flush`. No fire-and-forget child process is used.
- Immutable batches have at most 100 events / 512 KiB. The batch assignment is durable before file materialization, and `attempting` is durable before transport. Only an exact accepted batch/hash/project ACK permits local accepted status. No redirect is followed. Existing TLS/proxy policy is preserved.
- An unknown response, wrong ACK, expired/revoked key, quota/rate error or process death around an attempt fences further uploads as `uncertain`. There is deliberately no blind retry or reset command. Preserve bytes and journal for authenticated batch/hash/project reconciliation. A write-only key cannot perform that readback, and this beta does not automate reconciliation.

`status` reports configured/pending/uncertain/accepted counts and omissions. It never prints content, credential values or private source paths. It explicitly does not claim recording right now, complete capture or verified hosted readback. Key presence alone is not a connected/importing indicator.

## Real acceptance still required

After specific consent for one nonsensitive workspace/session and its destination: verify installed native fields, pair the intended project, install only the reviewed project hook entries, generate a real prompt, successful tool and final response, then inspect matching hosted events and their fields. Repeat a flush with no new records and verify no extra upload. Remove the test hook entries and revoke only its temporary key when done. Keep synthetic API/ACK tests distinct from that real receipt. This does not implement cloud Langfuse Start, Codex capture, saved-export acceptance or the entire novice setup outcome.
