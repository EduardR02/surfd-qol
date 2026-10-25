// Static server for the dev harness: `bun dev/serve.js [port]`, then open
// http://127.0.0.1:5178/dev/ . Serves the repository root so the harness can
// import the real src/ modules unbundled.
import {resolve, sep, extname} from 'node:path';

const root = resolve(import.meta.dir, '..');
const types = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png'};

export function serve(port = 5178) {
  return Bun.serve({
    port,
    hostname: '127.0.0.1',
    async fetch(request) {
      let path = decodeURIComponent(new URL(request.url).pathname);
      if (path.endsWith('/')) path += 'index.html';
      const file = resolve(root, `.${path}`);
      if (file !== root && !file.startsWith(root + sep)) return new Response('Forbidden', {status: 403});
      const body = Bun.file(file);
      if (!(await body.exists())) return new Response('Not found', {status: 404});
      return new Response(body, {headers: {'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store'}});
    },
  });
}

if (import.meta.main) {
  const server = serve(Number(process.argv[2] ?? process.env.PORT ?? 5178));
  console.log(`Surfd QoL harness: http://127.0.0.1:${server.port}/dev/`);
}
