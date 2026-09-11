-- ═══════════════════════════════════════════════════════════════════
--  public.account_members — equipo interno de una cuenta cliente
--
--  Permite que el titular de una cuenta (la persona que completó el KYB
--  de la empresa) invite a empleados suyos a ver los expedientes, con un
--  conjunto de permisos que él mismo elige.
--
--  Tres decisiones que conviene entender antes de tocar esta tabla:
--
--  1) Esto NO es un rol. Los roles globales (client/staff/admin/
--     super_admin) siguen viviendo en private.staff_members y no se tocan.
--     Aquí se modela una RELACIÓN entre dos cuentas, que es lo único que
--     permite que una persona sea miembro del equipo de una empresa y a
--     la vez titular de su propia cuenta sin ambigüedad.
--
--  2) `capabilities` es la verdad efectiva; `preset` es solo una etiqueta
--     para la interfaz y la auditoría. El guard del backend evalúa
--     únicamente el array. Si mañana cambia qué trae la plantilla
--     "finance", los miembros ya existentes NO cambian de permisos.
--
--  3) El catálogo de permisos es de SOLO LECTURA por construcción. No
--     existe valor que conceda crear, modificar o cancelar un expediente.
--     El día que se añada el primero, esta garantía desaparece y hace
--     falta una revisión de seguridad propia.
--
--  Escritura: solo service_role (el backend). Igual criterio que
--  private.staff_members — el vector de escalación de profiles.role fue
--  que la columna era escribible desde el navegador.
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.account_members (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Cuenta de la empresa que ya pasó KYB (el titular).
  owner_id               uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Persona invitada. NULL hasta que acepta la invitación.
  member_id              uuid REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Email al que se invitó. Debe coincidir con el de la cuenta que acepta:
  -- es lo que impide que el invitado reenvíe el enlace a un tercero.
  invited_email          text NOT NULL,

  -- Plantilla elegida al invitar. Etiqueta para UI y auditoría.
  preset                 text NOT NULL
    CHECK (preset IN ('operations', 'finance', 'custom')),

  -- Permisos efectivos. Validados contra la lista blanca del backend
  -- (common/constants/capabilities.constants.ts) antes de escribirse.
  --
  -- cardinality() y no array_length(): sobre un array vacío, array_length
  -- devuelve NULL en vez de 0, y un CHECK que se evalúa a NULL se da por
  -- satisfecho — la restricción no rechazaría nada. cardinality devuelve 0.
  capabilities           text[] NOT NULL
    CHECK (cardinality(capabilities) >= 1),

  status                 text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'revoked', 'expired')),

  invited_by             uuid NOT NULL REFERENCES auth.users(id),

  -- SHA-256 del token de invitación. El token en claro solo viaja por correo.
  invitation_token_hash  text,
  expires_at             timestamptz NOT NULL,

  accepted_at            timestamptz,
  revoked_at             timestamptz,
  revoked_by             uuid REFERENCES auth.users(id),
  revoke_reason          text,

  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT no_self_membership CHECK (owner_id IS DISTINCT FROM member_id)
);

-- Un mismo email no puede tener dos vínculos vivos con la misma cuenta.
-- Parcial a propósito: permite reinvitar tras una revocación sin borrar el
-- histórico, que en un entorno regulado hay que conservar.
CREATE UNIQUE INDEX IF NOT EXISTS account_members_unique_live
  ON public.account_members (owner_id, lower(invited_email))
  WHERE status IN ('pending', 'active');

-- Resolución del contexto en cada request: "¿de qué cuentas es miembro X?"
CREATE INDEX IF NOT EXISTS account_members_member_idx
  ON public.account_members (member_id) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS account_members_owner_idx
  ON public.account_members (owner_id);

-- Responde "¿quién puede ver los datos bancarios de esta empresa?" en una
-- sola consulta, que es lo que pide una auditoría.
CREATE INDEX IF NOT EXISTS account_members_capabilities_idx
  ON public.account_members USING GIN (capabilities);

-- Reutiliza el trigger genérico ya existente en el baseline.
DROP TRIGGER IF EXISTS trg_updated_at ON public.account_members;
CREATE TRIGGER trg_updated_at
  BEFORE UPDATE ON public.account_members
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- ─── RLS ────────────────────────────────────────────────────────────
-- Nota: el backend usa service_role y salta RLS; la autorización real
-- vive en los guards. Esto protege el caso de una consulta directa desde
-- el navegador con la anon key.

ALTER TABLE public.account_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS account_members_owner_reads ON public.account_members;
CREATE POLICY account_members_owner_reads ON public.account_members
  FOR SELECT USING ((SELECT auth.uid()) = owner_id);

DROP POLICY IF EXISTS account_members_member_reads ON public.account_members;
CREATE POLICY account_members_member_reads ON public.account_members
  FOR SELECT USING ((SELECT auth.uid()) = member_id);

DROP POLICY IF EXISTS account_members_service_role_all ON public.account_members;
CREATE POLICY account_members_service_role_all ON public.account_members
  FOR ALL USING ((SELECT auth.role()) = 'service_role');

-- Cinturón y tirantes. Un REVOKE FROM PUBLIC no basta: hay que nombrar
-- explícitamente anon y authenticated o la escritura queda concedida.
REVOKE ALL ON public.account_members FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.account_members TO authenticated;
GRANT ALL ON public.account_members TO service_role, postgres;

COMMENT ON TABLE public.account_members IS
  'Equipo interno de una cuenta cliente. Solo escribible por service_role. capabilities es la verdad efectiva; preset es una etiqueta. Catálogo de solo lectura por construcción.';

COMMENT ON COLUMN public.account_members.capabilities IS
  'Permisos efectivos. Validados contra la lista blanca del backend. Solo lectura: ningún valor concede escritura sobre expedientes.';
