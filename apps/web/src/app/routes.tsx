import { lazy, Suspense, type ReactElement } from 'react';
import type { RouteObject } from 'react-router-dom';
import type { Permission } from '@ccih/domain';
import { LoadingState } from '@ccih/ui';
import { AppShell } from './AppShell';
import { ALL_NAV_ITEMS } from './navigation';
import { DashboardPage } from '../features/dashboard/DashboardPage';
import { NotFoundPage, PlannedModulePage } from '../features/modules/PlannedModulePage';
import { LoginPage } from '../features/auth/LoginPage';
import { Guard, HomeRoute, NavGuard, RequireSession } from '../features/auth/guards';

const named = <K extends string>(load: () => Promise<Record<K, () => ReactElement | null>>, name: K) => lazy(() => load().then((m) => ({ default: m[name] })));
const ConsultingHomePage = named(() => import('../features/consulting/ConsultingHomePage'), 'ConsultingHomePage');
const ClientsPage = named(() => import('../features/consulting/ClientsPage'), 'ClientsPage');
const ClientDetailPage = named(() => import('../features/consulting/ClientDetailPage'), 'ClientDetailPage');
const TeamPage = named(() => import('../features/consulting/TeamPage'), 'TeamPage');
const ContractsPage = named(() => import('../features/consulting/ContractsPage'), 'ContractsPage');
const ContractDetailPage = named(() => import('../features/consulting/ContractDetailPage'), 'ContractDetailPage');
const IndicatorsPage = named(() => import('../features/indicators/IndicatorsPage'), 'IndicatorsPage');
const AdminLayout = named(() => import('../features/admin/AdminLayout'), 'AdminLayout');
const AdminIndex = named(() => import('../features/admin/AdminLayout'), 'AdminIndex');
const TargetsPage = named(() => import('../features/admin/TargetsPage'), 'TargetsPage');
const ParametersPage = named(() => import('../features/admin/ParametersPage'), 'ParametersPage');
const ReferencesPage = named(() => import('../features/admin/ReferencesPage'), 'ReferencesPage');
const CmePolicyPage = named(() => import('../features/admin/CmePolicyPage'), 'CmePolicyPage');
const UsersPage = named(() => import('../features/admin/UsersPage'), 'UsersPage');
const AuditPage = named(() => import('../features/admin/AuditPage'), 'AuditPage');
const OrgPage = named(() => import('../features/admin/OrgPage'), 'OrgPage');
const PatientsPage = named(() => import('../features/clinical/PatientsPage'), 'PatientsPage');
const PatientDetailPage = named(() => import('../features/clinical/PatientDetailPage'), 'PatientDetailPage');
const IrasListPage = named(() => import('../features/clinical/IrasPages'), 'IrasListPage');
const IrasCasePage = named(() => import('../features/clinical/IrasPages'), 'IrasCasePage');
const SurgeriesPage = named(() => import('../features/clinical/SurgeryPages'), 'SurgeriesPage');
const SurgeryPage = named(() => import('../features/clinical/SurgeryPages'), 'SurgeryPage');
const CulturesPage = named(() => import('../features/clinical/MicroPages'), 'CulturesPage');
const CulturePage = named(() => import('../features/clinical/MicroPages'), 'CulturePage');
const CensusPage = named(() => import('../features/clinical/CensusPage'), 'CensusPage');
const BundlesPage = named(() => import('../features/operations/BundlesPage'), 'BundlesPage');
const AuditsPage = named(() => import('../features/operations/AuditsPages'), 'AuditsPage');
const AuditDetailPage = named(() => import('../features/operations/AuditsPages'), 'AuditDetailPage');
const NcDetailPage = named(() => import('../features/operations/AuditsPages'), 'NcDetailPage');
const TrainingsPage = named(() => import('../features/operations/TrainingsPage'), 'TrainingsPage');
const SuppliesPage = named(() => import('../features/operations/SuppliesPage'), 'SuppliesPage');
const AlertsPage = named(() => import('../features/operations/AlertsPage'), 'AlertsPage');
const AlertDetailPage = named(() => import('../features/operations/AlertsPage'), 'AlertDetailPage');
const CmePage = named(() => import('../features/cme/CmePage'), 'CmePage');
const LoadDetailPage = named(() => import('../features/cme/LoadDetailPage'), 'LoadDetailPage');
const BowieDickPage = named(() => import('../features/cme/EquipmentPages'), 'BowieDickPage');
const EquipmentPage = named(() => import('../features/cme/EquipmentPages'), 'EquipmentPage');
const SetsPage = named(() => import('../features/cme/EquipmentPages'), 'SetsPage');
const StationPage = named(() => import('../features/cme/StationPage'), 'StationPage');
const ProcessesPage = named(() => import('../features/cme/ProcessPages'), 'ProcessesPage');
const ProcessDetailPage = named(() => import('../features/cme/ProcessPages'), 'ProcessDetailPage');
const FlowSetupPage = named(() => import('../features/cme/SetupPages'), 'FlowSetupPage');
const AssetsPage = named(() => import('../features/cme/SetupPages'), 'AssetsPage');
const LabelsPage = named(() => import('../features/cme/LabelsPage'), 'LabelsPage');
const TracePage = named(() => import('../features/cme/TracePage'), 'TracePage');
const AccountPage = named(() => import('../features/auth/AccountPage'), 'AccountPage');
const NotificationsPage = named(() => import('../features/inbox/NotificationsPage'), 'NotificationsPage');

