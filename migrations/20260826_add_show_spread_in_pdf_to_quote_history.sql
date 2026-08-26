-- El spread es un dato interno (no se le comunica al cliente); el PDF de
-- cotización lo omite por defecto. Este flag, guardado por cotización, deja
-- constancia de si el staff decidió mostrarlo explícitamente para ese ticket
-- puntual, y hace que una re-descarga posterior desde el historial respete
-- la misma decisión.
ALTER TABLE quote_history
  ADD COLUMN IF NOT EXISTS show_spread_in_pdf BOOLEAN NOT NULL DEFAULT FALSE;
