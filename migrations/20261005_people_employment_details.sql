-- Datos de empleo del KYC (persona natural) para Tazapay.
-- Si el origen de fondos es "salary", Tazapay exige
-- individual.employment_details { employer_name (≤200), designation (≤100) }.
-- Opcionales: solo se piden en el formulario cuando el origen es salario.
-- La tabla people ya tiene RLS; las columnas nuevas heredan sus políticas.

alter table public.people
  add column if not exists employer_name text,
  add column if not exists job_title text;

alter table public.people
  drop constraint if exists people_employer_name_length,
  add constraint people_employer_name_length
    check (employer_name is null or char_length(employer_name) <= 200),
  drop constraint if exists people_job_title_length,
  add constraint people_job_title_length
    check (job_title is null or char_length(job_title) <= 100);

comment on column public.people.employer_name is
  'Empleador (origen de fondos = salario). Tazapay: individual.employment_details.employer_name';
comment on column public.people.job_title is
  'Cargo o puesto (origen de fondos = salario). Tazapay: individual.employment_details.designation';
