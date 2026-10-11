import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { code128Modules, decodeCode128 } from '@ccih/domain';
import { login, setupTestApp, teardown, type Session, type TestContext } from './helpers';

let ctx: TestContext;
const S: Record<string, Session> = {};
const REASON = 'Etiqueta danificada na manipulação do pacote';
const call = (s: Session, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown) =>
  ctx.app.inject({ method, url: `/api${path}`, headers: s.headers, ...(body !== undefined ? { payload: body as object } : {}) });

let layouts: Record<string, string>;
let pkgs: string[];
let rejected: string;
let asset: string;

beforeAll(async () => {
  ctx = await setupTestApp();
  for (const l of ['cme', 'tec.cme', 'aprendiz', 'enf.ccih', 'adm.cme']) S[l] = await login(ctx.app, l);
  const rows = await ctx.db.selectFrom('label_layout').select(['id', 'entity']).where('is_default', '=', true).execute();
  layouts = Object.fromEntries(rows.map((r) => [r.entity, r.id]));
  const items = (status: string) => ctx.db.selectFrom('load_item as i').innerJoin('sterilization_load as l', 'l.id', 'i.load_id').select('i.id').where('l.status', '=', status as 'liberada').orderBy('i.label_code').limit(4).execute();
  pkgs = (await items('liberada')).map((r) => r.id);
  rejected = (await items('rejeitada'))[0]!.id;
  asset = (await ctx.db.selectFrom('instrument_asset').select('id').limit(1).executeTakeFirstOrThrow()).id;
});
afterAll(async () => teardown(ctx));

const print = (s: Session, over: Record<string, unknown> = {}) =>
  call(s, 'POST', '/cme/labels/print', { entity: 'pacote', ids: [pkgs[0]], layoutId: layouts.pacote, output: 'navegador', mode: 'impressao', reason: null, ...over });

