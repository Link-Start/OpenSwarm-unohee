import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage } from 'node:http';
import { handleGraphQL, isGraphQLTransportAuthorized } from './server.js';

function request(address: string | undefined, headers: Record<string, string> = {}): IncomingMessage {
  return { socket: { remoteAddress: address }, headers } as unknown as IncomingMessage;
}

afterEach(() => { delete process.env.OPENSWARM_GRAPHQL_TOKEN; });

describe('GraphQL transport authorization', () => {
  it('allows a proven loopback transport without trusting Origin', () => {
    expect(isGraphQLTransportAuthorized(request('127.0.0.1'))).toBe(true);
    expect(isGraphQLTransportAuthorized(request('::1'))).toBe(true);
  });

  it('rejects remote and Origin-less transports without a token', () => {
    expect(isGraphQLTransportAuthorized(request('100.64.1.2'))).toBe(false);
    expect(isGraphQLTransportAuthorized(request(undefined))).toBe(false);
  });

  it('allows a remote request with the configured bearer or explicit token', () => {
    process.env.OPENSWARM_GRAPHQL_TOKEN = 'secret';
    expect(isGraphQLTransportAuthorized(request('100.64.1.2', { authorization: 'Bearer secret' }))).toBe(true);
    expect(isGraphQLTransportAuthorized(request('10.0.0.2', { 'x-openswarm-graphql-token': 'secret' }))).toBe(true);
    expect(isGraphQLTransportAuthorized(request('10.0.0.2', { authorization: 'Bearer wrong' }))).toBe(false);
  });

  it('serves an authenticated GraphQL query through the Node HTTP adapter', async () => {
    process.env.OPENSWARM_GRAPHQL_TOKEN = 'secret';
    const httpServer = createServer((req, res) => { void handleGraphQL(req, res); });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    try {
      const address = httpServer.address();
      if (!address || typeof address === 'string') throw new Error('missing test server address');
      const response = await fetch(`http://127.0.0.1:${address.port}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
        body: JSON.stringify({ query: '{ __typename }' }),
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ data: { __typename: 'Query' } });
    } finally {
      await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
    }
  });
});
