import { SdcpClient, type SocketLike } from '@cthulhu/sdcp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createFakePrinter, type FakePrinter } from './server.js';

const socketFactory = (url: string) => new WebSocket(url) as unknown as SocketLike;

let printer: FakePrinter;
let client: SdcpClient;

beforeEach(async () => {
  printer = await createFakePrinter({ discovery: false, statusIntervalMs: 1000 });
  client = new SdcpClient({
    address: '127.0.0.1',
    port: printer.wsPort,
    mainboardId: printer.mainboardId,
    socketFactory,
  });
  await client.connect();
});

afterEach(async () => {
  client.close();
  await printer.close();
});

describe('Cmd 386 — enable video', () => {
  it('returns the stream URL rather than it being configured', async () => {
    // The official spec has the printer hand back a VideoUrl; there is no
    // fixed path to point configuration at. An earlier version guessed
    // http://{ip}:3031/video, which was wrong.
    const url = await client.enableVideo();
    expect(url).toMatch(/^https?:\/\/127\.0\.0\.1:\d+\/video$/);
  });

  it('refuses with the documented reason when the stream limit is reached', async () => {
    // Ack 1 is "exceeded maximum simultaneous streaming limit". Reporting it
    // as a bare failure loses the one piece of information that tells the
    // operator to close the Elegoo app.
    await client.enableVideo();

    const second = new SdcpClient({
      address: '127.0.0.1',
      port: printer.wsPort,
      mainboardId: printer.mainboardId,
      socketFactory,
    });
    await second.connect();
    // Hold the single slot by actually consuming the stream.
    const res = await fetch(`http://127.0.0.1:${printer.wsPort}/video`);
    await new Promise((r) => setTimeout(r, 150));

    await expect(second.enableVideo()).rejects.toThrow(/maximum simultaneous streaming/);

    await res.body?.cancel();
    second.close();
  });

  it('disabling the stream is acknowledged', async () => {
    await client.enableVideo();
    await expect(client.setVideoStream(false)).resolves.toBeDefined();
  });
});
