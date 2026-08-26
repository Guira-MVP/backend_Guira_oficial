-- El PDF fue reemplazado por una imagen tipo ticket (generada en el
-- navegador, no en el backend). El flag ya no describe un formato concreto
-- ("in_pdf"), sino la decisión de fondo: si el spread se revela al cliente.
ALTER TABLE quote_history RENAME COLUMN show_spread_in_pdf TO show_spread_to_client;
