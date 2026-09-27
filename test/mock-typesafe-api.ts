// A local stand-in for a Jev-compatible server, so the app can be driven end
// to end without a key or a model. Answers with the same shape Jev does, using
// keyword spotting.
//
//   node --import tsx test/mock-typesafe-api.ts &
//   MODEL_URL=http://127.0.0.1:4010 npm start
//
// Real answers need a real model: this only proves the plumbing, not the model.

import http from 'node:http';
import { createStubClient } from './stub-client.js';

const stub = createStubClient();
const port = Number(process.env.MOCK_PORT ?? 4010);

http
  .createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.startsWith('/v1/systemone')) {
      res.writeHead(404).end('{}');
      return;
    }
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      try {
        const answer = await stub.systemOne(JSON.parse(body));
        res.writeHead(200, { 'content-type': 'application/json', 'x-typesafe-request-id': 'mock' });
        res.end(JSON.stringify(answer));
      } catch (error) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(error) }));
      }
    });
  })
  .listen(port, () => console.log(`mock TypeSafe API on http://127.0.0.1:${port}`));
