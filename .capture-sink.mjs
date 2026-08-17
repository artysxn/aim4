// TEMP: tiny sink so the page can hand rendered frames to disk without
// round-tripping them through the agent's context.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const OUT = 'D:/Dev/claude/aim-trainer/.shots';
fs.mkdirSync(OUT, { recursive: true });

http
  .createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.end();
    const name = (new URL(req.url, 'http://x').searchParams.get('name') || 'shot').replace(/[^\w.-]/g, '_');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const b64 = body.replace(/^data:image\/\w+;base64,/, '');
      const file = path.join(OUT, name + (body.startsWith('data:image/jpeg') ? '.jpg' : '.png'));
      fs.writeFileSync(file, Buffer.from(b64, 'base64'));
      console.log('wrote', file, fs.statSync(file).size);
      res.end('ok');
    });
  })
  .listen(5199, () => console.log('sink on 5199 ->', OUT));
