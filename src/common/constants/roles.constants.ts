/**
 * roles.constants.ts
 *
 * Único lugar donde se define el conjunto de roles que se consideran "staff".
 * Se importa en todos los gateways y guards que necesiten esta verificación
 * para evitar divergencia entre namespaces.
 */
export const STAFF_ROLES = ['staff', 'admin', 'super_admin'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];
