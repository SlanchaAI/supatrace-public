# `supatrace` command line

Connect an app to a workspace and watch its traces from a terminal. The CLI is `packages/supatrace-js/cli.mjs`, the `supatrace` bin of the source-only `supatrace` JavaScript package in the public repository. It has no dependencies and needs Node 22 or later.

**Coming soon.** The JavaScript `supatrace` package is not published to npm. The alpha Python SDK is on PyPI (`pip install supatrace==0.1.0`); it does not include this CLI. Until then send traces with the stock OpenTelemetry exporter (see the [OTLP quickstart](otlp-ingest.md)) or the Python/Node snippets on Home. Run the CLI from the [public source checkout](https://github.com/SlanchaAI/supatrace-public):

```sh
node packages/supatrace-js/cli.mjs --help
```

The JavaScript manifest names the package `supatrace`. Registry install commands are unavailable until it is published.

| Command | What it does |
| --- | --- |
| `supatrace login` | Saves a read-only personal access token for `tail`. |
| `supatrace init` | Pairs this folder with a workspace and writes a write key to `.env.local`. |
| `supatrace tail` | Prints traces as they arrive. |
| `supatrace dev` | Runs the local viewer from a source checkout. |
| `supatrace logout` | Removes the saved token. |

Keys and tokens are never printed, by any command.

## login

Create a personal access token in **Settings** (see [management API](management-api.md)), then:

```sh
supatrace login                       # asks for the token with hidden input
supatrace login --token-stdin < file  # for scripts
```

The CLI checks the token with `GET /api/v1/me` and saves it to `~/.config/supatrace/credentials.json` (or `$XDG_CONFIG_HOME/supatrace/`), readable by the owner only. A refused token is not saved. `SUPATRACE_ACCESS_TOKEN` in the environment is used instead of the saved token when set.

The token is read-only: it can list traces and cannot upload or create keys. There is no browser device flow for tokens and no OS keychain storage yet; both are left for later.

## init

```sh
supatrace init                        # writes .env.local in the current folder
supatrace init --env-file .env --project proj_… --environment production
```

`init` uses the same pairing as `agent/connect.py`. It makes a write key on this machine, sends only the key's SHA-256, and prints a link and a code. A workspace owner or admin opens the link and approves the code. `init` then writes:

```
SUPATRACE_API_KEY=…            # write-only key; not shown on the terminal
SUPATRACE_OTLP_ENDPOINT=https://supatrace.dev
SUPATRACE_PROJECT=proj_…
```

- The file is created or rewritten owner-only (`0600`). Other lines in it are kept.
- **Idempotent.** A file that already has `SUPATRACE_API_KEY` is left alone and no request is made. To replace the key, revoke it in the workspace, remove the line and run `init` again.
- A file bound to one origin or project is never re-bound by a later `--origin` or `--project`.
- If the code is not approved within `--wait` seconds (600 by default), nothing is written and the exit code is 3. Run `init` again in the same folder to keep waiting on the same code. The pending pairing is kept in the user's config directory, not in the project.
- `init` warns when the env file is not ignored by git.

The write key works with `POST /api/batches` and the hosted OTLP/HTTP receiver at `https://supatrace.dev/v1/traces`. See [OTLP ingest](otlp-ingest.md) for stock exporter setup; no SupaTrace package is needed.

## tail

```sh
supatrace tail                 # poll every 5 seconds until Ctrl-C
supatrace tail --once --json   # one page as JSON lines, for scripts
```

`tail` polls `GET /api/v1/traces` and prints one line per trace: start time, status, duration, event count and id. Options: `--interval` (1 to 300 seconds), `--limit` (1 to 100, how many existing traces to show at the start), `--workspace`, `--environment`.

Duration uses the earliest-starting root span’s own end minus start; missing or unfinished roots and older stored runs without root metadata use the full span range.

It is a poll, not a stream. Each poll reads the 100 most recently started traces and keeps reading older pages while a page still holds a new or changed trace, up to 500 traces a poll; past that it says on stderr that older ones are not shown. A trace that receives more events is printed again, marked `(updated)`, when it is within the pages a poll reads. A change to a trace that started before 100 or more unchanged traces is not seen. Traces are listed by their start time, which comes from the events. A trace uploaded now with older event times (a backfill or an import) sorts among the old traces and is not shown. When it starts, `tail` reads the traces that already exist so that none of them is later printed as new.

The API lists a bounded set of stored traces per request (800 today) and marks its answer `truncated` beyond that. In a workspace with more traces `tail` says once on stderr that the list is partial: some traces, including new ones, can be missing, and an older trace is then recognised by the time the server first received it, to the second. A poll that fails part-way is repeated whole on the next attempt. Each token may make 120 requests a minute.

## dev

```sh
supatrace dev --port 3000
```

From inside a SupaTrace source checkout this starts the repository's local development server (`npm run dev`): the real handlers on loopback with in-memory synthetic data, described in [local development](local-development.md). It contacts no outside service; a test runs it under a guard that refuses every non-loopback connection.

Outside a checkout `dev` exits with an explanation. A local collector and viewer packaged with the CLI is not shipped yet.

## Origins

Credentials are sent only to `https://supatrace.dev`, `https://supatrace.tech`, or a plain-http loopback address (`http://127.0.0.1:<port>`) for local development. Choose with `--origin` or `SUPATRACE_ORIGIN`. Redirects are not followed.

## Not verified

Tests run offline against the local harness (`tests/cli.test.mjs`). No run against https://supatrace.dev has been recorded, and the package has not been published.

The Python `connect.py` and `upload.py` scripts default to `https://supatrace.dev`. Saved configurations bound to `https://supatrace.tech` keep using that host. Use the same host when signing in to approve a setup code. The code survives same-tab sign-in redirects until approval or sign-out.
