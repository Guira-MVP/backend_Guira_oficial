-- ═══════════════════════════════════════════════════════════════
--  Semilla: comunicado "Nuevos rieles en camino"
--  Anuncia los próximos corredores de Perú, Argentina, China y Canadá.
--  Idempotente: no duplica si ya existe un anuncio con el mismo título.
--
--  Entra como BORRADOR (is_active = FALSE): nadie lo ve hasta que alguien de
--  admin lo publique desde /admin/anuncios. Así el despliegue no dispara un
--  modal a todos los clientes sin que se haya revisado antes.
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
  FALSE
WHERE NOT EXISTS (
  SELECT 1 FROM announcements WHERE title = 'Nuevos rieles en camino'
);
