/**
 * @helm/shared — kernel primitives.
 *
 * Pure by contract: no I/O, no framework, no ambient clock, no randomness.
 * Everything that needs time or identity takes a `Clock` or `IdGen` port.
 */

export * from './ids.ts';
export * from './result.ts';
export * from './temporal.ts';
export * from './scope.ts';
export * from './provenance.ts';
export * from './decimal.ts';
export * from './quantity.ts';
