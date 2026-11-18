import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serverOrigin } from './server-url.mjs';

test('accepts an HTTPS server address and keeps only its origin', () => {
  assert.equal(serverOrigin('https://ccih.escritorio.ts.net'), 'https://ccih.escritorio.ts.net');
  assert.equal(serverOrigin('https://ccih.exemplo.com.br/'), 'https://ccih.exemplo.com.br');
  assert.equal(serverOrigin('https://10.0.0.5:8443'), 'https://10.0.0.5:8443');
});

test('accepts plain HTTP only for this computer', () => {
  assert.equal(serverOrigin('http://localhost:5173'), 'http://localhost:5173');
  assert.throws(() => serverOrigin('http://192.168.0.10'), /https/);
});

test('refuses missing, malformed, credentialed or path addresses', () => {
  assert.throws(() => serverOrigin(undefined), /Defina/);
  assert.throws(() => serverOrigin('ccih'), /inválida/);
  assert.throws(() => serverOrigin('https://user:pw@ccih.exemplo.com.br'), /usuário/);
  assert.throws(() => serverOrigin('https://ccih.exemplo.com.br/app?x=1'), /sem caminho/);
});
