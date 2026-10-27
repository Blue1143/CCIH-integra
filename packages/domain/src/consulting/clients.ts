import { cnpjProblem } from '../organization';
import type { FieldProblem } from '../users';

/**
 * Consulting portfolio: clients (the healthcare organizations a consultancy serves), their contacts,
 * establishments and units, and which consultants answer for each client. Clients are records of the
 * consultancy; no patient data lives here.
 */
export type ClientStatus = 'prospecto' | 'ativo' | 'suspenso' | 'encerrado';
export const CLIENT_STATUS_LABEL: Record<ClientStatus, string> = { prospecto: 'Prospecto', ativo: 'Ativo', suspenso: 'Suspenso', encerrado: 'Encerrado' };

export type EstablishmentKind = 'hospital' | 'clinica' | 'ambulatorio' | 'pronto_atendimento' | 'ubs' | 'laboratorio' | 'servico_imagem' | 'home_care' | 'ilpi' | 'odontologia' | 'outro';
export const ESTABLISHMENT_KIND_LABEL: Record<EstablishmentKind, string> = {
  hospital: 'Hospital', clinica: 'Clínica', ambulatorio: 'Ambulatório', pronto_atendimento: 'Pronto atendimento / UPA', ubs: 'Unidade básica de saúde', laboratorio: 'Laboratório',
  servico_imagem: 'Serviço de imagem', home_care: 'Atenção domiciliar', ilpi: 'Instituição de longa permanência', odontologia: 'Serviço odontológico', outro: 'Outro',
};

export type ContactKind = 'responsavel_tecnico' | 'responsavel_administrativo' | 'contato_autorizado';
export const CONTACT_KIND_LABEL: Record<ContactKind, string> = { responsavel_tecnico: 'Responsável técnico', responsavel_administrativo: 'Responsável administrativo', contato_autorizado: 'Contato autorizado' };

export type UnitKind = 'uti_adulto' | 'uti_pediatrica' | 'uti_neonatal' | 'internacao' | 'centro_cirurgico' | 'cme' | 'emergencia' | 'ambulatorio' | 'hemodialise' | 'apoio' | 'outro';
export const UNIT_KIND_LABEL: Record<UnitKind, string> = {
  uti_adulto: 'UTI adulto', uti_pediatrica: 'UTI pediátrica', uti_neonatal: 'UTI neonatal', internacao: 'Internação', centro_cirurgico: 'Centro cirúrgico', cme: 'CME', emergencia: 'Emergência',
  ambulatorio: 'Ambulatório', hemodialise: 'Hemodiálise', apoio: 'Apoio / administrativo', outro: 'Outro',
};

export type AssignmentRole = 'responsavel' | 'apoio';
export const ASSIGNMENT_ROLE_LABEL: Record<AssignmentRole, string> = { responsavel: 'Consultor responsável', apoio: 'Consultor de apoio' };
export type Specialty = 'ccih' | 'cme' | 'qualidade' | 'seguranca_paciente' | 'gestao';
export const SPECIALTY_LABEL: Record<Specialty, string> = { ccih: 'CCIH / IRAS', cme: 'CME', qualidade: 'Qualidade', seguranca_paciente: 'Segurança do paciente', gestao: 'Gestão' };

export type ClientEventKind = 'cadastro' | 'alteracao' | 'atribuicao' | 'substituicao' | 'encerramento_atribuicao' | 'atendimento' | 'observacao' | 'contrato';
export const CLIENT_EVENT_LABEL: Record<ClientEventKind, string> = {
  cadastro: 'Cadastro', alteracao: 'Alteração do cadastro', atribuicao: 'Consultor atribuído', substituicao: 'Consultor substituído', encerramento_atribuicao: 'Atribuição encerrada',
  atendimento: 'Atendimento', observacao: 'Observação', contrato: 'Contrato',
};
/** Events a person registers by hand (the others are written by the system when something changes). */
export const MANUAL_CLIENT_EVENTS: ClientEventKind[] = ['atendimento', 'observacao'];

export const UF = ['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'] as const;
export type Uf = (typeof UF)[number];

export interface Address { street: string | null; number: string | null; district: string | null; city: string | null; state: Uf | null; zip: string | null }

export interface ClientInput {
  legalName: string; tradeName: string | null; cnpj: string | null; kind: EstablishmentKind; status: ClientStatus;
  email: string | null; phone: string | null; address: Address; servicesSummary: string | null;
}
export interface ContactInput { kind: ContactKind; name: string; roleTitle: string | null; registry: string | null; email: string | null; phone: string | null; active: boolean }
export interface EstablishmentInput { name: string; cnes: string | null; cnpj: string | null; kind: EstablishmentKind; beds: number | null; address: Address; active: boolean }
export interface UnitInput { name: string; kind: UnitKind; beds: number | null; active: boolean }


const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const digits = (s: string) => s.replace(/\D/g, '');

