import dgram from 'node:dgram';
import http from 'node:http';

let privateAnswer = false;
const counts = { publicRequests: 0, privateRequests: 0, edgePrivateAnswers: 0 };

// One closed, controlled DNS zone; there is no upstream DNS forwarder.
const dns = dgram.createSocket('udp4');
dns.on('message', (query, remote) => {
  if (query.length < 17 || query.readUInt16BE(4) !== 1) return;
  let offset = 12;
  const labels = [];
  while (offset < query.length && query[offset] !== 0) {
    const length = query[offset++];
    if (length > 63 || offset + length >= query.length) return;
    labels.push(query.subarray(offset, offset + length).toString('ascii'));
    offset += length;
  }
  if (offset + 5 > query.length) return;
  offset += 1;
  const type = query.readUInt16BE(offset);
  const klass = query.readUInt16BE(offset + 2);
  const question = query.subarray(12, offset + 4);
  const known = labels.join('.').toLowerCase() === 'rebind.fixture.test';
  const answer = known && type === 1 && klass === 1;
  const header = Buffer.alloc(12);
  query.copy(header, 0, 0, 2);
  header.writeUInt16BE(known ? 0x8180 : 0x8183, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(answer ? 1 : 0, 6);
  const record = Buffer.from([
    0xc0,
    0x0c,
    0,
    1,
    0,
    1,
    0,
    0,
    0,
    1,
    0,
    4,
    privateAnswer ? 10 : 11,
    203,
    0,
    10,
  ]);
  if (answer && privateAnswer && remote.address === '10.203.0.20') {
    counts.edgePrivateAnswers += 1;
  }
  dns.send(
    Buffer.concat([header, question, ...(answer ? [record] : [])]),
    remote.port,
    remote.address,
  );
});
dns.bind(53, '10.203.0.10');

for (const [address, counter, marker] of [
  ['11.203.0.10', 'publicRequests', 'controlled-public'],
  ['10.203.0.10', 'privateRequests', 'PRIVATE-CANARY'],
]) {
  http
    .createServer((_request, response) => {
      counts[counter] += 1;
      // Close at the upstream, so every subsequent data-plane request needs a socket.
      response.writeHead(200, { connection: 'close', 'x-fixture': marker });
      response.end(marker);
    })
    .listen(9100, address);
}

http
  .createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/rebind') privateAnswer = true;
    if (request.url !== '/stats' && request.url !== '/rebind') {
      response.writeHead(404).end();
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ...counts, privateAnswer }));
  })
  .listen(9101, '10.203.0.10');
