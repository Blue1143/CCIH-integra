export { generateFacts, WARD_PROFILES, type WardProfile } from './facts';
export * from './clinical';
export { DEMO_CONFIG, DEMO_LOAD_POLICY, DEMO_REFERENCES, DEMO_SECTORS, DEMO_UNITS } from './institution';
export { hashSeed, rng, poisson, binomial } from './random';

/** Label every synthetic record carries. */
export const DEMO_SOURCE = 'Gerador sintético de demonstração v1 (sem pacientes reais)';
export * from './operations';
export * from './cme';
export * from './consulting-demo';