function addressProblems(a: Address, prefix = 'address.'): FieldProblem[] {
  const p: FieldProblem[] = [];
  if (a.zip && digits(a.zip).length !== 8) p.push({ path: `${prefix}zip`, message: 'CEP deve ter 8 dígitos.' });
  if (a.state && !(UF as readonly string[]).includes(a.state)) p.push({ path: `${prefix}state`, message: 'UF inválida.' });
  return p;
}

const contactProblems = (email: string | null, phone: string | null): FieldProblem[] => {
  const p: FieldProblem[] = [];
  if (email && !EMAIL.test(email)) p.push({ path: 'email', message: 'E-mail inválido.' });
  if (phone && (digits(phone).length < 10 || digits(phone).length > 13)) p.push({ path: 'phone', message: 'Telefone com DDD: 10 a 13 dígitos.' });
  return p;
};

export function checkClient(c: ClientInput): FieldProblem[] {
  const p: FieldProblem[] = [];
  if (c.legalName.trim().length < 3) p.push({ path: 'legalName', message: 'Informe a razão social (mínimo 3 caracteres).' });
  if (c.cnpj) {
    const problem = cnpjProblem(c.cnpj);
    if (problem) p.push({ path: 'cnpj', message: problem });
  }
  return [...p, ...contactProblems(c.email, c.phone), ...addressProblems(c.address)];
}

export function checkContact(c: ContactInput): FieldProblem[] {
  const p: FieldProblem[] = [];
  if (c.name.trim().length < 3) p.push({ path: 'name', message: 'Informe o nome (mínimo 3 caracteres).' });
  if (!c.email && !c.phone) p.push({ path: 'email', message: 'Informe ao menos um e-mail ou telefone.' });
  return [...p, ...contactProblems(c.email, c.phone)];
}

export function checkEstablishment(e: EstablishmentInput): FieldProblem[] {
  const p: FieldProblem[] = [];
  if (e.name.trim().length < 3) p.push({ path: 'name', message: 'Informe o nome do estabelecimento.' });
  if (e.cnes && !/^\d{7}$/.test(digits(e.cnes))) p.push({ path: 'cnes', message: 'CNES deve ter 7 dígitos.' });
  if (e.cnpj) {
    const problem = cnpjProblem(e.cnpj);
    if (problem) p.push({ path: 'cnpj', message: problem });
  }
  if (e.beds != null && (!Number.isInteger(e.beds) || e.beds < 0 || e.beds > 5000)) p.push({ path: 'beds', message: 'Leitos: número inteiro de 0 a 5000.' });
  return [...p, ...addressProblems(e.address)];
}

export function checkUnit(u: UnitInput): FieldProblem[] {
  const p: FieldProblem[] = [];
  if (u.name.trim().length < 2) p.push({ path: 'name', message: 'Informe o nome da unidade ou setor.' });
  if (u.beds != null && (!Number.isInteger(u.beds) || u.beds < 0 || u.beds > 1000)) p.push({ path: 'beds', message: 'Leitos: número inteiro de 0 a 1000.' });
  return p;
}

/* ---------- Access to a client ---------- */

/** Which clients a person of the consultancy may see: every client (null) or only the ones assigned to them. */
export type ClientScope = string[] | null;
export const clientInScope = (scope: ClientScope, clientId: string) => scope === null || scope.includes(clientId);

/* ---------- DTOs ---------- */

export interface ClientSummaryDto {
  id: string; legalName: string; tradeName: string | null; cnpj: string | null; kind: EstablishmentKind; status: ClientStatus; city: string | null; state: Uf | null;
  establishments: number; responsible: { userId: string; name: string } | null; consultants: number; updatedAt: string; dataOrigin: 'real' | 'demo';
}
export interface ContactDto extends ContactInput { id: string; rowVersion: number }
export interface UnitDto extends UnitInput { id: string; rowVersion: number }
export interface EstablishmentDto extends EstablishmentInput { id: string; units: UnitDto[]; rowVersion: number }
export interface AssignmentDto {
  id: string; userId: string; userName: string; role: AssignmentRole; specialty: Specialty | null; startsOn: string; endsOn: string | null;
  assignedBy: string; reason: string; endedBy: string | null; endReason: string | null;
}
export interface ClientEventDto { id: string; kind: ClientEventKind; summary: string; detail: string | null; occurredOn: string; by: string; at: string }
export interface ClientDetailDto extends ClientInput {
  id: string; rowVersion: number; createdAt: string; updatedAt: string; dataOrigin: 'real' | 'demo';
  /** Present only for profiles allowed to see the internal administrative notes. */
  internalNotes?: string | null;
  contacts: ContactDto[]; establishments: EstablishmentDto[]; assignments: AssignmentDto[]; events: ClientEventDto[];
}
export interface TeamMemberDto { userId: string; name: string; login: string; roles: string[]; active: boolean; clients: Array<{ clientId: string; clientName: string; role: AssignmentRole; specialty: Specialty | null }> }
