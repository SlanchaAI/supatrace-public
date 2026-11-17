import {Transform} from 'node:stream';
import {StdioServerTransport} from '@modelcontextprotocol/server/stdio';

// SDK owns framing/negotiation. This wrapper bounds a whole local connection and
// serializes writes so a client that stops reading cannot grow a send backlog.
export function boundedStdio(stdin, stdout, abort, {writeTimeoutMs = 5000} = {}) {
  let inputBytes = 0, frames = 0, outputBytes = 0, pendingBytes = 0, pending = 0, closed = false, chain = Promise.resolve();
  const input = new Transform({transform(chunk, encoding, done) {
    inputBytes += chunk.length; for (const byte of chunk) if (byte === 10) frames++;
    if (inputBytes > 1048576 || frames > 1000) {stop(); done();} else done(null, chunk);
  }});
  const transport = new StdioServerTransport(input, stdout, {maxBufferSize: 16384});
  const nativeSend = transport.send.bind(transport), nativeClose = transport.close.bind(transport);
  function stop() {
    if (closed) return; closed = true; abort(); stdin.unpipe(input); stdin.pause(); input.destroy(); void nativeClose().catch(() => {});
  }
  transport.close = async () => {stop();};
  transport.send = message => {
    const size = Buffer.byteLength(JSON.stringify(message));
    if (closed || size > 1048576 || pending >= 8 || pendingBytes + size > 2097152 || outputBytes + size > 32 * 1048576) {
      stop(); return Promise.reject(Error('mcp_output_limit'));
    }
    pending++; pendingBytes += size; outputBytes += size;
    const job = chain.then(async () => {
      if (closed) throw Error('mcp_closed');
      let timer;
      try {
        await Promise.race([nativeSend(message), new Promise((resolve, reject) => {timer = setTimeout(() => {stop(); reject(Error('mcp_output_stalled'));}, writeTimeoutMs);})]);
      } finally {clearTimeout(timer);}
    }).finally(() => {pending--; pendingBytes -= size;});
    chain = job.catch(() => {});
    return job;
  };
  stdin.once('end', stop); stdin.once('close', stop); stdin.once('error', stop); input.on('error', stop); stdout.once('error', stop);
  const nativeStart = transport.start.bind(transport);
  transport.start = async () => {await nativeStart(); stdin.pipe(input);};
  return transport;
}