const page = (el: ReactElement) => <Suspense fallback={<div className="page"><LoadingState /></div>}>{el}</Suspense>;
const guarded = (anyOf: Permission[], el: ReactElement) => <Guard anyOf={anyOf}>{page(el)}</Guard>;

export const routes: RouteObject[] = [
  { path: '/entrar', element: <LoginPage /> },
  {
    path: '/',
    element: <RequireSession><AppShell /></RequireSession>,
    children: [
      { index: true, element: <HomeRoute dashboard={<DashboardPage />} consulting={page(<ConsultingHomePage />)} /> },
      { path: 'indicadores', element: guarded(['indicators:view'], <IndicatorsPage />) },
      { path: 'pacientes', element: guarded(['patient:view'], <PatientsPage />) },
      { path: 'pacientes/:id', element: guarded(['patient:view'], <PatientDetailPage />) },
      { path: 'vigilancia', element: guarded(['iras:view'], <IrasListPage />) },
      { path: 'vigilancia/:id', element: guarded(['iras:view'], <IrasCasePage />) },
      { path: 'cirurgias', element: guarded(['surgery:view'], <SurgeriesPage />) },
      { path: 'cirurgias/:id', element: guarded(['surgery:view'], <SurgeryPage />) },
      { path: 'microbiologia', element: guarded(['micro:view'], <CulturesPage />) },
      { path: 'microbiologia/:id', element: guarded(['micro:view'], <CulturePage />) },
      { path: 'censo', element: guarded(['patient:view', 'indicators:view'], <CensusPage />) },
      { path: 'bundles', element: guarded(['quality:view'], <BundlesPage />) },
      { path: 'auditorias', element: guarded(['quality:view'], <AuditsPage />) },
      { path: 'auditorias/nao-conformidades/:id', element: guarded(['quality:view'], <NcDetailPage />) },
      { path: 'auditorias/:id', element: guarded(['quality:view'], <AuditDetailPage />) },
      { path: 'treinamentos', element: guarded(['quality:view'], <TrainingsPage />) },
      { path: 'insumos', element: guarded(['quality:view'], <SuppliesPage />) },
      { path: 'alertas', element: guarded(['alerts:view'], <AlertsPage />) },
      { path: 'alertas/:id', element: guarded(['alerts:view'], <AlertDetailPage />) },
      { path: 'cme', element: guarded(['cme:view'], <CmePage />) },
      { path: 'cme/cargas/:id', element: guarded(['cme:view'], <LoadDetailPage />) },
      { path: 'cme/bowie-dick', element: guarded(['cme:view'], <BowieDickPage />) },
      { path: 'cme/equipamentos', element: guarded(['cme:view'], <EquipmentPage />) },
      { path: 'cme/caixas', element: guarded(['cme:view'], <SetsPage />) },
      { path: 'rastreabilidade', element: guarded(['cme:view'], <TracePage />) },
      { path: 'cme/estacao', element: guarded(['cme:scan'], <StationPage />) },
      { path: 'cme/processos', element: guarded(['cme:view'], <ProcessesPage />) },
      { path: 'cme/processos/:id', element: guarded(['cme:view'], <ProcessDetailPage />) },
      { path: 'cme/estacoes', element: guarded(['cme:view'], <FlowSetupPage />) },
      { path: 'cme/materiais', element: guarded(['cme:view'], <AssetsPage />) },
      { path: 'cme/etiquetas', element: guarded(['cme:view'], <LabelsPage />) },
      { path: 'consultoria/clientes', element: guarded(['consultoria:clients:view'], <ClientsPage />) },
      { path: 'consultoria/clientes/:id', element: guarded(['consultoria:clients:view'], <ClientDetailPage />) },
      { path: 'consultoria/contratos', element: guarded(['consultoria:contracts:view'], <ContractsPage />) },
      { path: 'consultoria/contratos/:id', element: guarded(['consultoria:contracts:view'], <ContractDetailPage />) },
      { path: 'consultoria/equipe', element: guarded(['consultoria:portfolio:assign', 'consultoria:portfolio:all'], <TeamPage />) },
      { path: 'conta', element: page(<AccountPage />) },
      { path: 'notificacoes', element: page(<NotificationsPage />) },
      {
        path: 'admin',
        element: guarded(['config:view', 'users:view', 'users:manage', 'users:manage:ccih', 'users:manage:cme', 'audit:view', 'audit:view:module'], <AdminLayout />),
        children: [
          { index: true, element: page(<AdminIndex />) },
          { path: 'metas', element: guarded(['config:view'], <TargetsPage />) },
          { path: 'parametros', element: guarded(['config:view'], <ParametersPage />) },
          { path: 'referencias', element: guarded(['config:view'], <ReferencesPage />) },
          { path: 'cme', element: guarded(['config:view'], <CmePolicyPage />) },
          { path: 'setores', element: guarded(['config:view'], <OrgPage />) },
          { path: 'usuarios', element: guarded(['users:view', 'users:manage', 'users:manage:ccih', 'users:manage:cme'], <UsersPage />) },
          { path: 'auditoria', element: guarded(['audit:view', 'audit:view:module'], <AuditPage />) },
        ],
      },
      ...ALL_NAV_ITEMS.filter((i) => i.phase != null).map((item) => ({ path: item.path.slice(1), element: <NavGuard item={item}><PlannedModulePage item={item} /></NavGuard> })),
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