describe('labels', () => {
  it('prints a package label with the content read from the records, never patient data, and a code that decodes back', async () => {
    const res = await print(S['tec.cme']!);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const label = body.labels[0];
    const item = await ctx.db.selectFrom('load_item as i').innerJoin('sterilization_load as l', 'l.id', 'i.load_id').select(['i.label_code', 'i.expires_on', 'l.code']).where('i.id', '=', pkgs[0]!).executeTakeFirstOrThrow();
    expect(label.content).toMatchObject({ entity: 'pacote', code: item.label_code, lot: item.code, release: 'Liberada' });
    expect(label.content.expiresOn).toBe(String(item.expires_on).slice(0, 10));
    expect(Object.keys(label.content).sort()).toEqual(['code', 'entity', 'equipment', 'expiresOn', 'implant', 'lot', 'material', 'packaging', 'processedOn', 'release', 'setName']);
    expect(decodeCode128(code128Modules(label.content.code))).toBe(item.label_code);
    expect(body.prints[0]).toMatchObject({ kind: 'impressao', status: 'ativa', printedBy: expect.any(String), reason: null });
    const audit = await ctx.db.selectFrom('audit_log').select(['action', 'entity']).where('entity', '=', 'label_print').where('entity_id', '=', body.prints[0].id).executeTakeFirstOrThrow();
    expect(audit.action).toBe('print');
  });

  it('refuses a second print of a label in use; the reprint needs a reason and replaces the previous label', async () => {
    expect((await print(S['tec.cme']!)).statusCode).toBe(409);
    expect((await print(S['tec.cme']!, { mode: 'reimpressao' })).statusCode).toBe(400);
    const res = await print(S['tec.cme']!, { mode: 'reimpressao', reason: REASON });
    expect(res.statusCode).toBe(200);
    const history = (await call(S.cme!, 'GET', `/cme/labels?entity=pacote&entityId=${pkgs[0]}`)).json().prints;
    expect(history.map((p: { kind: string; status: string }) => `${p.kind}:${p.status}`)).toEqual(['reimpressao:ativa', 'impressao:substituida']);
    expect(history[0].reason).toBe(REASON);
    expect(history[1].replacedById).toBe(history[0].id);
    const audit = await ctx.db.selectFrom('audit_log').select(['action', 'context']).where('entity_id', '=', history[0].id).executeTakeFirstOrThrow();
    expect(audit.action).toBe('reprint');
    expect(JSON.stringify(audit.context)).toContain(REASON);
    // A reprint of something never printed is refused.
    expect((await print(S['tec.cme']!, { ids: [pkgs[1]], mode: 'reimpressao', reason: REASON })).statusCode).toBe(409);
  });

  it('cancels only the label in use, with a reason, by who records cycles; a cancelled label can be printed again', async () => {
    const [current] = (await call(S.cme!, 'GET', `/cme/labels?entity=pacote&entityId=${pkgs[0]}`)).json().prints;
    expect((await call(S.aprendiz!, 'POST', `/cme/labels/${current.id}/cancel`, { reason: REASON })).statusCode).toBe(403);
    expect((await call(S['tec.cme']!, 'POST', `/cme/labels/${current.id}/cancel`, { reason: 'curto' })).statusCode).toBe(400);
    const res = await call(S['tec.cme']!, 'POST', `/cme/labels/${current.id}/cancel`, { reason: REASON });
    expect(res.json()).toMatchObject({ status: 'cancelada', cancelReason: REASON });
    expect((await call(S['tec.cme']!, 'POST', `/cme/labels/${current.id}/cancel`, { reason: REASON })).statusCode).toBe(409);
    const [old] = (await call(S.cme!, 'GET', `/cme/labels?entity=pacote&entityId=${pkgs[0]}`)).json().prints.slice(-1);
    expect((await call(S['tec.cme']!, 'POST', `/cme/labels/${old.id}/cancel`, { reason: REASON })).statusCode).toBe(409);
    expect((await print(S['tec.cme']!)).statusCode).toBe(200);
  });

  it('keeps prints and cancellations: they cannot be changed or deleted', async () => {
    await expect(sql`UPDATE label_print SET code = 'X'`.execute(ctx.db)).rejects.toThrow();
    await expect(sql`DELETE FROM label_cancel`.execute(ctx.db)).rejects.toThrow();
  });

  it('prints a batch as ZPL with one label per record', async () => {
    const res = await print(S.cme!, { ids: pkgs.slice(1, 4), output: 'zpl' });
    expect(res.statusCode).toBe(200);
    const { zpl, labels } = res.json();
    expect(zpl.match(/\^XA/g)).toHaveLength(3);
    for (const l of labels) expect(zpl).toContain(l.content.code.slice(-6));
    expect(zpl).not.toMatch(/\^FD[^\n]*\^XA/);
  });

  it('refuses rejected loads, layouts of another kind, unknown records and users without printing permission', async () => {
    const r = await print(S.cme!, { ids: [rejected] });
    expect(r.statusCode).toBe(422);
    expect(r.json().message).toMatch(/nova etiqueta/);
    expect((await print(S.cme!, { layoutId: layouts.ativo })).statusCode).toBe(400);
    expect((await print(S.cme!, { ids: ['00000000-0000-0000-0000-000000000001'] })).statusCode).toBe(404);
    expect((await print(S['enf.ccih']!)).statusCode).toBe(403);
    expect((await call(S['enf.ccih']!, 'GET', '/cme/labels')).statusCode).toBe(200);
  });

  it('prints asset labels and lets the apprentice with CME recording print (not cancel)', async () => {
    const res = await print(S.aprendiz!, { entity: 'ativo', ids: [asset], layoutId: layouts.ativo });
    expect(res.statusCode).toBe(200);
    expect(res.json().labels[0].content.code).toMatch(/^AT-/);
  });

  it('manages layouts: only who configures the CME flow, with size checks and a single default per kind', async () => {
    const body = { name: 'Pacote 100×50', entity: 'pacote', widthMm: 100, heightMm: 50, marginMm: 3, dpi: 300, barHeightMm: 12, fields: ['validade', 'lote'], isDefault: true, active: true, rowVersion: null, justification: 'Nova impressora da CME (teste)' };
    expect((await call(S['tec.cme']!, 'POST', '/cme/label-layouts', body)).statusCode).toBe(403);
    expect((await call(S['enf.ccih']!, 'POST', '/cme/label-layouts', body)).statusCode).toBe(403);
    const small = await call(S['adm.cme']!, 'POST', '/cme/label-layouts', { ...body, name: 'Pequena', widthMm: 30 });
    expect(small.statusCode).toBe(400);
    expect(small.json().message).toMatch(/não cabe/);
    const ok = await call(S['adm.cme']!, 'POST', '/cme/label-layouts', body);
    expect(ok.statusCode).toBe(200);
    const defaults = await ctx.db.selectFrom('label_layout').select('name').where('entity', '=', 'pacote').where('is_default', '=', true).execute();
    expect(defaults.map((d) => d.name)).toEqual(['Pacote 100×50']);
    const changeKind = await call(S.cme!, 'PUT', `/cme/label-layouts/${ok.json().id}`, { ...body, entity: 'ativo', fields: ['identificacao'], rowVersion: ok.json().rowVersion });
    expect(changeKind.statusCode).toBe(400);
    const stale = await call(S.cme!, 'PUT', `/cme/label-layouts/${ok.json().id}`, { ...body, rowVersion: 99 });
    expect(stale.statusCode).toBe(409);
  });
});
