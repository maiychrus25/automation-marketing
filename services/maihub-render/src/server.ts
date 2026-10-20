import * as http from 'http';
import { ApiDeps, createRouter } from './routes';

/** Máy chủ HTTP thuần (không express); lỗi bất ngờ trả 500 và không ghi nội dung yêu cầu vào log. */
export function createServer(deps: ApiDeps): http.Server {
  const handle = createRouter(deps);
  return http.createServer((req, res) => {
    handle(req, res).catch((e: Error) => {
      console.error('[render] Lỗi xử lý yêu cầu:', e.message);
      if (res.headersSent) return void res.destroy();
      const data = JSON.stringify({ error: { code: 'INTERNAL', message: 'Lỗi máy chủ.' } });
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) });
      res.end(data);
    });
  });
}
