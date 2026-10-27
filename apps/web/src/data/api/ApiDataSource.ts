import type { FactRow, InstitutionData, WithProvenance } from '@ccih/domain';
import type { AdminPort, AuthPort, CcihDataSource, ClinicalPort, CmePort, ConsultingPort, FactsQuery, InboxPort, RealtimePort, OperationsPort, OrgAdminPort, SessionInfo } from '../port';
import { createHttpClient, type HttpClient } from './http';

/** Backend source: every authorization decision is taken by the API; the UI only reflects it. */
export class ApiDataSource implements CcihDataSource {
  readonly origin = 'real' as const;
  readonly auth: AuthPort;
  readonly admin: AdminPort;
  readonly clinical: ClinicalPort;
  readonly orgAdmin: OrgAdminPort;
  readonly operations: OperationsPort;
  readonly cme: CmePort;
  readonly inbox: InboxPort;
  readonly consulting: ConsultingPort;
  readonly realtime: RealtimePort;
  private readonly http: HttpClient;

  constructor(base = '/api', onUnauthorized: () => void = () => {}) {
    this.http = createHttpClient(base, () => onUnauthorized());
    const http = this.http;
    this.auth = {
      me: async () => {
        const r = await http.get<(SessionInfo & { authenticated: true }) | { authenticated: false }>('/auth/me');
        return r.authenticated ? r : null;
      },
      login: async (login, password) => { await http.send('POST', '/auth/login', { login, password }); },
      logout: async () => { await http.send('POST', '/auth/logout'); },
      changePassword: async (currentPassword, newPassword) => { await http.send('POST', '/auth/password', { currentPassword, newPassword }); },
    };
    const ok = async (p: Promise<unknown>) => { await p; };
    this.admin = {
      versions: () => http.get('/config/versions'),
      saveTarget: (id, input) => ok(http.send('PUT', `/config/targets/${encodeURIComponent(id)}`, input)),
      deleteTarget: (id, justification) => ok(http.send('DELETE', `/config/targets/${encodeURIComponent(id)}`, { justification })),
      saveRule: (key, input) => ok(http.send('PUT', `/config/rules/${encodeURIComponent(key)}`, input)),
      createReference: (input) => ok(http.send('POST', '/config/references', input)),
      updateReference: (id, input) => ok(http.send('PUT', `/config/references/${encodeURIComponent(id)}`, input)),
      validateReference: (id, input) => ok(http.send('POST', `/config/references/${encodeURIComponent(id)}/validate`, input)),
      savePolicy: (input) => ok(http.send('PUT', '/config/load-release-policy', input)),
      users: (q) => http.get('/users', q),
      usersMeta: () => http.get('/users/meta'),
      userHistory: (uid) => http.get(`/users/${encodeURIComponent(uid)}/history`),
      roles: () => http.get('/roles'),
      updateUser: (uid, input) => ok(http.send('PUT', `/users/${encodeURIComponent(uid)}`, input)),
      unlockUser: (id) => ok(http.send('POST', `/users/${encodeURIComponent(id)}/unlock`)),
      audit: (q) => http.get('/audit', q),
      verifyAudit: () => http.get('/audit/verify'),
      logExport: (event) => ok(http.send('POST', '/audit/events/export', event)),
      createUser: (input) => http.send('POST', '/users', input),
      resetPassword: (uid, justification) => http.send('POST', `/users/${encodeURIComponent(uid)}/reset-password`, { justification }),
    };
    const id = (v: string) => encodeURIComponent(v);
    this.clinical = {
      org: () => http.get('/org'),
      patients: (q) => http.get('/patients', q),
      patient: (p) => http.get(`/patients/${id(p)}`),
      createPatient: (input) => http.send('POST', '/patients', input),
      updatePatient: (p, input) => ok(http.send('PUT', `/patients/${id(p)}`, input)),
      revealName: (p, reason) => http.send('POST', `/patients/${id(p)}/reveal`, { reason }),
      admit: (p, input) => http.send('POST', `/patients/${id(p)}/admissions`, input),
      transfer: (a, input) => ok(http.send('POST', `/admissions/${id(a)}/transfer`, input)),
      discharge: (a, input) => http.send('POST', `/admissions/${id(a)}/discharge`, input),
      addDevice: (a, input) => ok(http.send('POST', `/admissions/${id(a)}/devices`, input)),
      removeDevice: (d, input) => ok(http.send('POST', `/devices/${id(d)}/remove`, input)),
      addNote: (p, input) => ok(http.send('POST', `/patients/${id(p)}/notes`, input)),
      amendNote: (n, input) => ok(http.send('POST', `/notes/${id(n)}/amend`, input)),
      census: (date) => http.get('/census', { date }),
      censusMonth: (month) => http.get('/census/month', { month }),
      cases: (q) => http.get('/iras', q),
      case: (c) => http.get(`/iras/${id(c)}`),
      createCase: (input) => http.send('POST', '/iras', input),
      updateCase: (c, input) => ok(http.send('PUT', `/iras/${id(c)}`, input)),
      changeCaseStatus: (c, input) => http.send('POST', `/iras/${id(c)}/status`, input),
      surgeries: (q) => http.get('/surgeries', q),
      surgery: (sid) => http.get(`/surgeries/${id(sid)}`),
      createSurgery: (input) => http.send('POST', '/surgeries', input),
      updateSurgery: (sid, input) => ok(http.send('PUT', `/surgeries/${id(sid)}`, input)),
      professionals: () => http.get('/professionals'),
      procedures: () => http.get('/procedures'),
      cultures: (q) => http.get('/cultures', q),
      culture: (c) => http.get(`/cultures/${id(c)}`),
      createCulture: (input) => http.send('POST', '/cultures', input),
      addCultureResult: (c, input) => http.send('POST', `/cultures/${id(c)}/results`, input),
      consolidate: (months) => http.send('POST', '/facts/consolidate', { months }),
    };
    this.orgAdmin = {
      createUnit: (input) => ok(http.send('POST', '/org/units', input)),
      updateUnit: (u, input) => ok(http.send('PUT', `/org/units/${id(u)}`, input)),
      createSector: (input) => ok(http.send('POST', '/org/sectors', input)),
      updateSector: (sid, input) => ok(http.send('PUT', `/org/sectors/${id(sid)}`, input)),
      addBeds: (sid, input) => ok(http.send('POST', `/org/sectors/${id(sid)}/beds`, input)),
      updateBed: (b, input) => ok(http.send('PUT', `/org/beds/${id(b)}`, input)),
    };
    this.cme = {
      overview: () => http.get('/cme/overview'),
      sterilizers: () => http.get('/cme/sterilizers'),
      saveSterilizer: (sid, input) => ok(sid ? http.send('PUT', `/cme/sterilizers/${id(sid)}`, input) : http.send('POST', '/cme/sterilizers', input)),
      sets: () => http.get('/cme/sets'),
      saveSet: (sid, input) => ok(sid ? http.send('PUT', `/cme/sets/${id(sid)}`, input) : http.send('POST', '/cme/sets', input)),
      loads: (q) => http.get('/cme/loads', q),
      load: (l) => http.get(`/cme/loads/${id(l)}`),
      createLoad: (input) => http.send('POST', '/cme/loads', input),
      finishCycle: (l, input) => ok(http.send('POST', `/cme/loads/${id(l)}/cycle`, input)),
      decide: (l, input) => ok(http.send('POST', `/cme/loads/${id(l)}/decision`, input)),
      bowieDick: (from, to) => http.get('/cme/bowie-dick', { from, to }),
      createTest: (input) => http.send('POST', '/cme/tests', input),
      replaceTest: (t, input) => http.send('POST', `/cme/tests/${id(t)}/replace`, input),
      trace: (q) => http.get('/cme/trace', { q }),
      addSurgeryMaterial: (sid, input) => http.send('POST', `/surgeries/${id(sid)}/materials`, input),
      addLooseUse: (input) => http.send('POST', '/cme/uses', input),
      voidUse: (u, justification) => ok(http.send('POST', `/material-uses/${id(u)}/void`, { justification })),
      upload: (entity, entityId, file) => http.upload(`/attachments?entity=${entity}&entityId=${id(entityId)}`, file),
      attachmentUrl: (a) => `${base}/attachments/${id(a)}`,
      attachmentPolicy: () => http.get('/attachments/policy'),
      rescanAttachment: (a) => http.send('POST', `/attachments/${id(a)}/scan`, {}),
      startCycle: (l, input) => ok(http.send('POST', `/cme/loads/${id(l)}/start`, input)),
      sectors: () => http.get('/cme/sectors'),
      flowConfig: () => http.get('/cme/flow-config'),
      saveFlowConfig: (input) => ok(http.send('PUT', '/cme/flow-config', input)),
      stations: () => http.get('/cme/stations'),
      saveStation: (sid, input) => ok(sid ? http.send('PUT', `/cme/stations/${id(sid)}`, input) : http.send('POST', '/cme/stations', input)),
      pairStation: (sid, label) => http.send('POST', `/cme/stations/${id(sid)}/pair`, { label }),
      revokeDevice: (d) => ok(http.send('POST', `/cme/stations/devices/${id(d)}/revoke`, {})),
      thisStation: () => http.get('/cme/stations/this'),
      assets: (q) => http.get('/cme/assets', q),
      createAssets: (input) => http.send('POST', '/cme/assets', input),
      updateAsset: (a, input) => ok(http.send('PUT', `/cme/assets/${id(a)}`, input)),
      scan: (input) => http.send('POST', '/cme/scan', input),
      receiveLoose: (input) => http.send('POST', '/cme/processes/loose', input),
      processes: (q) => http.get('/cme/processes', q),
      process: (p) => http.get(`/cme/processes/${id(p)}`),
      scanEvents: (q) => http.get('/cme/scan-events', q),
      labelLayouts: () => http.get('/cme/label-layouts'),
      saveLabelLayout: (lid, input) => (lid ? http.send('PUT', `/cme/label-layouts/${id(lid)}`, input) : http.send('POST', '/cme/label-layouts', input)),
      labelPrints: (q) => http.get('/cme/labels', q),
      printLabels: (input) => http.send('POST', '/cme/labels/print', input),
      cancelLabel: (l, reason) => http.send('POST', `/cme/labels/${id(l)}/cancel`, { reason }),
    };
    this.realtime = { config: () => http.get('/realtime'), eventsUrl: `${base}/events` };
    this.consulting = {
      clients: (q) => http.get('/consulting/clients', q),
      client: (c) => http.get(`/consulting/clients/${id(c)}`),
      saveClient: (c, input) => (c ? http.send('PUT', `/consulting/clients/${id(c)}`, input) : http.send('POST', '/consulting/clients', input)),
      saveContact: (c, contact, input) => (contact ? http.send('PUT', `/consulting/contacts/${id(contact)}`, input) : http.send('POST', `/consulting/clients/${id(c)}/contacts`, input)),
      saveEstablishment: (c, e, input) => (e ? http.send('PUT', `/consulting/establishments/${id(e)}`, input) : http.send('POST', `/consulting/clients/${id(c)}/establishments`, input)),
      saveUnit: (e, u, input) => (u ? http.send('PUT', `/consulting/units/${id(u)}`, input) : http.send('POST', `/consulting/establishments/${id(e)}/units`, input)),
      assign: (c, input) => http.send('POST', `/consulting/clients/${id(c)}/assignments`, input),
      endAssignment: (a, input) => http.send('POST', `/consulting/assignments/${id(a)}/end`, input),
      addEvent: (c, input) => http.send('POST', `/consulting/clients/${id(c)}/events`, input),
      team: () => http.get('/consulting/team'),
      contracts: (q) => http.get('/consulting/contracts', q),
      contract: (k) => http.get(`/consulting/contracts/${id(k)}`),
      saveProposal: (c, k, input) => (k ? http.send('PUT', `/consulting/contracts/${id(k)}`, input) : http.send('POST', `/consulting/clients/${id(c!)}/contracts`, input)),
      setContractStatus: (k, input) => http.send('POST', `/consulting/contracts/${id(k)}/status`, input),
      addAmendment: (k, input) => http.send('POST', `/consulting/contracts/${id(k)}/amendments`, input),
      addDelivery: (s, input) => http.send('POST', `/consulting/contract-services/${id(s)}/deliveries`, input),
      voidDelivery: (d, reason) => http.send('POST', `/consulting/contract-deliveries/${id(d)}/void`, { reason }),
      saveFinancial: (k, input) => http.send('PUT', `/consulting/contracts/${id(k)}/financial`, input),
    };
    this.inbox = {
      notifications: (q) => http.get(`/me/notifications?situacao=${q.situacao}`),
      markRead: (n) => ok(http.send('POST', `/me/notifications/${id(n)}/read`)),
      markAllRead: () => ok(http.send('POST', '/me/notifications/read-all')),
    };
    this.operations = {
      bundleTemplates: () => http.get('/bundles/templates'),
      saveBundleTemplate: (input) => ok(http.send('PUT', '/bundles/templates', input)),
      bundleAudits: (q) => http.get('/bundles/audits', q),
      createBundleAudit: (input) => http.send('POST', '/bundles/audits', input),
      voidBundleAudit: (a, reason) => ok(http.send('POST', `/bundles/audits/${id(a)}/void`, { reason })),
      bundleSummary: (q) => http.get('/bundles/summary', q),
      handHygiene: (q) => http.get('/hand-hygiene', q),
      createHandHygiene: (input) => ok(http.send('POST', '/hand-hygiene', input)),
      voidHandHygiene: (h, reason) => ok(http.send('POST', `/hand-hygiene/${id(h)}/void`, { reason })),
      qualityAudits: () => http.get('/quality/audits'),
      qualityAudit: (a) => http.get(`/quality/audits/${id(a)}`),
      createQualityAudit: (input) => http.send('POST', '/quality/audits', input),
      updateQualityAudit: (a, input) => ok(http.send('PUT', `/quality/audits/${id(a)}`, input)),
      changeAuditStatus: (a, input) => ok(http.send('POST', `/quality/audits/${id(a)}/status`, input)),
      nonconformities: (status) => http.get('/quality/nonconformities', { status }),
      nonconformity: (n) => http.get(`/quality/nonconformities/${id(n)}`),
      createNonconformity: (input) => http.send('POST', '/quality/nonconformities', input),
      changeNcStatus: (n, input) => ok(http.send('POST', `/quality/nonconformities/${id(n)}/status`, input)),
      addAction: (n, input) => ok(http.send('POST', `/quality/nonconformities/${id(n)}/actions`, input)),
      changeActionStatus: (a, input) => ok(http.send('POST', `/quality/actions/${id(a)}/status`, input)),
      alerts: (q) => http.get('/alerts', q),
      alertSummary: () => http.get('/alerts/summary'),
      refreshAlerts: () => http.send('POST', '/alerts/refresh'),
      assumeAlert: (a, rowVersion) => ok(http.send('POST', `/alerts/${id(a)}/assume`, { rowVersion })),
      closeAlert: (a, resolution, rowVersion) => ok(http.send('POST', `/alerts/${id(a)}/close`, { resolution, rowVersion })),
      alert: (a) => http.get(`/alerts/${id(a)}`),
      acknowledgeAlert: (a, rowVersion) => ok(http.send('POST', `/alerts/${id(a)}/acknowledge`, { rowVersion })),
      resolveAlert: (a, note, rowVersion) => ok(http.send('POST', `/alerts/${id(a)}/resolve`, { note, rowVersion })),
      alertException: (a, note, rowVersion) => ok(http.send('POST', `/alerts/${id(a)}/exception`, { note, rowVersion })),
      commentAlert: (a, note) => ok(http.send('POST', `/alerts/${id(a)}/comments`, { note })),
      staff: () => http.get('/staff'),
      createStaff: (input) => ok(http.send('POST', '/staff', input)),
      trainings: () => http.get('/trainings'),
      trainingCoverage: () => http.get('/trainings/coverage'),
      saveTraining: (input) => ok(http.send('PUT', '/trainings', input)),
      createSession: (t, input) => ok(http.send('POST', `/trainings/${id(t)}/sessions`, input)),
      supplies: () => http.get('/supplies'),
      supplyMovements: (s) => http.get(`/supplies/${id(s)}/movements`),
      saveSupply: (input) => ok(http.send('PUT', '/supplies', input)),
      addMovement: (s, input) => ok(http.send('POST', `/supplies/${id(s)}/movements`, input)),
      surveillance: (pending) => http.get('/surgeries/surveillance', { pending: pending ? '1' : undefined }),
      addFollowup: (s, input) => http.send('POST', `/surgeries/${id(s)}/followups`, input),
    };
  }

  getInstitution(): Promise<WithProvenance<InstitutionData>> {
    return this.http.get('/institution');
  }

  getFacts(query: FactsQuery): Promise<WithProvenance<{ rows: FactRow[] }>> {
    return this.http.get('/facts', { from: query.from, to: query.to });
  }
}
