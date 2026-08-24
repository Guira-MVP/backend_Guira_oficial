-- ═══════════════════════════════════════════════════════════════
--  Semilla: comunicado "Nuevos rieles en camino"
--  Anuncia los próximos corredores de Perú, Argentina, China y Canadá.
--  Idempotente: no duplica si ya existe un anuncio con el mismo título.
-- ═══════════════════════════════════════════════════════════════

INSERT INTO announcements (title, badge, body, items, is_active)
SELECT
  'Nuevos rieles en camino',
  'Próximamente',
  'Estamos ampliando la red de Guira. Muy pronto vas a poder enviar y recibir a través de nuevos corredores internacionales.',
  '[
    { "flag": "PE", "label": "Perú",      "description": "Envíos y cobros en soles" },
    { "flag": "AR", "label": "Argentina", "description": "Envíos y cobros en pesos argentinos" },
    { "flag": "CN", "label": "China",     "description": "Pagos a proveedores en yuanes" },
    { "flag": "CA", "label": "Canadá",    "description": "Envíos y cobros en dólares canadienses" }
  ]'::jsonb,
  TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM announcements WHERE title = 'Nuevos rieles en camino'
);
