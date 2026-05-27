-- 20260527_compliance_reviews_open_index.sql
--
-- Índice parcial para la query principal del dashboard de compliance.
-- La view compliance_reviews_enriched filtra siempre por status = 'open',
-- por lo que un índice parcial solo sobre esas filas es más eficiente
-- que un índice full sobre toda la tabla (los registros cerrados no se indexan).

CREATE INDEX IF NOT EXISTS idx_compliance_reviews_open
  ON compliance_reviews (priority DESC, opened_at ASC)
  WHERE status = 'open';
