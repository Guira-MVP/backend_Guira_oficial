import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { CAPABILITIES } from '../../common/constants/capabilities.constants';

/**
 * Invariantes del acceso vinculado.
 *
 * Estas pruebas no ejercitan un endpoint concreto: vigilan una propiedad
 * del código entero que, si se rompe, convierte un acceso de solo lectura
 * en uno de escritura. Son el motivo por el que el diseño puede prometer
 * que un miembro de equipo no mueve dinero «por construcción» — sin ellas
 * la promesa dependería de que nadie se despiste al añadir una ruta.
 *
 * Se analiza el código fuente en vez de levantar la app porque el objetivo
 * es precisamente detectar el descuido antes de que llegue a ejecutarse.
 */

const SRC = join(__dirname, '..', '..');
const HTTP_VERB = /@(Get|Post|Put|Patch|Delete)\s*\(/g;

function controllerFiles(dir: string): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...controllerFiles(full));
    } else if (entry.endsWith('.controller.ts')) {
      found.push(full);
    }
  }

  return found;
}

interface Handler {
  file: string;
  verb: string;
  body: string;
}

/**
 * Trocea un controller en handlers. Cada trozo va desde un decorador de
 * verbo HTTP hasta el siguiente, así que contiene los demás decoradores y
 * la firma del método al que pertenecen.
 */
function handlersOf(file: string): Handler[] {
  const source = readFileSync(file, 'utf8');
  const marks: Array<{ verb: string; start: number }> = [];

  for (const match of source.matchAll(HTTP_VERB)) {
    marks.push({ verb: match[1], start: match.index ?? 0 });
  }

  return marks.map((mark, i) => ({
    file,
    verb: mark.verb,
    body: source.slice(mark.start, marks[i + 1]?.start ?? source.length),
  }));
}

const handlers = controllerFiles(join(SRC, 'application')).flatMap(handlersOf);

describe('invariantes del acceso vinculado', () => {
  it('encuentra handlers que analizar', () => {
    // Si el troceado dejara de funcionar, el resto de pruebas pasaría en
    // vacío y dejaría de proteger nada.
    expect(handlers.length).toBeGreaterThan(50);
  });

  it('@RequiresCapability solo aparece en handlers @Get', () => {
    const offenders = handlers
      .filter((h) => h.verb !== 'Get' && h.body.includes('@RequiresCapability'))
      .map((h) => `${h.file} (@${h.verb})`);

    // Un @RequiresCapability en un POST/PATCH/DELETE abriría una ruta de
    // escritura al acceso vinculado: exactamente lo que el diseño promete
    // que no puede pasar.
    expect(offenders).toEqual([]);
  });

  it('@TargetUserId() solo aparece en handlers @Get', () => {
    const offenders = handlers
      .filter((h) => h.verb !== 'Get' && h.body.includes('@TargetUserId'))
      .map((h) => `${h.file} (@${h.verb})`);

    // En escrituras la identidad sale siempre de @CurrentUser(), que es la
    // de quien inició sesión. Usar @TargetUserId() aquí haría que un
    // invitado escribiera sobre la cuenta del titular.
    expect(offenders).toEqual([]);
  });

  it('@RequiresCapability declara un único permiso del catálogo', () => {
    const pattern = /@RequiresCapability\(([^)]*)\)/g;
    const offenders: string[] = [];

    for (const handler of handlers) {
      for (const match of handler.body.matchAll(pattern)) {
        const args = match[1].split(',').map((arg) => arg.trim());

        if (args.length !== 1) {
          // Con dos permisos, los permisos dejan de ser independientes y
          // habría que probar 2^n combinaciones en vez de n permisos.
          offenders.push(`${handler.file}: ${args.length} permisos`);
          continue;
        }

        const capability = args[0].replace(/['"]/g, '');
        if (!CAPABILITIES.includes(capability as never)) {
          offenders.push(`${handler.file}: "${capability}" no está en el catálogo`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('todo permiso del catálogo tiene efecto real', () => {
    // Un permiso que no protege ningún endpoint ni recorta ninguna
    // respuesta es una promesa vacía: la pantalla de invitación le dice al
    // titular que esa persona "va a poder ver X", y no pasa nada. Peor aún
    // si el dato ya era visible sin el permiso.
    const declared = new Set<string>();
    for (const handler of handlers) {
      for (const match of handler.body.matchAll(/@RequiresCapability\('([^']*)'\)/g)) {
        declared.add(match[1]);
      }
    }

    // Excepción justificada: no protege un endpoint, decide cómo se
    // serializa la respuesta (ver mask-bank-details.ts). Está cubierto por
    // su propia suite.
    const SERIALIZATION_ONLY = ['bank_details:full'];

    const inert = CAPABILITIES.filter(
      (cap) => !declared.has(cap) && !SERIALIZATION_ONLY.includes(cap),
    );

    expect(inert).toEqual([]);
  });

  it('el catálogo no contiene permisos de escritura', () => {
    // La garantía de fondo: ninguna combinación de permisos permite crear,
    // modificar o cancelar nada. Si alguien añade el primer permiso de
    // escritura, esta prueba obliga a pasar por una revisión consciente en
    // vez de dejarlo entrar como "una entrada más del catálogo".
    const writeVerbs = /(write|create|update|delete|cancel|approve|execute|send)/i;
    const offenders = CAPABILITIES.filter((cap) => writeVerbs.test(cap));

    expect(offenders).toEqual([]);
  });
});
