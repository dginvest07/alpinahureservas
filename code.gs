/**
 * ================================================================
 *  RESERVAS DE CABAÑAS  |  Backend (Google Apps Script)
 *  Archivo: code.gs   ·   Finanzas, ocupación y controles de acceso
 * ================================================================
 *
 *  COMPATIBILIDAD CON VERSIONES ANTERIORES
 *  La app LEÍA las hojas por nombre de encabezado pero ESCRIBÍA por la
 *  posición del campo en SCHEMA. Como ensureColumns_() agregaba las
 *  columnas nuevas al final, en cualquier hoja migrada de una versión
 *  anterior las dos cosas dejaban de coincidir: cambiar el Estado de una
 *  reserva escribía en la columna Origen y el estado nunca cambiaba.
 *  Ahora TODO se ubica por el encabezado real (headers_ / col_) y
 *  ensureColumns_ inserta las columnas faltantes en su posición.
 *
 *  DESPUÉS DE PEGAR ESTE ARCHIVO (en este orden)
 *  1) Guardar.
 *  2) Ejecutar actualizarEstructura()   -> crea hojas y columnas que falten,
 *     incluida MovimientosFinancieros; los ingresos de las reservas existentes
 *     se muestran automáticamente en el mes de CheckIn.
 *  3) Ejecutar diagnostico()            -> informe de la hoja.
 *  4) Ejecutar repararEstados()         -> solo si el diagnóstico encontró
 *                                          estados escritos en Origen.
 *  5) Ejecutar repararFormulas()        -> no borra datos.
 *  6) Implementar > Administrar implementaciones > editar > NUEVA VERSIÓN.
 *     La app web sirve la versión implementada, no lo guardado en el editor.
 *
 *  NO ejecutar setupDemoData() sobre una base con datos (tiene protección).
 *  setupDemoDataForzado() BORRA TODO.
 *
 *  PUESTA EN MARCHA DESDE CERO
 *  1) Configuración del proyecto > Zona horaria: America/Asuncion.
 *  2) Crear un archivo HTML llamado exactamente "index" y pegar index.html.
 *  3) Ejecutar setupDemoData() una sola vez y aceptar los permisos
 *     (Sheets, Calendar y Gmail para los avisos).
 *  4) Implementar > Nueva implementación > Aplicación web
 *       Ejecutar como: Yo   |   Quién tiene acceso: Cualquier persona
 *     Restringí la hoja base y el proyecto a los colaboradores autorizados.
 *  5) La primera ejecución muestra credenciales temporales solo una vez.
 *     Cambialas al ingresar; las contraseñas no se guardan en la hoja.
 *  6) Recordatorios de viaje: pestaña Recordatorios del panel. Al activarlos
 *     se crea un activador diario (función enviarRecordatorios).
 *
 *  PRECIOS POR CANTIDAD DE PERSONAS (hoja Tarifas)
 *    - TipoPrecio FIJO     -> precio por la cabaña entera, por noche.
 *    - TipoPrecio PERSONA  -> se multiplica por la cantidad de huéspedes.
 *    - PrecioSemana        -> noches de lunes a jueves.
 *    - PrecioFinSemana     -> noches de DIAS_FINDE y FERIADOS.
 *    - PrecioPaquete       -> precio por noche cuando toda la estadía cae
 *                             entre semana y dura al menos PaqueteMinNoches.
 *  Si una cabaña no tiene tramos activos se usan PrecioNoche /
 *  PrecioFinSemana de la hoja Cabanas.
 *
 *  HOJAS Y RELACIONES
 *  Cabanas.ID        <- Reservas.CabanaID, Resenas.CabanaID,
 *                       Promociones.CabanaID, Tarifas.CabanaID
 *  TiposReserva.Modo <- Reservas.TipoModo, Promociones.TipoModo
 *  Promociones.Codigo<- Reservas.PromoCodigo
 *  Reservas.EventID  -> evento en Google Calendar
 *
 *  IMÁGENES: enlaces directos o de Google Drive ("Cualquier persona con el
 *  enlace"); los de Drive se convierten solos.
 * ================================================================
 */

const APP = {
  NOMBRE: 'Cabaña Alpina Hu',
  PREFIJO_CODIGO: 'AH-',
  // Separador de argumentos en las fórmulas de la hoja.
  // 'AUTO' prueba primero ';' y, si la hoja no lo acepta, usa ','.
  SEPARADOR_FORMULAS: 'AUTO',
  PROP_SEP: 'RESERVAS_FORMULA_SEP',
  // WhatsApp Cloud API (Meta). El token va en Propiedades del script, nunca en la hoja.
  WA_API_VERSION: 'v23.0',
  PROP_WA_TOKEN: 'RESERVAS_WA_TOKEN',
  // Credenciales de acceso: hashes con sal, fuera de Google Sheets.
  PROP_AUTH_PEPPER: 'RESERVAS_AUTH_PEPPER',
  PROP_AUTH_PREFIX: 'RESERVAS_AUTH_USER_',
  SESSION_TTL: 60 * 60,               // 1 hora de inactividad
  SESSION_ABSOLUTE_MS: 12 * 60 * 60 * 1000, // duración máxima 12 horas
  PROP_SS: 'RESERVAS_SS_ID',
  PROP_CAL: 'RESERVAS_CAL_ID',
  ESTADOS: ['Pendiente', 'Confirmada', 'Completada', 'Cancelada'],
  MODOS: ['RANGO', 'LARGA', 'FINDE', 'RECURRENTE', 'DIA'],
  FRECUENCIAS: ['SEMANAL', 'QUINCENAL', 'MENSUAL'],
  TIPOS_PRECIO: ['FIJO', 'PERSONA']
};

const SCHEMA = {
  Cabanas: ['ID', 'Nombre', 'Descripcion', 'Capacidad', 'Habitaciones', 'Banos', 'PrecioNoche', 'PrecioFinSemana',
    'Amenidades', 'ImagenURL', 'Ubicacion', 'Rating', 'NumResenas', 'Activa', 'Creado'],
  Tarifas: ['ID', 'CabanaID', 'Nombre', 'MinPersonas', 'MaxPersonas', 'TipoPrecio', 'PrecioSemana', 'PrecioFinSemana',
    'TipoPaquete', 'PrecioPaquete', 'PaqueteMinNoches', 'Orden', 'Activa'],
  Reservas: ['ID', 'Codigo', 'GrupoID', 'CabanaID', 'CabanaNombre', 'TipoModo', 'TipoNombre', 'Cliente', 'Email',
    'Telefono', 'Huespedes', 'CheckIn', 'CheckOut', 'HoraLlegada', 'Noches', 'TarifaID', 'TarifaNombre', 'Paquete',
    'Subtotal', 'Descuento', 'Total', 'Sena', 'PromoCodigo', 'Estado', 'EventID', 'Notas', 'Origen', 'Creado'],
  TiposReserva: ['Modo', 'Nombre', 'Descripcion', 'MinNoches', 'MaxNoches', 'DescuentoPct', 'Icono', 'Activo'],
  Promociones: ['Codigo', 'Descripcion', 'DescuentoPct', 'CabanaID', 'TipoModo', 'FechaInicio', 'FechaFin', 'MinNoches',
    'Activa', 'Usos'],
  Resenas: ['ID', 'CabanaID', 'Autor', 'Rating', 'Comentario', 'Fecha', 'Visible'],
  Usuarios: ['Usuario', 'Nombre', 'Rol', 'Activo', 'UltimoAcceso'],
  Configuracion: ['Clave', 'Valor', 'Descripcion'],
  MovimientosFinancieros: ['ID', 'Fecha', 'CabanaID', 'Tipo', 'Categoria', 'Concepto', 'Monto',
    'Referencia', 'RegistradoPor', 'Creado', 'Estado', 'AnuladoPor', 'AnuladoEn', 'EditadoPor', 'EditadoEn', 'Revision', 'HistorialCambios']
};

const HOJAS = ['Reservas', 'Cabanas', 'Tarifas', 'TiposReserva', 'Promociones', 'Resenas', 'Usuarios', 'Configuracion', 'MovimientosFinancieros'];

const DATE_FIELDS = ['CheckIn', 'CheckOut', 'FechaInicio', 'FechaFin', 'Fecha'];
const BOOL_FIELDS = ['Activa', 'Activo', 'Visible', 'Paquete'];
const TEXT_FIELDS = ['ID', 'Codigo', 'GrupoID', 'CabanaID', 'TipoModo', 'Modo', 'Telefono', 'HoraLlegada', 'PromoCodigo',
  'EventID', 'Usuario', 'Valor', 'Clave', 'TarifaID', 'TipoPrecio', 'TipoPaquete'];
const MONEY_FIELDS = ['PrecioNoche', 'PrecioFinSemana', 'PrecioSemana', 'PrecioPaquete', 'Subtotal', 'Descuento',
  'Total', 'Sena', 'Monto'];
const COL_WIDTHS = { Descripcion: 320, Comentario: 320, Amenidades: 280, ImagenURL: 220, Notas: 260, Valor: 320, EventID: 160 };

/**
 * Permisos de la aplicación. Los perfiles no se basan en ocultar botones:
 * cada operación del servidor valida el permiso correspondiente.
 */
const PERMISOS = {
  RESERVAS: { nombre: 'Reservas', descripcion: 'Crear, editar y cancelar reservas.' },
  CALENDARIO: { nombre: 'Calendario', descripcion: 'Ver y sincronizar el calendario de reservas.' },
  CABANAS: { nombre: 'Cabañas', descripcion: 'Editar cabañas, fotos y disponibilidad.' },
  PRECIOS: { nombre: 'Precios', descripcion: 'Editar tarifas y tramos de precio.' },
  PROMOCIONES: { nombre: 'Promociones', descripcion: 'Crear y modificar promociones.' },
  CONFIGURACION: { nombre: 'Configuración', descripcion: 'Cambiar los ajustes generales de la app.' },
  MENSAJES: { nombre: 'Mensajes', descripcion: 'Editar y probar comunicaciones con huéspedes.' },
  RECORDATORIOS: { nombre: 'Recordatorios', descripcion: 'Configurar y enviar recordatorios.' },
  USUARIOS: { nombre: 'Usuarios', descripcion: 'Crear, editar o desactivar usuarios.' },
  REPORTES: { nombre: 'Resumen', descripcion: 'Ver indicadores y reportes del negocio.' },
  FINANZAS: { nombre: 'Finanzas', descripcion: 'Ver, registrar, editar y anular egresos con detalle por concepto.' },
  LIMPIEZA: { nombre: 'Agenda de limpieza', descripcion: 'Ver entradas, salidas y recambios sin datos sensibles.' }
};

const ROLES = {
  DUENO: { nombre: 'Dueño', descripcion: 'Acceso total a la app y a la configuración de permisos.' },
  OPERADOR: { nombre: 'Operador', descripcion: 'Gestiona reservas y precios acordados de reservas externas; por defecto no puede modificar las tarifas publicadas.' },
  LIMPIEZA: { nombre: 'Limpieza', descripcion: 'Por defecto solo ve la agenda operativa, sin precios ni contactos.' }
};

const PERMISOS_PREDETERMINADOS = {
  OPERADOR: ['RESERVAS', 'CALENDARIO'],
  LIMPIEZA: ['LIMPIEZA']
};

const CONFIG_EDITABLE = ['NEGOCIO_NOMBRE', 'ESLOGAN', 'SIMBOLO', 'DIRECCION', 'TELEFONO', 'WHATSAPP', 'EMAIL_NOTIF',
  'CHECKIN_HORA', 'CHECKOUT_HORA', 'DEEP_WORK_SALIDA', 'DEEP_WORK_PCT', 'SENA_PCT', 'MAX_DESCUENTO', 'ESTADO_INICIAL',
  'NOTIFICAR_EMAIL', 'HERO_IMG', 'LOGO_URL', 'LOGO_ICONO', 'DIAS_FINDE', 'FERIADOS',
  'DATOS_BANCARIOS', 'CONDICIONES_RESERVA', 'ASUNTO_HUESPED', 'MENSAJE_HUESPED', 'MENSAJE_WHATSAPP',
  'WA_ACTIVO', 'WA_CODIGO_PAIS', 'WA_PHONE_ID', 'WA_PLANTILLA', 'WA_IDIOMA', 'WA_PARAMS',
  'RECORDATORIO_ACTIVO', 'RECORDATORIO_DIAS', 'RECORDATORIO_HORA', 'RECORDATORIO_ESTADOS', 'RECORDATORIO_EMAIL',
  'RECORDATORIO_ASUNTO', 'RECORDATORIO_MENSAJE', 'RECORDATORIO_WHATSAPP', 'RECORDATORIO_WA_AUTO',
  'WA_PLANTILLA_RECORDATORIO', 'WA_PARAMS_RECORDATORIO'];

const CONFIG_MENSAJES = ['DATOS_BANCARIOS', 'CONDICIONES_RESERVA', 'ASUNTO_HUESPED', 'MENSAJE_HUESPED', 'MENSAJE_WHATSAPP',
  'WA_ACTIVO', 'WA_CODIGO_PAIS', 'WA_PHONE_ID', 'WA_PLANTILLA', 'WA_IDIOMA', 'WA_PARAMS'];
const CONFIG_RECORDATORIOS = ['RECORDATORIO_ACTIVO', 'RECORDATORIO_DIAS', 'RECORDATORIO_HORA', 'RECORDATORIO_ESTADOS',
  'RECORDATORIO_EMAIL', 'RECORDATORIO_ASUNTO', 'RECORDATORIO_MENSAJE', 'RECORDATORIO_WHATSAPP',
  'RECORDATORIO_WA_AUTO', 'WA_PLANTILLA_RECORDATORIO', 'WA_PARAMS_RECORDATORIO'];
const CONFIG_AJUSTES = ['NEGOCIO_NOMBRE', 'ESLOGAN', 'SIMBOLO', 'DIRECCION', 'TELEFONO', 'WHATSAPP', 'EMAIL_NOTIF',
  'CHECKIN_HORA', 'CHECKOUT_HORA', 'DEEP_WORK_SALIDA', 'DEEP_WORK_PCT', 'SENA_PCT', 'MAX_DESCUENTO', 'ESTADO_INICIAL',
  'NOTIFICAR_EMAIL', 'HERO_IMG', 'LOGO_URL', 'LOGO_ICONO', 'DIAS_FINDE', 'FERIADOS'];

/** Textos largos: admiten más caracteres. */
const CONFIG_LARGAS = ['DATOS_BANCARIOS', 'CONDICIONES_RESERVA', 'MENSAJE_HUESPED', 'MENSAJE_WHATSAPP',
  'RECORDATORIO_MENSAJE', 'RECORDATORIO_WHATSAPP', 'FERIADOS'];

/**
 * Valores por defecto de claves que pueden no existir en hojas creadas
 * con versiones anteriores. Se agregan solas a Configuracion (sin borrar nada).
 */
const CONFIG_DEFAULTS = [
  { Clave: 'LOGO_URL', Valor: '', Descripcion: 'Logo (enlace directo o de Drive). Vacío = usa LOGO_ICONO' },
  { Clave: 'LOGO_ICONO', Valor: 'mountain', Descripcion: 'Ícono si no hay logo: mountain, cabin, tree, home, sun, moon' },
  {
    Clave: 'DIAS_FINDE',
    Valor: '5,6,0',
    Descripcion: 'Días que se cobran a tarifa de fin de semana (0=domingo ... 6=sábado)'
  },
  {
    Clave: 'FERIADOS',
    Valor: [
      '2026-09-29', '2026-12-08', '2026-12-25',
      '2027-01-01', '2027-03-01', '2027-05-01', '2027-05-14', '2027-05-15',
      '2027-06-12', '2027-08-15', '2027-09-29', '2027-12-08', '2027-12-25'
    ].join('\n'),
    Descripcion: 'Fechas AAAA-MM-DD que se cobran como fin de semana. Revisá Semana Santa cada año'
  },
  {
    Clave: 'DATOS_BANCARIOS',
    Valor: '',
    Descripcion: 'Datos para transferir la seña. Se muestran al huésped y van en el email'
  },
  {
    Clave: 'CONDICIONES_RESERVA',
    Valor: [
      '- La reserva se confirma al recibir la seña del {sena_pct}% del total.',
      '- Si la seña no se recibe dentro de las 24 horas, las fechas se liberan.',
      '- El saldo se abona al llegar.',
      '- Check-in desde las {checkin} y check-out hasta las {checkout}.',
      '- El precio depende de la cantidad de personas declarada en la reserva.',
      '- Cancelaciones con 7 días o más de anticipación: la seña se puede usar para otra fecha dentro de los 6 meses.',
      '- Cancelaciones con menos de 7 días: la seña no se reintegra.',
      '- La capacidad máxima de cada cabaña debe respetarse.'
    ].join('\n'),
    Descripcion: 'Condiciones que el huésped acepta antes de reservar. Vacío = no se pide aceptación'
  },
  { Clave: 'ASUNTO_HUESPED', Valor: 'Recibimos tu reserva {codigo} | {negocio}', Descripcion: 'Asunto del email al huésped' },
  {
    Clave: 'MENSAJE_HUESPED',
    Valor: [
      'Hola {nombre},',
      '',
      '¡Gracias por elegir {negocio}! Recibimos tu reserva *{codigo}*.',
      '',
      '{detalle}',
      '',
      '*Para confirmar tu reserva*',
      'Transferí la seña de *{sena}* a la siguiente cuenta:',
      '{datos_bancarios}',
      '',
      'Después enviá el comprobante por WhatsApp al {whatsapp} indicando el código {codigo}.',
      '',
      '*Condiciones de la reserva*',
      '{condiciones}',
      '',
      '¡Te esperamos!',
      '{negocio}',
      '{direccion}'
    ].join('\n'),
    Descripcion: 'Email al huésped. *texto* = negrita. Variables entre llaves'
  },
  {
    Clave: 'MENSAJE_WHATSAPP',
    Valor: [
      'Hola {nombre} 👋',
      'Recibimos tu reserva *{codigo}* en {negocio}.',
      '',
      '{detalle}',
      '',
      '*Para confirmar*',
      'Transferí la seña de *{sena}* a:',
      '{datos_bancarios}',
      '',
      'Enviá el comprobante por este chat indicando el código {codigo}.',
      '',
      '*Condiciones*',
      '{condiciones}',
      '',
      '¡Te esperamos!'
    ].join('\n'),
    Descripcion: 'Mensaje de WhatsApp al huésped (botón del panel). *texto* = negrita'
  },
  { Clave: 'WA_ACTIVO', Valor: 'NO', Descripcion: 'SI / NO: envío automático por WhatsApp Cloud API' },
  { Clave: 'WA_CODIGO_PAIS', Valor: '595', Descripcion: 'Código de país para teléfonos que empiezan con 0' },
  { Clave: 'WA_PHONE_ID', Valor: '', Descripcion: 'Phone number ID de WhatsApp Business (Meta)' },
  { Clave: 'WA_PLANTILLA', Valor: 'confirmacion_reserva', Descripcion: 'Nombre de la plantilla aprobada por Meta' },
  { Clave: 'WA_IDIOMA', Valor: 'es', Descripcion: 'Idioma de la plantilla (es, es_AR, es_MX...)' },
  { Clave: 'WA_PARAMS', Valor: 'nombre,codigo,cabana,fechas,total,sena', Descripcion: 'Variables que llenan {{1}}, {{2}}... de la plantilla, en orden' },
  { Clave: 'RECORDATORIO_ACTIVO', Valor: 'NO', Descripcion: 'SI / NO: enviar recordatorios automáticos antes de la llegada' },
  { Clave: 'RECORDATORIO_DIAS', Valor: '3,1', Descripcion: 'Días antes de la llegada en que se envía (ej. 7,3,1)' },
  { Clave: 'RECORDATORIO_HORA', Valor: '9', Descripcion: 'Hora del envío diario (0 a 23)' },
  { Clave: 'RECORDATORIO_ESTADOS', Valor: 'Confirmada', Descripcion: 'Estados que reciben recordatorio (ej. Confirmada,Pendiente)' },
  { Clave: 'RECORDATORIO_EMAIL', Valor: 'SI', Descripcion: 'SI / NO: enviar el recordatorio por email' },
  { Clave: 'RECORDATORIO_ASUNTO', Valor: 'Te esperamos {cuando} en {negocio}', Descripcion: 'Asunto del recordatorio' },
  {
    Clave: 'RECORDATORIO_MENSAJE',
    Valor: [
      'Hola {nombre},',
      '',
      'Te recordamos que tu estadía en {negocio} es *{cuando}*.',
      '',
      '{detalle}',
      '',
      '*Llegada*',
      '{llegada}, desde las {hora_llegada} hs.',
      'Check-out hasta las {checkout} hs.',
      '',
      '*Cómo llegar*',
      '{ubicacion}',
      '{mapa}',
      '',
      'Si necesitás algo antes de viajar, escribinos al {whatsapp}.',
      '',
      '¡Buen viaje!',
      '{negocio}'
    ].join('\n'),
    Descripcion: 'Email de recordatorio. *texto* = negrita'
  },
  {
    Clave: 'RECORDATORIO_WHATSAPP',
    Valor: [
      'Hola {nombre} 👋',
      'Te esperamos *{cuando}* en {negocio}.',
      '',
      '🏡 {cabana}',
      '📅 {llegada}',
      '🕑 Llegada desde las {hora_llegada} hs',
      '📍 {mapa}',
      '',
      'Cualquier consulta, escribinos por acá.'
    ].join('\n'),
    Descripcion: 'Recordatorio por WhatsApp (botón del panel)'
  },
  { Clave: 'RECORDATORIO_WA_AUTO', Valor: 'NO', Descripcion: 'SI / NO: enviar recordatorio con plantilla de WhatsApp' },
  { Clave: 'WA_PLANTILLA_RECORDATORIO', Valor: 'recordatorio_reserva', Descripcion: 'Plantilla aprobada por Meta para recordatorios' },
  { Clave: 'WA_PARAMS_RECORDATORIO', Valor: 'nombre,cabana,cuando,llegada,hora_llegada', Descripcion: 'Variables de la plantilla de recordatorio, en orden' },
  { Clave: 'PERMISOS_OPERADOR', Valor: 'RESERVAS,CALENDARIO', Descripcion: 'Permisos asignados al perfil Operador (gestionado desde Usuarios)' },
  { Clave: 'PERMISOS_LIMPIEZA', Valor: 'LIMPIEZA', Descripcion: 'Permisos asignados al perfil Limpieza (gestionado desde Usuarios)' }
];

const PLANTILLA_VARIABLES = ['nombre', 'codigo', 'cabana', 'tipo', 'tarifa', 'fechas', 'llegada', 'hora_llegada',
  'cuando', 'dias', 'huespedes', 'total', 'sena', 'sena_pct', 'estado', 'datos_bancarios', 'condiciones', 'detalle',
  'negocio', 'whatsapp', 'telefono', 'direccion', 'ubicacion', 'mapa', 'checkin', 'checkout'];

/** Tramos sugeridos al crear una cabaña o al pulsar "Cargar tramos sugeridos". */
const TARIFAS_SUGERIDAS = [
  { Nombre: 'Parejas', MinPersonas: 1, MaxPersonas: 2, TipoPrecio: 'FIJO', PrecioSemana: 450000, PrecioFinSemana: 650000, TipoPaquete: 'FIJO', PrecioPaquete: 350000, PaqueteMinNoches: 2 },
  { Nombre: 'Grupos de 3 a 4', MinPersonas: 3, MaxPersonas: 4, TipoPrecio: 'PERSONA', PrecioSemana: 165000, PrecioFinSemana: 180000, TipoPaquete: 'FIJO', PrecioPaquete: 750000, PaqueteMinNoches: 2 },
  { Nombre: 'Grupos de 5 a 8', MinPersonas: 5, MaxPersonas: 8, TipoPrecio: 'PERSONA', PrecioSemana: 145000, PrecioFinSemana: 170000, TipoPaquete: 'FIJO', PrecioPaquete: 750000, PaqueteMinNoches: 2 },
  { Nombre: 'Grupos de 9 a 10', MinPersonas: 9, MaxPersonas: 10, TipoPrecio: 'PERSONA', PrecioSemana: 130000, PrecioFinSemana: 165000, TipoPaquete: '', PrecioPaquete: 0, PaqueteMinNoches: 2 }
];

/* ================================================================
 *  WEB APP
 * ================================================================ */

function doGet() {
  let titulo = APP.NOMBRE;
  try { titulo = getConfig_().NEGOCIO_NOMBRE || titulo; } catch (e) { /* aún sin setup */ }
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle(titulo)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

/**
 * API para el frontend alojado fuera de Apps Script (p. ej. Vercel).
 * Recibe POST {fn, args} y responde JSON {ok, data} o {ok:false, error}.
 * Solo expone funciones públicas y de administración; nunca las de mantenimiento.
 * Las funciones admin siguen validando el token de sesión internamente.
 */
const API_PERMITIDAS_ = /^(getPublicData|quoteReservation|createReservation|lookupReservation|adminLogin|adminLogout|staffAgenda|admin[A-Z]\w*)$/;

function doPost(e) {
  let res;
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const fn = String(body.fn || '');
    const args = Array.isArray(body.args) ? body.args : [];
    if (!API_PERMITIDAS_.test(fn) || typeof globalThis[fn] !== 'function') {
      throw new Error('Operación no permitida.');
    }
    res = { ok: true, data: globalThis[fn].apply(null, args) };
  } catch (err) {
    res = { ok: false, error: String((err && err.message) || err || 'Ocurrió un error.') };
  }
  return ContentService.createTextOutput(JSON.stringify(res === undefined ? null : res))
    .setMimeType(ContentService.MimeType.JSON);
}

/** Menú en la hoja (solo si el script está vinculado a un Sheet). */
function onOpen() {
  try {
    SpreadsheetApp.getUi().createMenu('Reservas')
      .addItem('Crear base (solo la primera vez)', 'setupDemoData')
      .addItem('Actualizar estructura (sin borrar datos)', 'actualizarEstructura')
      .addItem('Diagnóstico de la hoja', 'diagnostico')
      .addItem('Reparar estados mal escritos', 'repararEstados')
      .addItem('Sincronizar Google Calendar', 'syncCalendarManual')
      .addItem('Reparar fórmulas', 'repararFormulas')
      .addItem('Enviar recordatorios ahora', 'enviarRecordatoriosAhora')
      .addToUi();
  } catch (e) { /* standalone */ }
}

/** Solo permite mantenimiento manual desde una cuenta identificada como propietaria. */
function requireEditorOwner_() {
  const active = String(Session.getActiveUser().getEmail() || '').toLowerCase();
  const owner = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  if (!active || !owner || active !== owner) throw new Error('Operación reservada al propietario desde el editor.');
}

/** Límite compartido aproximado: Apps Script no expone la IP del visitante. */
function rateLimit_(scope, max, seconds) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) throw new Error('Hay demasiadas solicitudes. Probá en unos segundos.');
  try {
    const cache = CacheService.getScriptCache();
    const key = 'rl_' + scope + '_' + Math.floor(Date.now() / (seconds * 1000));
    const n = Number(cache.get(key) || 0);
    if (n >= max) throw new Error('Demasiadas solicitudes. Probá más tarde.');
    cache.put(key, String(n + 1), Math.min(seconds + 10, 21600));
  } finally { lock.releaseLock(); }
}

/** Crea las hojas y columnas nuevas de esta versión sin tocar los datos. */
function actualizarEstructura() {
  requireEditorOwner_();
  ensureUpgrades_();
  const msg = 'Estructura actualizada: hojas Tarifas y MovimientosFinancieros, columnas nuevas, claves de Configuracion, Deep Work Day y perfiles.\n' +
    'Las contraseñas antiguas se migraron protegidas a Propiedades del script y se eliminaron de la hoja.\n\n' +
    'Siguiente paso: ejecutá diagnostico() para ver si quedaron estados escritos en la columna equivocada.';
  console.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { /* desde el editor */ }
  return msg;
}

/**
 * Informe de salud de la hoja: qué columnas faltan, si el orden cambió y si
 * hay estados escritos en la columna equivocada por la versión anterior.
 */
function diagnostico() {
  requireEditorOwner_();
  const ss = ss_();
  headersReset_();
  const lineas = ['Diagnóstico de ' + ss.getName(), ''];
  HOJAS.forEach(name => {
    const sh = ss.getSheetByName(name);
    if (!sh) { lineas.push('• ' + name + ': FALTA la hoja. Ejecutá actualizarEstructura().'); return; }
    const head = headers_(name);
    const faltan = SCHEMA[name].filter(h => head.indexOf(h) < 0);
    const presentes = SCHEMA[name].filter(h => head.indexOf(h) >= 0);
    const desordenada = presentes.some((h, i) => i > 0 && head.indexOf(h) < head.indexOf(presentes[i - 1]));
    lineas.push('• ' + name + ': ' + head.length + ' columnas, ' + Math.max(sh.getLastRow() - 1, 0) + ' filas' +
      (faltan.length ? ' | FALTAN: ' + faltan.join(', ') : '') +
      (desordenada ? ' | orden distinto al esquema (ya no importa: todo se ubica por encabezado)' : ''));
  });
  let sospechosas = [];
  try {
    sospechosas = readTable_('Reservas').rows
      .filter(r => APP.ESTADOS.indexOf(String(r.Origen || '').trim()) >= 0);
  } catch (e) { lineas.push('', 'No se pudo revisar Reservas: ' + e.message); }
  if (sospechosas.length) {
    lineas.push('', 'ATENCIÓN: ' + sospechosas.length + ' reserva(s) tienen un estado escrito en la columna Origen.',
      'Eso lo dejó la versión anterior. Ejecutá repararEstados() para moverlos a Estado.', '',
      sospechosas.map(r => '   ' + r.Codigo + ': Origen="' + r.Origen + '"  Estado="' + r.Estado + '"').join('\n'));
  } else {
    lineas.push('', 'No hay estados escritos en la columna equivocada.');
  }
  const msg = lineas.join('\n');
  console.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { /* desde el editor */ }
  return msg;
}

/**
 * Mueve a Estado los valores que la versión anterior escribió en Origen.
 * Solo toca filas cuyo Origen sea exactamente uno de los cuatro estados:
 * los valores legítimos de Origen son Web, Admin o Demo.
 */
function repararEstados() {
  requireEditorOwner_();
  const t = readTable_('Reservas');
  const cambios = [];
  t.rows.forEach(r => {
    const v = String(r.Origen || '').trim();
    if (APP.ESTADOS.indexOf(v) < 0) return;
    setField_('Reservas', r._row, 'Estado', v);
    setField_('Reservas', r._row, 'Origen', 'Admin');
    cambios.push(r.Codigo + ' -> ' + v);
  });
  if (cambios.length) {
    SpreadsheetApp.flush();
    try { syncCalendar_(); } catch (e) { console.warn('Calendar: ' + e); }
  }
  const msg = cambios.length
    ? cambios.length + ' reserva(s) reparadas:\n' + cambios.join('\n')
    : 'No había nada para reparar.';
  console.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { /* desde el editor */ }
  return msg;
}

/* ================================================================
 *  API PÚBLICA (sin autenticación)
 * ================================================================ */

function getPublicData() {
  rateLimit_('public_data', 180, 60);
  const ctx = loadCtx_();
  const c = ctx.config;
  const hoy = today_();
  return {
    hoy: hoy,
    config: {
      nombre: c.NEGOCIO_NOMBRE || APP.NOMBRE,
      eslogan: c.ESLOGAN || '',
      simbolo: c.SIMBOLO || 'Gs.',
      direccion: c.DIRECCION || '',
      telefono: c.TELEFONO || '',
      whatsapp: String(c.WHATSAPP || '').replace(/\D/g, ''),
      checkin: c.CHECKIN_HORA || '14:00',
      checkout: c.CHECKOUT_HORA || '10:00',
      deepWorkSalida: cfgDeepWorkSalida_(c),
      deepWorkPct: cfgDeepWorkPct_(c),
      senaPct: num_(c.SENA_PCT, 0),
      maxDescuento: num_(c.MAX_DESCUENTO, 50),
      heroImg: c.HERO_IMG || '',
      logoUrl: c.LOGO_URL || '',
      logoIcono: c.LOGO_ICONO || 'mountain',
      diasFinde: Object.keys(diasFinde_(c)).map(Number).sort(),
      feriados: Object.keys(feriados_(c)).sort(),
      datosBancarios: cfgText_(c, 'DATOS_BANCARIOS'),
      condiciones: condicionesTexto_(c)
    },
    cabanas: ctx.cabanas.filter(x => isTrue_(x.Activa)).map(x => cabinOut_(x, ctx.tarifas)),
    tipos: ctx.tipos.filter(x => isTrue_(x.Activo)).map(typeOut_),
    promos: ctx.promos
      .filter(p => isTrue_(p.Activa) && (!p.FechaFin || p.FechaFin >= hoy))
      .map(promoOut_),
    resenas: readTable_('Resenas').rows
      .filter(r => isTrue_(r.Visible))
      .map(r => ({ CabanaID: r.CabanaID, Autor: r.Autor, Rating: num_(r.Rating, 0), Comentario: r.Comentario, Fecha: r.Fecha })),
    ocupacion: occupancy_(ctx.reservas, hoy, addDays_(hoy, 430))
  };
}

/** Devuelve el precio calculado por el servidor (sin guardar nada). */
function quoteReservation(p) {
  rateLimit_('quotes', 90, 60);
  return buildQuote_(p || {}, loadCtx_(), false);
}

/** Crea la reserva desde la web pública. */
function createReservation(p) {
  rateLimit_('new_reservations', 12, 60);
  return createCore_(p || {}, { origen: 'Web', admin: false });
}

/** Consulta pública: código + email o teléfono. */
function lookupReservation(codigo, contacto) {
  rateLimit_('lookups', 30, 60);
  const code = String(codigo || '').trim().toUpperCase();
  const ct = String(contacto || '').trim().toLowerCase();
  if (!code || !ct) throw new Error('Ingresá el código y tu email o teléfono.');
  const ctx = loadCtx_();
  const r = ctx.reservas.find(x => String(x.Codigo).trim().toUpperCase() === code);
  const digits = s => String(s || '').replace(/\D/g, '');
  const ok = r && (
    String(r.Email).toLowerCase() === ct ||
    (digits(ct).length >= 8 && digits(r.Telefono) === digits(ct))
  );
  if (!ok) throw new Error('No encontramos una reserva con esos datos.');
  const out = reservaOut_(r, ctx);
  delete out.Notas;
  return out;
}

/* ================================================================
 *  AUTENTICACIÓN Y PERMISOS
 *  Las contraseñas se guardan como hash con sal en Script Properties;
 *  nunca se leen ni se escriben en Google Sheets.
 * ================================================================ */

function adminLogin(user, pass) {
  rateLimit_('logins', 40, 60);
  const cache = CacheService.getScriptCache();
  const u = String(user || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(u) || typeof pass !== 'string' || pass.length > 128)
    throw new Error('Usuario o contraseña incorrectos.');
  const failKey = 'fail_' + u;
  const fails = Number(cache.get(failKey) || 0);
  if (fails >= 5) throw new Error('Demasiados intentos. Esperá 5 minutos y probá de nuevo.');

  // Migra el esquema y las claves antiguas antes de validar el acceso.
  ensureUpgrades_();
  const t = readTable_('Usuarios');
  const row = t.rows.find(r =>
    String(r.Usuario).trim().toLowerCase() === u &&
    isTrue_(r.Activo)
  );
  if (!row || !verifyPassword_(row.Usuario, pass)) {
    rateLimit_('failed_' + u, 5, 300);
    cache.put(failKey, String(fails + 1), 300);
    throw new Error('Usuario o contraseña incorrectos.');
  }
  cache.remove(failKey);
  const rol = normalizarRol_(row.Rol);
  if (!ROLES[rol]) throw new Error('Tu usuario no tiene un perfil válido. Pedile al administrador que lo revise.');
  const token = Utilities.getUuid();
  const sess = { usuario: row.Usuario, nombre: row.Nombre, rol: rol,
    creado: Date.now(), passwordVersion: credential_(row.Usuario).actualizado };
  const acceso = accesoUsuario_(sess, getConfig_());
  if (!acceso.permisos.length) throw new Error('Tu perfil no tiene permisos asignados. Pedile al dueño que lo configure.');
  cache.put('sess_' + token, JSON.stringify(sess), APP.SESSION_TTL);
  setField_('Usuarios', row._row, 'UltimoAcceso', new Date());
  return Object.assign({ token: token }, acceso);
}

function adminLogout(token) {
  if (/^[0-9a-f-]{36}$/i.test(String(token || ''))) CacheService.getScriptCache().remove('sess_' + token);
  return true;
}

function normalizarRol_(rol) {
  const r = String(rol || '').trim().toUpperCase();
  // Compatibilidad para usuarios creados antes de esta versión.
  return r === 'ADMIN' ? 'DUENO' : r;
}

function permisosDeRol_(rol, cfg) {
  const r = normalizarRol_(rol);
  if (r === 'DUENO') return Object.keys(PERMISOS);
  if (!ROLES[r]) return [];
  const clave = 'PERMISOS_' + r;
  const tieneConfiguracion = cfg && Object.prototype.hasOwnProperty.call(cfg, clave);
  const base = tieneConfiguracion ? cfg[clave] : (PERMISOS_PREDETERMINADOS[r] || []);
  const lista = Array.isArray(base) ? base : String(base || '').split(/[,;\s]+/);
  return lista.map(x => String(x || '').trim().toUpperCase())
    .filter(x => !!PERMISOS[x])
    .filter((x, i, a) => a.indexOf(x) === i);
}

function accesoUsuario_(sesion, cfg) {
  const rol = normalizarRol_(sesion.rol);
  const permisos = permisosDeRol_(rol, cfg || getConfig_());
  const tienePanel = permisos.some(p => p !== 'LIMPIEZA');
  return {
    usuario: String(sesion.usuario || ''),
    nombre: String(sesion.nombre || ''),
    rol: rol,
    permisos: permisos,
    panel: tienePanel ? 'admin' : 'limpieza'
  };
}

function requireAccess_(token) {
  const a = accesoUsuario_(auth_(token), getConfig_());
  if (!ROLES[a.rol] || !a.permisos.length) throw new Error('Tu perfil no tiene permiso para esta acción.');
  return a;
}

function requireAdmin_(token, permiso) {
  const a = requireAccess_(token);
  if (permiso) {
    if (a.permisos.indexOf(permiso) < 0) throw new Error('No tenés permiso para esta acción.');
    return a;
  }
  if (a.panel !== 'admin') throw new Error('Tu perfil solo tiene acceso a la agenda de limpieza.');
  return a;
}

function requireOwner_(token) {
  const a = requireAccess_(token);
  if (a.rol !== 'DUENO') throw new Error('Solo el dueño puede cambiar los permisos de los perfiles.');
  return a;
}

function requireStaff_(token) {
  const a = requireAccess_(token);
  if (a.permisos.indexOf('LIMPIEZA') < 0) throw new Error('No tenés permiso para ver la agenda de limpieza.');
  return a;
}

function auth_(token) {
  if (!/^[0-9a-f-]{36}$/i.test(String(token || ''))) throw new Error('SESION_EXPIRADA');
  const cache = CacheService.getScriptCache();
  const raw = cache.get('sess_' + token);
  if (!raw) throw new Error('SESION_EXPIRADA');
  const sesion = JSON.parse(raw);
  const credencial = credential_(sesion.usuario);
  if (!sesion.creado || Date.now() - sesion.creado > APP.SESSION_ABSOLUTE_MS ||
      !credencial || credencial.actualizado !== sesion.passwordVersion) {
    cache.remove('sess_' + token);
    throw new Error('SESION_EXPIRADA');
  }
  // Las bajas y los cambios de rol se aplican en la siguiente llamada,
  // no al terminar las seis horas de sesión.
  const fila = readTable_('Usuarios').rows.find(r =>
    String(r.Usuario || '').trim().toLowerCase() === String(sesion.usuario || '').trim().toLowerCase());
  const rol = fila && normalizarRol_(fila.Rol);
  if (!fila || !isTrue_(fila.Activo) || !ROLES[rol]) {
    cache.remove('sess_' + token);
    throw new Error('SESION_EXPIRADA');
  }
  sesion.nombre = fila.Nombre;
  sesion.rol = rol;
  const renovada = JSON.stringify(sesion);
  cache.put('sess_' + token, renovada, APP.SESSION_TTL); // renueva
  return sesion;
}

function credentialKey_(usuario) {
  return APP.PROP_AUTH_PREFIX + String(usuario || '').trim().toLowerCase();
}

function authPepper_() {
  const props = PropertiesService.getScriptProperties();
  let pepper = props.getProperty(APP.PROP_AUTH_PEPPER);
  if (!pepper) {
    pepper = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty(APP.PROP_AUTH_PEPPER, pepper);
  }
  return pepper;
}

function passwordHash_(password, salt) {
  const bytes = Utilities.computeHmacSha256Signature(
    String(salt) + '\n' + String(password || ''), authPepper_(), Utilities.Charset.UTF_8);
  return Utilities.base64Encode(bytes);
}

function constantTimeEquals_(a, b) {
  a = String(a || ''); b = String(b || '');
  let dif = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) dif |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return dif === 0;
}

function credential_(usuario) {
  const raw = PropertiesService.getScriptProperties().getProperty(credentialKey_(usuario));
  if (!raw) return null;
  try {
    const c = JSON.parse(raw);
    return c && c.salt && c.hash ? c : null;
  } catch (e) { return null; }
}

function verifyPassword_(usuario, password) {
  const c = credential_(usuario);
  return !!c && constantTimeEquals_(passwordHash_(password, c.salt), c.hash);
}

function setPassword_(usuario, password) {
  const salt = Utilities.getUuid() + Utilities.getUuid();
  const c = { v: 1, salt: salt, hash: passwordHash_(password, salt), actualizado: new Date().toISOString() };
  PropertiesService.getScriptProperties().setProperty(credentialKey_(usuario), JSON.stringify(c));
}

function moverCredential_(desde, hasta) {
  const props = PropertiesService.getScriptProperties();
  const origen = credentialKey_(desde);
  const destino = credentialKey_(hasta);
  if (origen === destino) return;
  const raw = props.getProperty(origen);
  if (!raw) throw new Error('No se encontró la credencial protegida de ese usuario. Pedile que restablezca su contraseña.');
  props.setProperty(destino, raw);
  props.deleteProperty(origen);
}

function validarNuevaPassword_(password) {
  if (String(password || '').length < 8) throw new Error('La contraseña debe tener al menos 8 caracteres.');
}

function passwordInicial_() {
  return 'AH-' + Utilities.getUuid().replace(/-/g, '').slice(0, 14);
}

/* ================================================================
 *  FINANZAS Y OCUPACIÓN
 *  Los ingresos se calculan de las reservas por mes de llegada. No representan
 *  cobros confirmados. Los egresos se registran manualmente y pueden anularse.
 * ================================================================ */

const FIN_CATEGORIAS = {
  Egreso: ['Limpieza', 'Mantenimiento', 'Servicios', 'Insumos', 'Comisiones', 'Personal', 'Impuestos', 'Otros egresos']
};

function mesValido_(mes) {
  const s = String(mes || '');
  if (!/^(20\d{2}|2100)-(0[1-9]|1[0-2])$/.test(s)) throw new Error('Mes inválido. Usá AAAA-MM.');
  return s;
}

function fechaValida_(fecha) {
  const s = String(fecha || '');
  const fechaUTC = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + 'T12:00:00Z') : null;
  if (!fechaUTC || isNaN(fechaUTC.getTime()) || fechaUTC.toISOString().slice(0, 10) !== s ||
      s.slice(0, 4) < '2000' || s > today_())
    throw new Error('La fecha debe ser válida y no posterior a hoy.');
  return s;
}

function celdaTextoSeguro_(v, max) {
  const s = clean_(v, max).replace(/[\u0000-\u001f\u007f]/g, ' ');
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function ocupacionMes_(ctx, mes) {
  mesValido_(mes);
  const totalDias = daysInMonth_(mes);
  const porCabana = ctx.cabanas.map(c => ({
    ID: String(c.ID), Nombre: String(c.Nombre || c.ID), Activa: isTrue_(c.Activa),
    noches: new Set(), usosDia: 0
  }));
  const indice = {};
  porCabana.forEach(c => { indice[c.ID] = c; });
  ctx.reservas.forEach(r => {
    const c = indice[String(r.CabanaID)];
    if (!c || r.Estado === 'Cancelada' || !isISO_(r.CheckIn)) return;
    if (String(r.TipoModo).toUpperCase() === 'DIA') {
      if (r.CheckIn.slice(0, 7) === mes) c.usosDia++;
      return;
    }
    const desde = mes + '-01', hasta = addDays_(desde, totalDias);
    const salida = r.CheckOut > r.CheckIn ? r.CheckOut : addDays_(r.CheckIn, 1);
    for (let dia = r.CheckIn > desde ? r.CheckIn : desde; dia < salida && dia < hasta; dia = addDays_(dia, 1)) c.noches.add(dia);
  });
  let noches = 0, disponibles = 0;
  const cabanas = porCabana.map(c => {
    const n = c.noches.size;
    if (c.Activa) { noches += n; disponibles += totalDias; }
    return { ID: c.ID, Nombre: c.Nombre, Activa: c.Activa, noches: n,
      disponibles: c.Activa ? totalDias : 0, usosDia: c.usosDia,
      porcentaje: c.Activa ? Math.round(1000 * n / totalDias) / 10 : null };
  });
  return { mes: mes, noches: noches, disponibles: disponibles,
    porcentaje: disponibles ? Math.round(1000 * noches / disponibles) / 10 : 0,
    cabanas: cabanas };
}

/** Resumen de seis meses y detalle de todos los egresos, incluidos los históricos. */
function adminGetFinance(token) {
  requireAdmin_(token, 'FINANZAS');
  ensureUpgrades_();
  const ctx = loadCtx_();
  const actual = today_().slice(0, 7);
  const meses = Array.from({ length: 6 }, (_, i) =>
    addMonths_(actual + '-01', i - 5).slice(0, 7));
  const mesIndex = Object.create(null);
  const resumen = meses.map(mes => {
    const item = { mes: mes, ingresos: 0, egresos: 0, saldo: 0,
      noches: 0, disponibles: 0, ocupacion: 0 };
    mesIndex[mes] = item;
    return item;
  });
  const cabanas = ctx.cabanas.map(c => ({ ID: String(c.ID), Nombre: String(c.Nombre || c.ID),
    disponible: true, ingresos: 0, egresos: 0, saldo: 0,
    meses: meses.map(mes => ({ mes: mes, ingresos: 0, egresos: 0, saldo: 0,
      noches: 0, disponibles: 0, ocupacion: null })) }));
  const cabIndex = Object.create(null);
  cabanas.forEach(c => { cabIndex[c.ID] = c; });
  const cabanaDe = id => {
    const clave = String(id || '');
    if (!cabIndex[clave]) {
      cabIndex[clave] = { ID: clave, Nombre: 'Cabaña anterior (' + clave + ')',
        disponible: false, ingresos: 0, egresos: 0, saldo: 0,
        meses: meses.map(mes => ({ mes: mes, ingresos: 0, egresos: 0, saldo: 0,
          noches: 0, disponibles: 0, ocupacion: null })) };
      cabanas.push(cabIndex[clave]);
    }
    return cabIndex[clave];
  };
  // El total de cada reserva no cancelada se asigna al mes de llegada.
  ctx.reservas.forEach(r => {
    const mes = String(r.CheckIn || '').slice(0, 7);
    const monto = Number(r.Total);
    if (!mesIndex[mes] || String(r.Estado).trim() === 'Cancelada' ||
        !Number.isFinite(monto) || monto <= 0) return;
    cabanaDe(r.CabanaID).meses[meses.indexOf(mes)].ingresos += monto;
  });
  // Los ingresos manuales legados no se suman para evitar duplicaciones.
  const movimientos = readTable_('MovimientosFinancieros').rows.filter(r => String(r.Tipo) === 'Egreso');
  movimientos.forEach(r => {
    const mes = String(r.Fecha || '').slice(0, 7);
    const monto = Number(r.Monto);
    if (!mesIndex[mes] || String(r.Tipo) !== 'Egreso' ||
        String(r.Estado || 'Activo') !== 'Activo' ||
        !Number.isFinite(monto) || monto <= 0) return;
    cabanaDe(r.CabanaID).meses[meses.indexOf(mes)].egresos += monto;
  });
  // Detalle de ingresos: una fila por reserva, sin duplicar seña ni ingresos legados.
  const ingresos = ctx.reservas.filter(r => isISO_(r.CheckIn) &&
    Number.isFinite(Number(r.Total)) && Number(r.Total) >= 0).map(r => {
    const tipo = findTipo_(ctx, r.TipoModo) || {};
    const nombre = String(r.TipoNombre || tipo.Nombre || r.TipoModo || 'Estadía');
    return { ID: 'IR-' + String(r.ID), ReservaID: String(r.ID), Tipo: 'Ingreso',
      Fecha: String(r.CheckIn), CheckOut: String(r.CheckOut || ''),
      CabanaID: String(r.CabanaID || ''), CabanaNombre: cabanaDe(r.CabanaID).Nombre,
      Categoria: 'Reservas', Concepto: 'Reserva · ' + nombre,
      Monto: Number(r.Total), Referencia: String(r.Codigo || ''), Cliente: String(r.Cliente || ''),
      Origen: String(r.Origen || ''), EstadoReserva: String(r.Estado || '').trim(),
      Estado: String(r.Estado || '').trim() === 'Cancelada' ? 'Anulado' : 'Activo',
      Sena: num_(r.Sena, 0), Creado: String(r.Creado || ''), Notas: String(r.Notas || '') };
  });
  // Incluye cabañas históricas en el selector, aun sin actividad en los últimos seis meses.
  movimientos.forEach(r => cabanaDe(r.CabanaID));
  meses.forEach((mes, i) => {
    const occ = ocupacionMes_(ctx, mes);
    const occCab = Object.create(null);
    occ.cabanas.forEach(c => { occCab[c.ID] = c; });
    resumen[i].noches = occ.noches;
    resumen[i].disponibles = occ.disponibles;
    resumen[i].ocupacion = occ.porcentaje;
    cabanas.forEach(c => {
      const x = c.meses[i], o = occCab[c.ID];
      x.saldo = x.ingresos - x.egresos;
      if (o) {
        x.noches = o.noches;
        x.disponibles = o.disponibles;
        x.ocupacion = o.porcentaje;
      }
      c.ingresos += x.ingresos;
      c.egresos += x.egresos;
      resumen[i].ingresos += x.ingresos;
      resumen[i].egresos += x.egresos;
    });
    resumen[i].saldo = resumen[i].ingresos - resumen[i].egresos;
  });
  cabanas.forEach(c => { c.saldo = c.ingresos - c.egresos; });
  const totales = resumen.reduce((a, m) => ({ ingresos: a.ingresos + m.ingresos,
    egresos: a.egresos + m.egresos, saldo: a.saldo + m.saldo,
    noches: a.noches + m.noches, disponibles: a.disponibles + m.disponibles }),
    { ingresos: 0, egresos: 0, saldo: 0, noches: 0, disponibles: 0 });
  totales.ocupacion = totales.disponibles
    ? Math.round(1000 * totales.noches / totales.disponibles) / 10 : 0;
  return { periodo: { desde: meses[0], hasta: actual }, meses: resumen,
    cabanas: cabanas, totales: totales, categorias: FIN_CATEGORIAS, ingresos: ingresos,
    movimientos: movimientos.map(r => {
      const out = {};
      SCHEMA.MovimientosFinancieros.forEach(k => { out[k] = r[k] == null ? '' : r[k]; });
      out.Estado = r.Estado || 'Activo';
      out.CabanaNombre = (ctx.cabanas.find(c => String(c.ID) === String(r.CabanaID)) || {}).Nombre || r.CabanaID;
      out.Version = financialVersion_(r);
      return out;
    }).sort((a, b) => String(b.Fecha).localeCompare(String(a.Fecha)) || String(b.Creado).localeCompare(String(a.Creado))) };
}

/** Validación compartida por alta y edición; permite conservar cabañas históricas. */
function financialInput_(entrada, anterior) {
  const p = entrada || {};
  const fecha = fechaValida_(p.Fecha);
  const cabanaID = String(p.CabanaID || '');
  if ((!anterior || String(anterior.CabanaID) !== cabanaID) && !readTable_('Cabanas').rows.some(c => String(c.ID) === cabanaID)) throw new Error('Elegí una cabaña válida.');
  if (p.Tipo && String(p.Tipo) !== 'Egreso') throw new Error('Los ingresos se generan desde las reservas.');
  const tipo = 'Egreso';
  const categoria = String(p.Categoria || '');
  if (!FIN_CATEGORIAS[tipo] || FIN_CATEGORIAS[tipo].indexOf(categoria) < 0) throw new Error('Tipo o categoría inválidos.');
  const monto = Number(p.Monto);
  if (!Number.isSafeInteger(monto) || monto <= 0 || monto > 1000000000000) throw new Error('Ingresá un monto entero positivo.');
  const concepto = celdaTextoSeguro_(p.Concepto, 160);
  if (concepto.replace(/^'/, '').length < 3) throw new Error('Describí el movimiento.');
  const referencia = celdaTextoSeguro_(p.Referencia, 80);
  return { Fecha: fecha, CabanaID: cabanaID, Tipo: tipo, Categoria: categoria,
    Concepto: concepto, Monto: monto, Referencia: referencia };
}

// Una copia canónica detecta también cambios hechos directamente en la hoja.
function financialVersion_(r) {
  return JSON.stringify(SCHEMA.MovimientosFinancieros.map(k => r[k] == null ? '' : r[k]));
}

function adminUpdateFinancialMovement(token, id, entrada, version) {
  const user = requireAdmin_(token, 'FINANZAS');
  ensureUpgrades_();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('Hay otra operación en curso. Probá de nuevo.');
  try {
    const r = readTable_('MovimientosFinancieros').rows.find(x => String(x.ID) === String(id));
    if (!r || String(r.Tipo) !== 'Egreso' || String(r.Estado || 'Activo') !== 'Activo')
      throw new Error('Solo se pueden editar egresos activos.');
    if (typeof version !== 'string' || version !== financialVersion_(r))
      throw new Error('Este egreso cambió desde que lo abriste. Actualizá Finanzas y volvé a abrirlo.');
    const cambios = financialInput_(entrada, r);
    let historial;
    try { historial = JSON.parse(r.HistorialCambios || '[]'); } catch (e) { throw new Error('Revisá el historial de este egreso antes de editarlo.'); }
    if (!Array.isArray(historial)) throw new Error('Historial de egreso inválido.');
    const ahora = new Date().toISOString();
    const anterior = {};
    Object.keys(cambios).forEach(k => { anterior[k] = r[k]; });
    historial.push({ fecha: ahora, usuario: user.usuario, anterior: anterior, nuevo: cambios });
    const json = JSON.stringify(historial);
    if (json.length > 45000) throw new Error('El historial alcanzó su límite. Conservá este registro y creá un egreso corregido anulando el anterior.');
    updateObj_('MovimientosFinancieros', r._row, Object.assign({}, cambios, {
      EditadoPor: user.usuario, EditadoEn: ahora, Revision: (Number(r.Revision) || 0) + 1,
      HistorialCambios: json
    }));
  } finally { lock.releaseLock(); }
  return adminGetFinance(token);
}

function adminAddFinancialMovement(token, entrada) {
  const user = requireAdmin_(token, 'FINANZAS');
  ensureUpgrades_();
  const datos = financialInput_(entrada);
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('Hay otra operación en curso. Probá de nuevo.');
  try {
    appendObj_('MovimientosFinancieros', Object.assign({}, datos, { ID: 'MF-' + Utilities.getUuid(), RegistradoPor: user.usuario,
      Creado: new Date(), Estado: 'Activo', AnuladoPor: '', AnuladoEn: '', Revision: 1 }));
  } finally { lock.releaseLock(); }
  return adminGetFinance(token);
}

function adminVoidFinancialMovement(token, id) {
  const user = requireAdmin_(token, 'FINANZAS');
  if (!/^MF-[0-9a-f-]{36}$/i.test(String(id || ''))) throw new Error('Movimiento inválido.');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('Hay otra operación en curso. Probá de nuevo.');
  try {
    const r = readTable_('MovimientosFinancieros').rows.find(x => String(x.ID) === id);
    if (!r || String(r.Estado || 'Activo') !== 'Activo') throw new Error('Este movimiento no existe o ya fue anulado.');
    if (String(r.Tipo) !== 'Egreso') throw new Error('Los ingresos anteriores se conservan como referencia.');
    updateObj_('MovimientosFinancieros', r._row,
      { Estado: 'Anulado', AnuladoPor: user.usuario, AnuladoEn: new Date() });
  } finally { lock.releaseLock(); }
  return adminGetFinance(token);
}

/* ================================================================
 *  API ADMIN
 * ================================================================ */

function adminGetDashboard(token) {
  const user = requireAdmin_(token);
  ensureUpgrades_();
  const ctx = loadCtx_();
  const esDueno = user.rol === 'DUENO';
  const puede = p => user.permisos.indexOf(p) >= 0;
  const configSalida = Object.assign({}, ctx.config);
  if (!esDueno) {
    delete configSalida.PERMISOS_OPERADOR;
    delete configSalida.PERMISOS_LIMPIEZA;
  }
  const hoy = today_();
  const mes = hoy.slice(0, 7);
  const activas = ctx.reservas.filter(r => r.Estado !== 'Cancelada');
  const ocupacion = ocupacionMes_(ctx, mes);

  const stats = {
    llegadasHoy: activas.filter(r => r.CheckIn === hoy).length,
    salidasHoy: activas.filter(r => r.CheckOut === hoy && r.CheckOut !== r.CheckIn).length,
    enCasa: activas.filter(r => r.CheckIn <= hoy && (r.CheckOut > hoy || (r.CheckOut === r.CheckIn && r.CheckIn === hoy)))
      .reduce((a, r) => a + num_(r.Huespedes, 0), 0),
    pendientes: activas.filter(r => r.Estado === 'Pendiente').length,
    ingresosMes: activas.filter(r => String(r.CheckIn).slice(0, 7) === mes).reduce((a, r) => a + num_(r.Total, 0), 0),
    ocupacionMes: ocupacion.porcentaje,
    ocupacionDetalle: ocupacion,
    totalActivas: activas.length
  };

  const cal = cal_(ctx);
  const calId = cal.getId();
  const tz = tz_();

  return {
    user: user,
    permisos: user.permisos,
    esDueno: esDueno,
    hoy: hoy,
    config: configSalida,
    variables: PLANTILLA_VARIABLES,
    tiposPrecio: APP.TIPOS_PRECIO,
    roles: Object.keys(ROLES).map(k => ({ id: k, nombre: ROLES[k].nombre, descripcion: ROLES[k].descripcion })),
    catalogoPermisos: esDueno ? Object.keys(PERMISOS).map(k => ({ id: k, nombre: PERMISOS[k].nombre, descripcion: PERMISOS[k].descripcion })) : [],
    permisosRoles: esDueno ? Object.keys(ROLES).reduce((out, k) => {
      out[k] = permisosDeRol_(k, ctx.config); return out;
    }, {}) : {},
    usuarios: puede('USUARIOS') ? readTable_('Usuarios').rows.map(u => ({
      Usuario: String(u.Usuario), Nombre: u.Nombre, Rol: String(u.Rol || '').toUpperCase(),
      Activo: isTrue_(u.Activo), UltimoAcceso: String(u.UltimoAcceso || '')
    })) : [],
    recordatorios: puede('RECORDATORIOS') ? {
      programado: reminderTriggers_().length > 0,
      proximos: proximosRecordatorios_(ctx, hoy, 14)
    } : { programado: false, proximos: [] },
    waTokenOk: puede('MENSAJES') && !!PropertiesService.getScriptProperties().getProperty(APP.PROP_WA_TOKEN),
    stats: stats,
    calendarId: puede('CALENDARIO') ? calId : '',
    calendarName: puede('CALENDARIO') ? cal.getName() : '',
    calendarUrl: puede('CALENDARIO') ? 'https://calendar.google.com/calendar/r' : '',
    calendarEmbed: puede('CALENDARIO') ? 'https://calendar.google.com/calendar/embed?src=' + encodeURIComponent(calId) +
      '&ctz=' + encodeURIComponent(tz) + '&mode=MONTH&showPrint=0&showTitle=0' : '',
    sheetUrl: esDueno ? ss_().getUrl() : '',
    sheetName: esDueno ? ss_().getName() : '',
    cabanas: ctx.cabanas.map(c => cabinOut_(c, ctx.tarifas)),
    tarifas: ctx.tarifas.map(tarifaOut_).sort(ordenTarifas_),
    tipos: ctx.tipos.map(typeOut_),
    promos: ctx.promos.map(promoOut_),
    reservas: ctx.reservas
      .map(r => reservaOut_(r, ctx))
      .sort((a, b) => (b.CheckIn > a.CheckIn ? 1 : b.CheckIn < a.CheckIn ? -1 : 0))
  };
}

const TOGGLES = {
  Cabanas: ['ID', 'Activa'],
  Tarifas: ['ID', 'Activa'],
  Promociones: ['Codigo', 'Activa'],
  TiposReserva: ['Modo', 'Activo'],
  Resenas: ['ID', 'Visible']
};

const TOGGLE_PERMISOS = {
  Cabanas: 'CABANAS',
  Tarifas: 'PRECIOS',
  Promociones: 'PROMOCIONES',
  TiposReserva: 'CONFIGURACION',
  Resenas: 'CABANAS'
};

function adminToggle(token, sheetName, key, value) {
  requireAdmin_(token, TOGGLE_PERMISOS[sheetName]);
  const def = TOGGLES[sheetName];
  if (!def) throw new Error('Operación no permitida.');
  const t = readTable_(sheetName);
  const row = t.rows.find(r => String(r[def[0]]) === String(key));
  if (!row) throw new Error('No encontramos ese registro.');
  setField_(sheetName, row._row, def[1], value === true || value === 'true');
  return adminGetDashboard(token);
}

function adminSaveCabin(token, c) {
  requireAdmin_(token, 'CABANAS');
  c = c || {};
  const nombre = clean_(c.Nombre, 80);
  if (!nombre) throw new Error('La cabaña necesita un nombre.');
  const cap = int_(c.Capacidad);
  if (cap < 1 || cap > 30) throw new Error('La capacidad debe estar entre 1 y 30 huéspedes.');
  const precio = int_(c.PrecioNoche);

  const t = readTable_('Cabanas');
  const existing = c.ID ? t.rows.find(r => r.ID === c.ID) : null;
  const tieneTarifas = existing
    ? tarifasDe_(readTableSafe_('Tarifas').rows, existing.ID).length > 0
    : false;
  if (precio <= 0 && !tieneTarifas) {
    throw new Error('Ingresá el precio base por noche, o cargá los tramos de precio en la pestaña Tarifas.');
  }
  const obj = existing ? Object.assign({}, existing) : { ID: nextId_(t.rows, 'ID', 'CAB-'), Creado: new Date() };
  Object.assign(obj, {
    Nombre: nombre,
    Descripcion: clean_(c.Descripcion, 1500),
    Capacidad: cap,
    Habitaciones: int_(c.Habitaciones) || 1,
    Banos: int_(c.Banos) || 1,
    PrecioNoche: precio,
    PrecioFinSemana: int_(c.PrecioFinSemana) || precio,
    Amenidades: clean_(Array.isArray(c.Amenidades) ? c.Amenidades.join(', ') : c.Amenidades, 500),
    ImagenURL: normalizeImageUrl_(clean_(c.ImagenURL, 500)),
    Ubicacion: clean_(c.Ubicacion, 200),
    Activa: !(c.Activa === false || c.Activa === 'false')
  });
  if (existing) updateObj_('Cabanas', existing._row, obj);
  else appendObj_('Cabanas', obj);
  return adminGetDashboard(token);
}

/* ---------------- Tarifas por cantidad de personas ---------------- */

function adminSaveTarifa(token, x) {
  requireAdmin_(token, 'PRECIOS');
  ensureUpgrades_();
  x = x || {};
  const cabanas = readTable_('Cabanas').rows;
  const cab = cabanas.find(c => c.ID === x.CabanaID);
  if (!cab) throw new Error('Elegí una cabaña válida.');

  const min = int_(x.MinPersonas);
  const max = int_(x.MaxPersonas) || min;
  if (min < 1) throw new Error('El mínimo de personas debe ser 1 o más.');
  if (max < min) throw new Error('El máximo de personas no puede ser menor al mínimo.');
  if (max > num_(cab.Capacidad, 1)) {
    throw new Error(cab.Nombre + ' admite hasta ' + cab.Capacidad + ' huéspedes. Subí la capacidad o bajá el máximo del tramo.');
  }

  const tipo = String(x.TipoPrecio || 'FIJO').toUpperCase();
  if (APP.TIPOS_PRECIO.indexOf(tipo) < 0) throw new Error('Elegí cómo se calcula el precio: fijo o por persona.');
  const pSem = int_(x.PrecioSemana);
  const pFin = int_(x.PrecioFinSemana) || pSem;
  if (pSem <= 0) throw new Error('Ingresá el precio de lunes a jueves.');

  const pPaq = int_(x.PrecioPaquete);
  let tipoPaq = String(x.TipoPaquete || '').toUpperCase();
  if (pPaq > 0 && APP.TIPOS_PRECIO.indexOf(tipoPaq) < 0) tipoPaq = tipo;
  if (pPaq <= 0) tipoPaq = '';
  const paqMin = pPaq > 0 ? clamp_(int_(x.PaqueteMinNoches) || 2, 2, 30) : 2;

  const t = readTable_('Tarifas');
  const existing = x.ID ? t.rows.find(r => String(r.ID) === String(x.ID)) : null;
  if (x.ID && !existing) throw new Error('No encontramos ese tramo de precio.');

  // Los tramos de una misma cabaña no se pueden superponer.
  const choque = t.rows.find(r =>
    r !== existing && String(r.CabanaID) === String(cab.ID) &&
    min <= num_(r.MaxPersonas, 0) && num_(r.MinPersonas, 0) <= max);
  if (choque) {
    throw new Error('El tramo se superpone con "' + (choque.Nombre || (choque.MinPersonas + ' a ' + choque.MaxPersonas)) +
      '" (' + choque.MinPersonas + ' a ' + choque.MaxPersonas + ' personas). Ajustá los límites.');
  }

  const obj = {
    ID: existing ? existing.ID : nextId_(t.rows, 'ID', 'TAR-'),
    CabanaID: cab.ID,
    Nombre: clean_(x.Nombre, 60) || (min === max ? min + ' personas' : 'Grupos de ' + min + ' a ' + max),
    MinPersonas: min,
    MaxPersonas: max,
    TipoPrecio: tipo,
    PrecioSemana: pSem,
    PrecioFinSemana: pFin,
    TipoPaquete: tipoPaq,
    PrecioPaquete: pPaq,
    PaqueteMinNoches: paqMin,
    Orden: int_(x.Orden) || min,
    Activa: !(x.Activa === false || x.Activa === 'false')
  };
  if (existing) updateObj_('Tarifas', existing._row, obj);
  else appendObj_('Tarifas', obj);
  return adminGetDashboard(token);
}

function adminDeleteTarifa(token, id) {
  requireAdmin_(token, 'PRECIOS');
  const t = readTable_('Tarifas');
  const row = t.rows.find(r => String(r.ID) === String(id));
  if (!row) throw new Error('No encontramos ese tramo de precio.');
  t.sh.deleteRow(row._row);
  return adminGetDashboard(token);
}

/** Crea los tramos sugeridos para una cabaña que todavía no tiene ninguno. */
function adminSeedTarifas(token, cabanaId) {
  requireAdmin_(token, 'PRECIOS');
  ensureUpgrades_();
  const cab = readTable_('Cabanas').rows.find(c => c.ID === cabanaId);
  if (!cab) throw new Error('Elegí una cabaña válida.');
  const t = readTable_('Tarifas');
  if (tarifasDe_(t.rows, cab.ID).length) {
    throw new Error('Esa cabaña ya tiene tramos cargados. Editalos o borralos antes de volver a generar.');
  }
  const cap = num_(cab.Capacidad, 1);
  let seq = 0;
  t.rows.forEach(r => {
    const m = String(r.ID || '').match(/(\d+)$/);
    if (m) seq = Math.max(seq, Number(m[1]));
  });
  TARIFAS_SUGERIDAS.forEach(s => {
    if (s.MinPersonas > cap) return;
    seq++;
    appendObj_('Tarifas', {
      ID: 'TAR-' + String(seq).padStart(2, '0'),
      CabanaID: cab.ID,
      Nombre: s.Nombre,
      MinPersonas: s.MinPersonas,
      MaxPersonas: Math.min(s.MaxPersonas, cap),
      TipoPrecio: s.TipoPrecio,
      PrecioSemana: s.PrecioSemana,
      PrecioFinSemana: s.PrecioFinSemana,
      TipoPaquete: s.TipoPaquete,
      PrecioPaquete: s.PrecioPaquete,
      PaqueteMinNoches: s.PaqueteMinNoches,
      Orden: s.MinPersonas,
      Activa: true
    });
  });
  return adminGetDashboard(token);
}

function adminSavePromo(token, p) {
  requireAdmin_(token, 'PROMOCIONES');
  p = p || {};
  const codigo = clean_(p.Codigo, 30).toUpperCase().replace(/\s+/g, '');
  if (!/^[A-Z0-9_-]{3,30}$/.test(codigo)) throw new Error('El código debe tener de 3 a 30 letras o números, sin espacios.');
  const pct = num_(p.DescuentoPct, 0);
  if (pct <= 0 || pct > 90) throw new Error('El descuento debe estar entre 1% y 90%.');
  const ini = p.FechaInicio || '';
  const fin = p.FechaFin || '';
  if ((ini && !isISO_(ini)) || (fin && !isISO_(fin))) throw new Error('Revisá las fechas de vigencia.');
  if (ini && fin && fin < ini) throw new Error('La fecha de fin debe ser posterior al inicio.');

  const t = readTable_('Promociones');
  const original = String(p._original || '').toUpperCase();
  const existing = original ? t.rows.find(r => String(r.Codigo).toUpperCase() === original) : null;
  const dup = t.rows.find(r => String(r.Codigo).toUpperCase() === codigo && r !== existing);
  if (dup) throw new Error('Ya existe una promoción con ese código.');

  const obj = {
    Codigo: codigo,
    Descripcion: clean_(p.Descripcion, 200),
    DescuentoPct: pct,
    CabanaID: p.CabanaID || 'TODAS',
    TipoModo: p.TipoModo || 'TODOS',
    FechaInicio: ini,
    FechaFin: fin,
    MinNoches: int_(p.MinNoches) || 0,
    Activa: !(p.Activa === false || p.Activa === 'false'),
    Usos: existing ? num_(existing.Usos, 0) : 0
  };
  if (existing) updateObj_('Promociones', existing._row, obj);
  else appendObj_('Promociones', obj);
  return adminGetDashboard(token);
}

function adminDeletePromo(token, codigo) {
  requireAdmin_(token, 'PROMOCIONES');
  const t = readTable_('Promociones');
  const row = t.rows.find(r => String(r.Codigo).toUpperCase() === String(codigo).toUpperCase());
  if (!row) throw new Error('No encontramos esa promoción.');
  t.sh.deleteRow(row._row);
  return adminGetDashboard(token);
}

function adminSaveType(token, x) {
  requireAdmin_(token, 'CONFIGURACION');
  x = x || {};
  const nombre = clean_(x.Nombre, 60);
  if (!nombre) throw new Error('El tipo de reserva necesita un nombre.');
  const modo = String(x.Modo || '').toUpperCase();
  if (APP.MODOS.indexOf(modo) < 0) throw new Error('Elegí una regla válida.');

  const t = readTable_('TiposReserva');
  const editando = String(x._editando || '').toUpperCase();
  const existing = t.rows.find(r => String(r.Modo).toUpperCase() === modo);
  if (!editando && existing) throw new Error('Ya existe un tipo de reserva con esa regla. Editalo en lugar de crear otro.');
  if (editando && editando !== modo) throw new Error('La regla de un tipo existente no se puede cambiar.');

  let min = int_(x.MinNoches);
  let max = int_(x.MaxNoches);
  if (modo === 'FINDE') { min = 2; max = 2; }
  if (modo === 'DIA') { min = 0; max = 0; }
  if (modo !== 'DIA' && min < 1) min = 1;
  if (max && max < min) throw new Error('El máximo de noches no puede ser menor al mínimo.');
  const desc = num_(x.DescuentoPct, 0);
  if (desc < 0 || desc > 60) throw new Error('El descuento del tipo debe estar entre 0% y 60%.');

  const obj = {
    Modo: modo,
    Nombre: nombre,
    Descripcion: clean_(x.Descripcion, 300),
    MinNoches: min,
    MaxNoches: max,
    DescuentoPct: desc,
    Icono: clean_(x.Icono, 30) || 'moon',
    Activo: !(x.Activo === false || x.Activo === 'false')
  };
  if (existing) updateObj_('TiposReserva', existing._row, obj);
  else appendObj_('TiposReserva', obj);
  return adminGetDashboard(token);
}

/**
 * Cambia el estado y/o las notas de una reserva.
 * CORREGIDO: primero valida TODO y después escribe, así una serie programada
 * no queda a medio cambiar; el estado se recorta; y setField_ ubica la columna
 * por encabezado, que es lo que hacía que el estado no cambiara nunca.
 */
function adminUpdateReservation(token, id, cambios) {
  requireAdmin_(token, 'RESERVAS');
  cambios = cambios || {};
  const ctx = loadCtx_();
  const r = ctx.reservas.find(x => String(x.ID) === String(id));
  if (!r) throw new Error('No encontramos esa reserva.');
  const targets = (cambios.aplicarGrupo && r.GrupoID)
    ? ctx.reservas.filter(x => x.GrupoID === r.GrupoID)
    : [r];

  const estado = (cambios.Estado === undefined || cambios.Estado === null || cambios.Estado === '')
    ? '' : String(cambios.Estado).trim();
  if (estado && APP.ESTADOS.indexOf(estado) < 0) throw new Error('Estado no válido: "' + estado + '".');

  if (estado) {
    targets.forEach(x => {
      if (x.Estado === 'Cancelada' && estado !== 'Cancelada') {
        const conf = conflicts_(x.CabanaID, [{ checkIn: x.CheckIn, checkOut: x.CheckOut }], ctx.reservas, x.ID);
        if (conf.length) throw new Error('No se puede reactivar ' + x.Codigo + ': la cabaña ya está ocupada en esas fechas.');
      }
    });
  }

  targets.forEach(x => {
    if (estado && x.Estado !== estado) {
      setField_('Reservas', x._row, 'Estado', estado);
      x.Estado = estado;
    }
    if (typeof cambios.Notas === 'string' && x === r) {
      x.Notas = clean_(cambios.Notas, 800);
      setField_('Reservas', x._row, 'Notas', x.Notas);
    }
    try {
      const ev = upsertEvent_(x, ctx);
      if (ev && ev !== x.EventID) setField_('Reservas', x._row, 'EventID', ev);
    } catch (e) { console.warn('Calendar: ' + e); }
  });
  SpreadsheetApp.flush();
  return adminGetDashboard(token);
}

/**
 * Borra la reserva de la hoja y su evento del calendario.
 * Es la forma segura de eliminar: borrar la fila a mano en el Sheet deja el
 * evento dando vueltas en Google Calendar.
 */
function adminDeleteReservation(token, id, aplicarGrupo) {
  requireAdmin_(token, 'RESERVAS');
  const ctx = loadCtx_();
  const r = ctx.reservas.find(x => String(x.ID) === String(id));
  if (!r) throw new Error('No encontramos esa reserva.');
  const targets = (aplicarGrupo && r.GrupoID)
    ? ctx.reservas.filter(x => x.GrupoID === r.GrupoID)
    : [r];

  const cal = cal_(ctx);
  targets.forEach(x => {
    if (!x.EventID) return;
    try {
      const ev = cal.getEventById(x.EventID);
      if (ev) ev.deleteEvent();
    } catch (e) { console.warn('Evento no borrado (' + x.Codigo + '): ' + e); }
  });

  // De abajo hacia arriba: si se borra primero la fila de arriba, las demás se corren.
  const sh = sheet_('Reservas');
  targets.map(x => x._row).sort((a, b) => b - a).forEach(row => sh.deleteRow(row));
  SpreadsheetApp.flush();

  return { borradas: targets.map(x => String(x.Codigo)), dashboard: adminGetDashboard(token) };
}

/**
 * Borra del calendario los eventos creados por la app cuyo código ya no existe
 * en la hoja. Solo toca eventos cuya descripción tenga "Código: ...".
 */
function adminLimpiarCalendario(token, dias) {
  requireAdmin_(token, 'CALENDARIO');
  const ctx = loadCtx_();
  const cal = cal_(ctx);
  const vivos = {};
  ctx.reservas.forEach(r => { if (r.Codigo) vivos[String(r.Codigo).trim().toUpperCase()] = true; });

  const desde = dateTime_(addDays_(today_(), -180), '00:00');
  const hasta = dateTime_(addDays_(today_(), clamp_(int_(dias) || 400, 30, 730)), '23:59');
  let revisados = 0, borrados = 0;
  cal.getEvents(desde, hasta).forEach(ev => {
    let desc = '';
    try { desc = String(ev.getDescription() || ''); } catch (e) { return; }
    const m = desc.match(/C[oó]digo:\s*([A-Za-z0-9-]+)/);
    if (!m) return;                                   // no lo creó la app: no se toca
    revisados++;
    if (vivos[m[1].trim().toUpperCase()]) return;
    try { ev.deleteEvent(); borrados++; } catch (e) { console.warn('No se pudo borrar: ' + e); }
  });
  return { revisados: revisados, borrados: borrados };
}

function adminCreateReservation(token, p) {
  requireAdmin_(token, 'RESERVAS');
  p = p || {};
  const estado = APP.ESTADOS.indexOf(p.estado) >= 0 ? p.estado : 'Confirmada';
  ensureUpgrades_();
  const manual = p.precioManual === true;
  const canal = manual ? celdaTextoSeguro_(p.canal, 60) : '';
  if (manual && !canal) throw new Error('Indicá el origen de la reserva externa.');
  const res = createCore_(p, { origen: manual ? 'Externa · ' + canal : 'Admin', estado: estado,
    admin: true, manual: manual, silent: !p.notificar });
  return { res: res, dashboard: adminGetDashboard(token) };
}

function adminSaveConfig(token, cfg) {
  requireAdmin_(token, 'CONFIGURACION');
  saveConfigValues_(cfg || {}, CONFIG_AJUSTES);
  return adminGetDashboard(token);
}

function adminSaveMessages(token, cfg) {
  requireAdmin_(token, 'MENSAJES');
  saveConfigValues_(cfg || {}, CONFIG_MENSAJES);
  return adminGetDashboard(token);
}

function saveConfigValues_(cfg, clavesPermitidas) {
  (clavesPermitidas || CONFIG_EDITABLE).forEach(k => {
    if (Object.prototype.hasOwnProperty.call(cfg, k)) {
      let v = clean_(cfg[k], CONFIG_LARGAS.indexOf(k) >= 0 ? 4000 : 500);
      if (k === 'HERO_IMG' || k === 'LOGO_URL') v = normalizeImageUrl_(v);
      if (k === 'FERIADOS') v = normalizaFeriados_(v);
      if (k === 'DIAS_FINDE') v = normalizaDiasFinde_(v);
      setConfig_(k, v);
    }
  });
}

/** Deja una fecha por línea, ordenadas y sin repetidos. Ignora lo que no sea AAAA-MM-DD. */
function normalizaFeriados_(v) {
  const out = [];
  String(v || '').split(/[,;\s]+/).forEach(x => {
    const d = x.trim();
    if (isISO_(d) && out.indexOf(d) < 0) out.push(d);
  });
  return out.sort().join('\n');
}

function normalizaDiasFinde_(v) {
  const out = [];
  String(v || '').split(/[,;\s]+/).forEach(x => {
    const n = parseInt(x, 10);
    if (!isNaN(n) && n >= 0 && n <= 6 && out.indexOf(n) < 0) out.push(n);
  });
  return out.sort().join(',');
}

/* ---------------- Usuarios y perfiles ---------------- */

function adminSaveUser(token, u) {
  const s = requireAdmin_(token, 'USUARIOS');
  ensureUpgrades_();
  u = u || {};
  const usuario = clean_(u.Usuario, 40).toLowerCase().replace(/\s+/g, '');
  if (!/^[a-z0-9._-]{3,40}$/.test(usuario)) throw new Error('El usuario debe tener de 3 a 40 letras, números, puntos o guiones, sin espacios.');
  const rol = normalizarRol_(u.Rol);
  if (!ROLES[rol]) throw new Error('Elegí un perfil válido.');
  const pass = String(u.Password || '');
  if (pass) validarNuevaPassword_(pass);

  const t = readTable_('Usuarios');
  const lower = x => String(x || '').trim().toLowerCase();
  const original = lower(u._original);
  const existing = original ? t.rows.find(r => lower(r.Usuario) === original) : null;
  if (original && !existing) throw new Error('No encontramos ese usuario.');
  if (!existing && !pass) throw new Error('Asigná una contraseña al usuario nuevo.');
  if (t.rows.some(r => r !== existing && lower(r.Usuario) === usuario)) throw new Error('Ya existe un usuario con ese nombre.');
  if (existing && original !== usuario && !pass && !credential_(original)) {
    throw new Error('No se encontró la credencial protegida de ese usuario. Asignale una nueva contraseña al renombrarlo.');
  }

  const activo = !(u.Activo === false || u.Activo === 'false');
  const esYo = existing && lower(existing.Usuario) === lower(s.usuario);
  const esDueno = r => isTrue_(r.Activo) && normalizarRol_(r.Rol) === 'DUENO';
  if (s.rol !== 'DUENO' && (rol === 'DUENO' || (existing && normalizarRol_(existing.Rol) === 'DUENO'))) {
    throw new Error('Solo el dueño puede crear o editar otro usuario dueño.');
  }
  if (esYo && (!activo || rol !== normalizarRol_(existing.Rol) || usuario !== original)) {
    throw new Error('No podés desactivar, renombrar ni quitarle permisos a tu propio usuario.');
  }
  const duenosRestantes = t.rows.filter(r => r !== existing && esDueno(r)).length + (activo && rol === 'DUENO' ? 1 : 0);
  if (duenosRestantes < 1) throw new Error('Tiene que quedar al menos un dueño activo.');

  const obj = {
    Usuario: usuario,
    Nombre: clean_(u.Nombre, 60) || usuario,
    Rol: rol,
    Activo: activo,
    UltimoAcceso: existing ? existing.UltimoAcceso : ''
  };
  if (existing) updateObj_('Usuarios', existing._row, obj);
  else appendObj_('Usuarios', obj);
  if (existing && original !== usuario && !pass) moverCredential_(original, usuario);
  if (pass) {
    setPassword_(usuario, pass);
    if (existing && original !== usuario) PropertiesService.getScriptProperties().deleteProperty(credentialKey_(original));
  }
  return adminGetDashboard(token);
}

/** El dueño configura qué puede hacer Operador y Limpieza. Dueño siempre tiene todo. */
function adminSaveRolePermissions(token, rol, permisos) {
  requireOwner_(token);
  ensureUpgrades_();
  const r = normalizarRol_(rol);
  if (!ROLES[r] || r === 'DUENO') throw new Error('El dueño siempre tiene todos los permisos y no se puede limitar.');
  const lista = (Array.isArray(permisos) ? permisos : []).map(x => String(x || '').trim().toUpperCase())
    .filter(x => !!PERMISOS[x]).filter((x, i, a) => a.indexOf(x) === i);
  if (!lista.length) throw new Error('Elegí al menos un permiso para ' + ROLES[r].nombre + '.');
  setConfig_('PERMISOS_' + r, lista.join(','));
  return adminGetDashboard(token);
}

/**
 * Agenda para el perfil Limpieza (también la puede ver un administrador).
 * Solo datos operativos: cabaña, horarios y cantidad de huéspedes.
 */
function staffAgenda(token, desde, dias) {
  const s = requireStaff_(token);
  const ctx = loadCtx_();
  const cfg = ctx.config;
  const hoy = today_();
  const ini = isISO_(desde) ? desde : hoy;
  const n = clamp_(int_(dias) || 7, 1, 31);
  const fin = addDays_(ini, n - 1);
  const cab = id => ctx.cabanas.find(c => c.ID === id) || {};
  const estadias = [];
  ctx.reservas.forEach(r => {
    if (r.Estado === 'Cancelada' || !isISO_(r.CheckIn)) return;
    const salida = isISO_(r.CheckOut) ? r.CheckOut : r.CheckIn;
    if (salida < ini || r.CheckIn > fin) return;
    const esDia = salida === r.CheckIn;
    const tipo = findTipo_(ctx, r.TipoModo) || {};
    estadias.push({
      cabanaId: r.CabanaID,
      cabana: cab(r.CabanaID).Nombre || r.CabanaID,
      huesped: primerNombre_(r.Cliente),
      huespedes: num_(r.Huespedes, 0),
      tipo: tipo.Nombre || '',
      diaDeCampo: esDia,
      estado: r.Estado,
      entrada: r.CheckIn,
      horaEntrada: String(r.HoraLlegada || cfg.CHECKIN_HORA || '14:00'),
      salida: salida,
      horaSalida: esDia ? cfgDeepWorkSalida_(cfg) : String(cfg.CHECKOUT_HORA || '10:00')
    });
  });
  return {
    agenda: true,
    usuario: { nombre: s.nombre, rol: s.rol, panel: s.panel },
    negocio: cfg.NEGOCIO_NOMBRE || APP.NOMBRE,
    hoy: hoy, desde: ini, dias: n,
    checkin: cfg.CHECKIN_HORA || '14:00',
    checkout: cfg.CHECKOUT_HORA || '10:00',
    cabanas: ctx.cabanas.filter(c => isTrue_(c.Activa)).map(c => ({ ID: c.ID, Nombre: c.Nombre })),
    estadias: estadias
  };
}

function primerNombre_(nombre) {
  const p = String(nombre || '').trim().split(/\s+/);
  if (!p[0]) return '';
  return p[0] + (p[1] ? ' ' + p[1].charAt(0).toUpperCase() + '.' : '');
}

/* ---------------- Recordatorios de viaje ---------------- */

function adminSaveReminders(token, cfg) {
  requireAdmin_(token, 'RECORDATORIOS');
  ensureUpgrades_();
  cfg = cfg || {};
  if (Object.prototype.hasOwnProperty.call(cfg, 'RECORDATORIO_DIAS')) {
    const dias = parseDias_(cfg.RECORDATORIO_DIAS);
    if (isTrue_(cfg.RECORDATORIO_ACTIVO) && !dias.length) throw new Error('Indicá al menos un día de anticipación (por ejemplo 3,1).');
    cfg.RECORDATORIO_DIAS = dias.join(',');
  }
  if (Object.prototype.hasOwnProperty.call(cfg, 'RECORDATORIO_HORA')) {
    cfg.RECORDATORIO_HORA = String(clamp_(int_(cfg.RECORDATORIO_HORA), 0, 23));
  }
  saveConfigValues_(cfg, CONFIG_RECORDATORIOS);
  syncReminderTrigger_(getConfig_());
  return adminGetDashboard(token);
}

function adminRunReminders(token) {
  requireAdmin_(token, 'RECORDATORIOS');
  ensureUpgrades_();
  const r = enviarRecordatoriosCore_({ manual: true });
  return { resultado: r, dashboard: adminGetDashboard(token) };
}

/** Ejecutable desde el editor o el menú de la hoja. */
function enviarRecordatoriosAhora() {
  requireEditorOwner_();
  const r = enviarRecordatoriosCore_({ manual: true });
  console.log(JSON.stringify(r));
  return r;
}

/** Lo ejecuta el activador diario. También se puede correr a mano. */
function enviarRecordatorios(e) {
  const trigger = e && e.triggerUid && reminderTriggers_().some(t =>
    String(t.getUniqueId()) === String(e.triggerUid));
  if (!trigger) requireEditorOwner_();
  return enviarRecordatoriosCore_(e);
}

function enviarRecordatoriosCore_(e) {
  const manual = !!(e && e.manual);
  const ctx = loadCtx_();
  const cfg = ctx.config;
  const res = { enviados: 0, revisados: 0, errores: [] };
  if (!manual && !isTrue_(cfgText_(cfg, 'RECORDATORIO_ACTIVO'))) return res;

  const hoy = today_();
  const porEmail = isTrue_(cfgText_(cfg, 'RECORDATORIO_EMAIL'));
  const porWa = isTrue_(cfgText_(cfg, 'RECORDATORIO_WA_AUTO'));
  const cfgWa = Object.assign({}, cfg, {
    WA_PLANTILLA: cfgText_(cfg, 'WA_PLANTILLA_RECORDATORIO'),
    WA_PARAMS: cfgText_(cfg, 'WA_PARAMS_RECORDATORIO')
  });
  const fecha = Utilities.formatDate(new Date(), tz_(), 'dd/MM/yyyy');

  pendientesRecordatorio_(ctx, hoy).forEach(item => {
    const r = item.r;
    res.revisados++;
    const q = quoteFromRes_(r, ctx);
    const hechos = [];
    if (porEmail && r.Email) {
      try {
        const mail = buildEmail_([r], q, cfg, 'RECORDATORIO_ASUNTO', 'RECORDATORIO_MENSAJE');
        MailApp.sendEmail({ to: r.Email, name: cfg.NEGOCIO_NOMBRE || APP.NOMBRE, subject: mail.subject, htmlBody: mail.html });
        hechos.push('email');
      } catch (err) { res.errores.push(r.Codigo + ' email: ' + (err.message || err)); }
    }
    if (porWa && r.Telefono) {
      try {
        sendWhatsappTemplate_(waPhone_(r.Telefono, cfg), guestVars_([r], q, cfg), cfgWa);
        hechos.push('WhatsApp');
      } catch (err) { res.errores.push(r.Codigo + ' WhatsApp: ' + (err.message || err)); }
    }
    if (hechos.length) res.enviados++;
    const marca = '[Recordatorio ' + item.dias + 'd ' + (hechos.length ? hechos.join('+') : 'sin envío') + ' ' + fecha + ']';
    r.Notas = [r.Notas, marca].filter(String).join(' ');
    setField_('Reservas', r._row, 'Notas', r.Notas);
  });
  return res;
}

function parseDias_(v) {
  const out = [];
  String(v || '').split(/[,;\s]+/).forEach(x => {
    const n = parseInt(x, 10);
    if (!isNaN(n) && n >= 0 && n <= 60 && out.indexOf(n) < 0) out.push(n);
  });
  return out.sort((a, b) => b - a);
}

function estadosRecordatorio_(cfg) {
  return String(cfgText_(cfg, 'RECORDATORIO_ESTADOS') || 'Confirmada').split(',').map(x => x.trim()).filter(String);
}

function yaRecordado_(r, dias) {
  return String(r.Notas || '').indexOf('[Recordatorio ' + dias + 'd ') >= 0;
}

/** Reservas que hoy deben recibir recordatorio. */
function pendientesRecordatorio_(ctx, hoy) {
  const dias = parseDias_(cfgText_(ctx.config, 'RECORDATORIO_DIAS'));
  const estados = estadosRecordatorio_(ctx.config);
  const out = [];
  ctx.reservas.forEach(r => {
    if (!isISO_(r.CheckIn) || estados.indexOf(r.Estado) < 0) return;
    const d = diffDays_(hoy, r.CheckIn);
    if (dias.indexOf(d) >= 0 && !yaRecordado_(r, d)) out.push({ r: r, dias: d });
  });
  return out;
}

/** Calendario de próximos envíos para mostrar en el panel. */
function proximosRecordatorios_(ctx, hoy, horizonte) {
  const dias = parseDias_(cfgText_(ctx.config, 'RECORDATORIO_DIAS'));
  const estados = estadosRecordatorio_(ctx.config);
  const limite = addDays_(hoy, horizonte);
  const out = [];
  ctx.reservas.forEach(r => {
    if (!isISO_(r.CheckIn) || r.CheckIn < hoy || estados.indexOf(r.Estado) < 0) return;
    dias.forEach(d => {
      const f = addDays_(r.CheckIn, -d);
      if (f < hoy || f > limite || yaRecordado_(r, d)) return;
      out.push({
        fecha: f, dias: d, codigo: String(r.Codigo), cliente: r.Cliente, cabanaId: r.CabanaID,
        llegada: r.CheckIn, email: !!r.Email, telefono: !!r.Telefono
      });
    });
  });
  return out.sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0)).slice(0, 60);
}

function quoteFromRes_(r, ctx) {
  const cab = ctx.cabanas.find(c => c.ID === r.CabanaID) || {};
  const tipo = findTipo_(ctx, r.TipoModo) || {};
  return {
    cabanaNombre: cab.Nombre || r.CabanaNombre || r.CabanaID,
    tipoNombre: tipo.Nombre || r.TipoModo,
    tarifaNombre: r.TarifaNombre || '',
    paquete: isTrue_(r.Paquete),
    huespedes: num_(r.Huespedes, 0),
    total: num_(r.Total, 0),
    sena: num_(r.Sena, 0),
    ubicacion: cab.Ubicacion || ''
  };
}

function reminderTriggers_() {
  return ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'enviarRecordatorios');
}

/** Crea o borra el activador diario según la configuración. */
function syncReminderTrigger_(cfg) {
  reminderTriggers_().forEach(t => ScriptApp.deleteTrigger(t));
  if (!isTrue_(cfgText_(cfg, 'RECORDATORIO_ACTIVO'))) return false;
  const hora = clamp_(int_(cfgText_(cfg, 'RECORDATORIO_HORA')), 0, 23);
  ScriptApp.newTrigger('enviarRecordatorios').timeBased().everyDays(1).atHour(hora).inTimezone(tz_()).create();
  return true;
}

/** Guarda o borra el token de WhatsApp (queda en Propiedades del script, no en la hoja). */
function adminSaveWaToken(token, waToken) {
  requireAdmin_(token, 'MENSAJES');
  const props = PropertiesService.getScriptProperties();
  const t = String(waToken || '').trim();
  if (t) props.setProperty(APP.PROP_WA_TOKEN, t);
  else props.deleteProperty(APP.PROP_WA_TOKEN);
  return adminGetDashboard(token);
}

/** Envía la plantilla de WhatsApp a un número de prueba usando los valores del formulario. */
function adminTestWhatsapp(token, telefono, borrador) {
  requireAdmin_(token, 'MENSAJES');
  const ctx = loadCtx_();
  const cfg = Object.assign({}, ctx.config);
  ['WA_CODIGO_PAIS', 'WA_PHONE_ID', 'WA_PLANTILLA', 'WA_IDIOMA', 'WA_PARAMS', 'DATOS_BANCARIOS', 'CONDICIONES_RESERVA'].forEach(k => {
    if (borrador && Object.prototype.hasOwnProperty.call(borrador, k)) cfg[k] = clean_(borrador[k], 4000);
  });
  const to = waPhone_(telefono, cfg);
  if (to.length < 8) throw new Error('Ingresá un número de WhatsApp válido para la prueba.');
  const ej = ejemploReserva_(ctx, cfg);
  const id = sendWhatsappTemplate_(to, guestVars_(ej.lista, ej.q, cfg), cfg);
  return { enviadoA: to, id: id };
}

function ejemploReserva_(ctx, cfg) {
  const hoy = today_();
  const cab = ctx.cabanas[0] || {};
  const tar = tarifaPara_(tarifasDe_(ctx.tarifas, cab.ID), 2);
  return {
    lista: [{
      Codigo: APP.PREFIJO_CODIGO + 'EJEMPLO', Cliente: 'Huésped de Prueba', Email: '', Telefono: '0981 000 000',
      CheckIn: addDays_(hoy, 10), CheckOut: addDays_(hoy, 12), Estado: cfg.ESTADO_INICIAL || 'Pendiente'
    }],
    q: {
      cabanaNombre: cab.Nombre || 'Cabaña', tipoNombre: 'Estadía estándar',
      tarifaNombre: tar ? String(tar.Nombre || '') : '', paquete: false,
      huespedes: 2, total: 1000000, sena: Math.round(1000000 * num_(cfg.SENA_PCT, 0) / 100)
    }
  };
}

/** Envía al dueño un email de prueba con los textos del formulario (guardados o no). */
function adminSendTestEmail(token, borrador) {
  requireAdmin_(token, 'MENSAJES');
  const ctx = loadCtx_();
  const cfg = Object.assign({}, ctx.config);
  ['DATOS_BANCARIOS', 'CONDICIONES_RESERVA', 'ASUNTO_HUESPED', 'MENSAJE_HUESPED'].forEach(k => {
    if (borrador && Object.prototype.hasOwnProperty.call(borrador, k)) cfg[k] = clean_(borrador[k], 4000);
  });
  const ej = ejemploReserva_(ctx, cfg);
  const mail = buildGuestEmail_(ej.lista, ej.q, cfg);
  const to = cfg.EMAIL_NOTIF || Session.getEffectiveUser().getEmail();
  if (!to) throw new Error('No hay un email de destino. Completá "Email para avisos" en Ajustes.');
  MailApp.sendEmail({ to: to, name: cfg.NEGOCIO_NOMBRE || APP.NOMBRE, subject: '[PRUEBA] ' + mail.subject, htmlBody: mail.html });
  return { enviadoA: to };
}

function adminChangePassword(token, actual, nueva) {
  const s = auth_(token);
  const t = readTable_('Usuarios');
  const row = t.rows.find(r => String(r.Usuario) === String(s.usuario));
  if (!row || !isTrue_(row.Activo) || !verifyPassword_(s.usuario, actual)) throw new Error('La contraseña actual no coincide.');
  validarNuevaPassword_(nueva);
  setPassword_(s.usuario, nueva);
  return true;
}

function adminSyncCalendar(token) {
  requireAdmin_(token, 'CALENDARIO');
  return { sincronizados: syncCalendar_() };
}

function syncCalendarManual() {
  requireEditorOwner_();
  const n = syncCalendar_();
  console.log('Eventos sincronizados: ' + n);
  return n;
}

/* ================================================================
 *  PRECIOS: tramos por cantidad de personas
 * ================================================================ */

/** Días de la semana que se cobran a tarifa de fin de semana. 0=domingo ... 6=sábado. */
function diasFinde_(cfg) {
  const raw = String(cfgText_(cfg, 'DIAS_FINDE') || '').trim();
  const out = {};
  (raw || '5,6,0').split(/[,;\s]+/).forEach(x => {
    const n = parseInt(x, 10);
    if (!isNaN(n) && n >= 0 && n <= 6) out[n] = true;
  });
  return Object.keys(out).length ? out : { 5: true, 6: true, 0: true };
}

function feriados_(cfg) {
  const out = {};
  String(cfgText_(cfg, 'FERIADOS') || '').split(/[,;\s]+/).forEach(x => {
    const d = x.trim();
    if (isISO_(d)) out[d] = true;
  });
  return out;
}

/** Contexto de calendario para no releer la configuración por cada noche. */
function wkCtx_(cfg) {
  return { dias: diasFinde_(cfg), feriados: feriados_(cfg) };
}

function esFinde_(iso, wk) {
  return !!(wk.feriados[iso] || wk.dias[dow_(iso)]);
}

/** Tramos activos de una cabaña, ordenados de menor a mayor cantidad de personas. */
function tarifasDe_(tarifas, cabanaId) {
  return (tarifas || [])
    .filter(t => String(t.CabanaID) === String(cabanaId) && isTrue_(t.Activa))
    .sort((a, b) => num_(a.MinPersonas, 0) - num_(b.MinPersonas, 0) || num_(a.Orden, 0) - num_(b.Orden, 0));
}

/** Tramo que corresponde a esa cantidad de huéspedes (null si no hay ninguno). */
function tarifaPara_(tarifasCab, huespedes) {
  const n = num_(huespedes, 0);
  return (tarifasCab || []).find(t =>
    n >= num_(t.MinPersonas, 1) && n <= (num_(t.MaxPersonas, 0) || num_(t.MinPersonas, 1))) || null;
}

/**
 * Deep Work Day admite una sola persona, pero se cobra siempre con la
 * tarifa de pareja. Esto también protege el cálculo si el tramo Parejas
 * se configura en el futuro como "2 personas" en vez de "1 a 2".
 */
function huespedesParaTarifa_(modo, huespedes) {
  const n = Math.max(num_(huespedes, 1), 1);
  return String(modo || '').toUpperCase() === 'DIA' && n === 1 ? 2 : n;
}

/** Precio de una noche. Si no hay tramo, cae en los precios base de la cabaña. */
function precioNocheDe_(tarifa, cab, huespedes, finde, paquete) {
  const n = Math.max(num_(huespedes, 1), 1);
  if (!tarifa) {
    const base = num_(cab.PrecioNoche, 0);
    return Math.round(finde ? num_(cab.PrecioFinSemana, base) : base);
  }
  if (paquete) {
    const p = num_(tarifa.PrecioPaquete, 0);
    return Math.round(String(tarifa.TipoPaquete || '').toUpperCase() === 'PERSONA' ? p * n : p);
  }
  const sem = num_(tarifa.PrecioSemana, 0);
  const base = finde ? num_(tarifa.PrecioFinSemana, sem) : sem;
  return Math.round(String(tarifa.TipoPrecio || 'FIJO').toUpperCase() === 'PERSONA' ? base * n : base);
}

/** ¿Corresponde el paquete entre semana? Todas las noches entre semana y suficientes noches corridas. */
function aplicaPaquete_(tarifa, fechas, wk) {
  if (!tarifa) return false;
  if (num_(tarifa.PrecioPaquete, 0) <= 0) return false;
  const min = num_(tarifa.PaqueteMinNoches, 2) || 2;
  if (!fechas.length || fechas.length < min) return false;
  return fechas.every(d => !esFinde_(d, wk));
}

/** Precio más bajo por noche de una cabaña (para el "desde" de las tarjetas). */
function precioDesde_(cab, tarifas) {
  const lista = tarifasDe_(tarifas, cab.ID);
  if (!lista.length) return num_(cab.PrecioNoche, 0);
  let min = 0;
  lista.forEach(t => {
    const n = num_(t.MinPersonas, 1);
    const p = precioNocheDe_(t, cab, n, false, false);
    if (p > 0 && (!min || p < min)) min = p;
  });
  return min || num_(cab.PrecioNoche, 0);
}

function ordenTarifas_(a, b) {
  if (a.CabanaID !== b.CabanaID) return a.CabanaID < b.CabanaID ? -1 : 1;
  return (a.MinPersonas - b.MinPersonas) || (a.Orden - b.Orden);
}

/* ================================================================
 *  NÚCLEO DE RESERVAS
 * ================================================================ */

function loadCtx_() {
  return {
    config: getConfig_(),
    cabanas: readTable_('Cabanas').rows,
    tarifas: readTableSafe_('Tarifas').rows,
    tipos: readTable_('TiposReserva').rows,
    promos: readTable_('Promociones').rows,
    reservas: readTable_('Reservas').rows
  };
}

function buildQuote_(p, ctx, isAdmin) {
  const cab = ctx.cabanas.find(c => c.ID === p.cabanaId);
  if (!cab) throw new Error('Elegí una cabaña.');
  if (!isTrue_(cab.Activa) && !isAdmin) throw new Error('Esta cabaña no está disponible por el momento.');
  const tipo = findTipo_(ctx, p.tipo);
  if (!tipo || (!isTrue_(tipo.Activo) && !isAdmin)) throw new Error('Elegí un tipo de reserva válido.');

  const modo = String(tipo.Modo).toUpperCase();
  const huespedes = int_(p.huespedes);
  if (huespedes < 1) throw new Error('Indicá la cantidad de huéspedes.');
  if (huespedes > num_(cab.Capacidad, 1)) throw new Error(cab.Nombre + ' admite hasta ' + cab.Capacidad + ' huéspedes.');

  // Deep Work Day para una persona toma la tarifa y el precio de una pareja.
  const huespedesTarifa = huespedesParaTarifa_(modo, huespedes);
  const tarifasCab = tarifasDe_(ctx.tarifas, cab.ID);
  const tarifa = tarifaPara_(tarifasCab, huespedesTarifa);
  if (tarifasCab.length && !tarifa) {
    throw new Error('Para ' + huespedesTarifa + (huespedesTarifa === 1 ? ' huésped' : ' huéspedes') +
      ' no hay una tarifa cargada en ' + cab.Nombre + '. Escribinos y la armamos a medida.');
  }

  if (!isISO_(p.checkIn)) throw new Error('Elegí la fecha de llegada.');
  if (p.checkIn < today_() && !isAdmin) throw new Error('La fecha de llegada ya pasó.');

  const minN = num_(tipo.MinNoches, 0);
  const maxN = num_(tipo.MaxNoches, 0);
  let checkOut = p.checkOut;

  if (modo === 'DIA') {
  // 0=domingo, 1=lunes, ..., 6=sábado
  const dia = dow_(p.checkIn);

  if (dia < 1 || dia > 4) {
    throw new Error('Deep Work Day está disponible únicamente de lunes a jueves.');
  }

  checkOut = p.checkIn;
}else if (modo === 'FINDE') {
    if (dow_(p.checkIn) !== 5) throw new Error('El paquete fin de semana empieza un viernes.');
    checkOut = addDays_(p.checkIn, 2);
  } else if (!isISO_(checkOut)) {
    throw new Error('Elegí la fecha de salida.');
  }

  const noches = modo === 'DIA' ? 0 : diffDays_(p.checkIn, checkOut);
  if (modo !== 'DIA') {
    if (noches < 1) throw new Error('La salida debe ser posterior a la llegada.');
    if (minN && noches < minN) throw new Error(tipo.Nombre + ' requiere al menos ' + minN + ' noches.');
    if (maxN && noches > maxN) throw new Error(tipo.Nombre + ' permite hasta ' + maxN + ' noches.');
  }
  const hora = /^\d{2}:\d{2}$/.test(p.hora || '') ? p.hora : '';
  if (modo === 'DIA' && !hora) throw new Error('Elegí el horario de llegada.');

  // Ocurrencias (programadas / recurrentes)
  let frecuencia = '';
  let ocurrencias = [{ checkIn: p.checkIn, checkOut: checkOut }];
  if (modo === 'RECURRENTE') {
    frecuencia = APP.FRECUENCIAS.indexOf(p.frecuencia) >= 0 ? p.frecuencia : 'SEMANAL';
    const rep = clamp_(int_(p.repeticiones) || 2, 2, 12);
    if (frecuencia === 'SEMANAL' && noches >= 7) throw new Error('Con repetición semanal, cada estadía debe durar menos de 7 noches.');
    if (frecuencia === 'QUINCENAL' && noches >= 14) throw new Error('Con repetición quincenal, cada estadía debe durar menos de 14 noches.');
    if (frecuencia === 'MENSUAL' && noches >= 28) throw new Error('Con repetición mensual, cada estadía debe durar menos de 28 noches.');
    ocurrencias = [];
    for (let i = 0; i < rep; i++) {
      const ci = frecuencia === 'MENSUAL'
        ? addMonths_(p.checkIn, i)
        : addDays_(p.checkIn, i * (frecuencia === 'QUINCENAL' ? 14 : 7));
      ocurrencias.push({ checkIn: ci, checkOut: addDays_(ci, noches) });
    }
  }

  // Precios: tramo por cantidad de personas + tarifa de fin de semana/feriados + paquete
  const wk = wkCtx_(ctx.config);
  const pctDeepWork = cfgDeepWorkPct_(ctx.config);
  const det = { nochesSemana: 0, nochesFinde: 0, nochesPaquete: 0, precioSemana: 0, precioFinde: 0, precioPaquete: 0, deepWork: 0 };
  det.precioSemana = precioNocheDe_(tarifa, cab, huespedesTarifa, false, false);
  det.precioFinde = precioNocheDe_(tarifa, cab, huespedesTarifa, true, false);
  det.precioPaquete = tarifa && num_(tarifa.PrecioPaquete, 0) > 0
    ? precioNocheDe_(tarifa, cab, huespedesTarifa, false, true) : 0;

  ocurrencias.forEach(o => {
    let sub = 0;
    if (modo === 'DIA') {
      const base = precioNocheDe_(tarifa, cab, huespedesTarifa, esFinde_(o.checkIn, wk), false);
      // El porcentaje se aplica sobre la tarifa diaria del tramo de huéspedes
      // correspondiente y respeta si esa fecha se cobra como entre semana o finde.
      sub = Math.round(base * pctDeepWork / 100);
      det.deepWork = sub;
      o.paquete = false;
    } else {
      const fechas = [];
      for (let i = 0; i < noches; i++) fechas.push(addDays_(o.checkIn, i));
      o.paquete = aplicaPaquete_(tarifa, fechas, wk);
      fechas.forEach(f => {
        const finde = esFinde_(f, wk);
        sub += precioNocheDe_(tarifa, cab, huespedesTarifa, finde, o.paquete);
        if (o.paquete) det.nochesPaquete++;
        else if (finde) det.nochesFinde++;
        else det.nochesSemana++;
      });
    }
    o.subtotal = sub;
  });
  const subtotal = ocurrencias.reduce((a, o) => a + o.subtotal, 0);
  const paquete = ocurrencias.some(o => o.paquete);

  // Promoción
  let promo = null;
  let promoMsg = '';
  if (p.promo) {
    const code = String(p.promo).trim().toUpperCase();
    promo = ctx.promos.find(x => String(x.Codigo).trim().toUpperCase() === code) || null;
    promoMsg = promoError_(promo, cab, tipo, p.checkIn, noches);
    if (promoMsg) promo = null;
  }

  const tipoPct = num_(tipo.DescuentoPct, 0);
  const promoPct = promo ? num_(promo.DescuentoPct, 0) : 0;
  const pct = Math.min(tipoPct + promoPct, num_(ctx.config.MAX_DESCUENTO, 50));
  const senaPct = num_(ctx.config.SENA_PCT, 0);
  ocurrencias.forEach(o => {
    o.descuento = Math.round(o.subtotal * pct / 100);
    o.total = o.subtotal - o.descuento;
    o.sena = Math.round(o.total * senaPct / 100);
  });
  const descuento = ocurrencias.reduce((a, o) => a + o.descuento, 0);
  const total = subtotal - descuento;

  return {
    cabanaId: cab.ID, cabanaNombre: cab.Nombre, ubicacion: cab.Ubicacion || '',
    tipo: modo, tipoNombre: tipo.Nombre, modo: modo,
    tarifaId: tarifa ? String(tarifa.ID) : '', tarifaNombre: tarifa ? String(tarifa.Nombre || '') : '',
    tarifa: tarifa ? tarifaOut_(tarifa) : null, paquete: paquete, detalle: det,
    huespedes: huespedes, checkIn: p.checkIn, checkOut: checkOut, hora: hora,
    noches: noches, frecuencia: frecuencia, ocurrencias: ocurrencias,
    subtotal: subtotal, tipoPct: tipoPct, promoPct: promoPct, pct: pct,
    promoCodigo: promo ? promo.Codigo : '', promoMsg: promoMsg,
    descuento: descuento, total: total,
    senaPct: senaPct, sena: ocurrencias.reduce((a, o) => a + o.sena, 0)
  };
}

function promoError_(promo, cab, tipo, checkIn, noches) {
  if (!promo) return 'Ese código de promoción no existe.';
  if (!isTrue_(promo.Activa)) return 'Ese código de promoción no está activo.';
  if (promo.FechaInicio && checkIn < promo.FechaInicio) return 'El código es válido para llegadas desde ' + promo.FechaInicio + '.';
  if (promo.FechaFin && checkIn > promo.FechaFin) return 'El código venció el ' + promo.FechaFin + '.';
  if (promo.CabanaID && promo.CabanaID !== 'TODAS' && promo.CabanaID !== cab.ID) return 'El código no aplica a esta cabaña.';
  if (promo.TipoModo && promo.TipoModo !== 'TODOS' && String(promo.TipoModo).toUpperCase() !== String(tipo.Modo).toUpperCase()) return 'El código no aplica a este tipo de reserva.';
  if (num_(promo.MinNoches, 0) && noches < num_(promo.MinNoches, 0)) return 'El código requiere al menos ' + promo.MinNoches + (num_(promo.MinNoches, 0) === 1 ? ' noche.' : ' noches.');
  return '';
}

/** Reserva externa por rango, independiente de tarifas y descuentos publicados.
 * Solo createCore_ con opt.admin + opt.manual (fijados por el servidor) la utiliza.
 */
function buildManualQuote_(p, ctx) {
  const cab = ctx.cabanas.find(c => String(c.ID) === String(p.cabanaId));
  if (!cab) throw new Error('Elegí una cabaña válida.');
  const guests = Number(p.huespedes);
  if (!Number.isSafeInteger(guests) || guests < 1 || guests > Number(cab.Capacidad))
    throw new Error('Revisá la cantidad de huéspedes y la capacidad de la cabaña.');
  const validDate = s => {
    if (!isISO_(s)) return false;
    const d = new Date(s + 'T12:00:00Z');
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s && s >= '2000-01-01' && s <= '2100-12-31';
  };
  if (!validDate(p.checkIn) || !validDate(p.checkOut)) throw new Error('Ingresá fechas válidas de llegada y salida.');
  const noches = diffDays_(p.checkIn, p.checkOut);
  if (noches < 1 || noches > 730) throw new Error('La salida debe ser posterior a la llegada (máximo 730 noches).');
  const amount = (value, label) => {
    if (value === '' || value === null || value === undefined) throw new Error('Completá ' + label + '.');
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 0 || n > 1000000000000) throw new Error(label + ': ingresá un importe entero igual o mayor a cero.');
    return n;
  };
  const total = amount(p.totalManual, 'el precio total');
  const sena = amount(p.senaManual, 'la seña');
  if (sena > total) throw new Error('La seña no puede superar el precio total.');
  if (p.promo) throw new Error('El precio manual es final; no se le aplican promociones.');
  const hora = String(p.hora || ctx.config.CHECKIN_HORA || '14:00');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(hora)) throw new Error('Revisá la hora de llegada.');
  return { cabanaId: cab.ID, cabanaNombre: cab.Nombre, ubicacion: cab.Ubicacion || '',
    tipo: 'RANGO', tipoNombre: 'Reserva externa', modo: 'RANGO',
    tarifaId: '', tarifaNombre: 'Precio manual · reserva externa', tarifa: null, paquete: false,
    detalle: {}, huespedes: guests, checkIn: p.checkIn, checkOut: p.checkOut, hora: hora,
    noches: noches, frecuencia: '',
    ocurrencias: [{ checkIn: p.checkIn, checkOut: p.checkOut, subtotal: total, descuento: 0,
      total: total, sena: sena, paquete: false }],
    subtotal: total, tipoPct: 0, promoPct: 0, pct: 0, promoCodigo: '', promoMsg: '',
    descuento: 0, total: total, senaPct: total ? Math.round(sena * 100 / total) : 0, sena: sena };
}

function createCore_(p, opt) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('Hay muchas reservas en curso. Probá de nuevo en unos segundos.');
  try {
    const cliente = clean_(p.cliente, 80);
    const email = clean_(p.email, 120).toLowerCase();
    const telefono = clean_(p.telefono, 30);
    if (cliente.length < 3) throw new Error('Ingresá tu nombre completo.');
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Revisá el email: no tiene un formato válido.');
    if (!opt.admin) {
      if (!email) throw new Error('Ingresá tu email para recibir la confirmación.');
      if (telefono.replace(/\D/g, '').length < 6) throw new Error('Ingresá un teléfono de contacto válido.');
    }

    const ctx = loadCtx_();
    let notaCondiciones = '';
    if (!opt.admin && condicionesTexto_(ctx.config).trim()) {
      if (p.aceptaCondiciones !== true) throw new Error('Para reservar tenés que aceptar las condiciones de la reserva.');
      notaCondiciones = 'Aceptó condiciones ' + Utilities.formatDate(new Date(), tz_(), 'dd/MM/yyyy HH:mm') + '.';
    }
    const q = opt.admin && opt.manual ? buildManualQuote_(p, ctx) : buildQuote_(p, ctx, !!opt.admin);
    if (p.promo && q.promoMsg) throw new Error(q.promoMsg);

    const conf = conflicts_(q.cabanaId, q.ocurrencias, ctx.reservas, null);
    if (conf.length) {
      throw new Error('La cabaña ya está ocupada el ' + conf.map(humanDate_).join(', ') + '. Elegí otras fechas u otra cabaña.');
    }

    const grupo = q.ocurrencias.length > 1 ? 'G-' + shortId_() : '';
    const estado = opt.estado || ctx.config.ESTADO_INICIAL || 'Pendiente';
    const horaDefault = q.modo === 'DIA' ? q.hora : (q.hora || ctx.config.CHECKIN_HORA || '14:00');
    const notas = [clean_(p.notas, 500), notaCondiciones].filter(String).join(' ');
    const creados = [];

    // Códigos ya usados, para que makeCode_ no repita la llave de consulta del huésped.
    const usados = {};
    ctx.reservas.forEach(x => { if (x.Codigo) usados[String(x.Codigo).trim().toUpperCase()] = true; });

    q.ocurrencias.forEach((o, i) => {
      const obj = {
        ID: 'R-' + shortId_(),
        Codigo: makeCode_(usados),
        GrupoID: grupo,
        CabanaID: q.cabanaId,
        TipoModo: q.tipo,
        Cliente: cliente,
        Email: email,
        Telefono: telefono,
        Huespedes: q.huespedes,
        CheckIn: o.checkIn,
        CheckOut: o.checkOut,
        HoraLlegada: horaDefault,
        Noches: q.noches,
        TarifaID: q.tarifaId,
        TarifaNombre: q.tarifaNombre,
        Paquete: !!o.paquete,
        Subtotal: o.subtotal,
        Descuento: o.descuento,
        Total: o.total,
        Sena: o.sena,
        PromoCodigo: q.promoCodigo,
        Estado: estado,
        EventID: '',
        Notas: (notas + (grupo ? ' [Estadía ' + (i + 1) + ' de ' + q.ocurrencias.length + ']' : '')).trim(),
        Origen: opt.origen || 'Web',
        Creado: new Date()
      };
      obj._row = appendObj_('Reservas', obj);
      try {
        const ev = upsertEvent_(obj, ctx);
        if (ev) { obj.EventID = ev; setField_('Reservas', obj._row, 'EventID', ev); }
      } catch (e) { console.warn('Calendar: ' + e); }
      ctx.reservas.push(obj);
      creados.push(obj);
    });

    if (q.promoCodigo) incrementPromo_(q.promoCodigo);
    SpreadsheetApp.flush();
    if (!opt.silent) notify_(creados, q, ctx);

    const hoy = today_();
    return {
      ok: true,
      codigo: creados[0].Codigo,
      codigos: creados.map(c => c.Codigo),
      grupo: grupo,
      estado: estado,
      quote: q,
      ocupacion: occupancy_(ctx.reservas, hoy, addDays_(hoy, 430))
    };
  } finally {
    lock.releaseLock();
  }
}

/** Devuelve las fechas de llegada que chocan con reservas existentes. */
function conflicts_(cabanaId, ocurrencias, reservas, excludeId) {
  const out = [];
  ocurrencias.forEach(o => {
    const s = o.checkIn;
    const e = o.checkOut > o.checkIn ? o.checkOut : addDays_(o.checkIn, 1);
    const hit = reservas.some(r => {
      if (r.CabanaID !== cabanaId || r.Estado === 'Cancelada' || r.ID === excludeId || !r.CheckIn) return false;
      const rs = r.CheckIn;
      const re = r.CheckOut > r.CheckIn ? r.CheckOut : addDays_(r.CheckIn, 1);
      return rs < e && s < re;
    });
    if (hit && out.indexOf(s) < 0) out.push(s);
  });
  return out;
}

/** Mapa { CabanaID: [fechas ocupadas] } (noches ocupadas). */
function occupancy_(reservas, from, to) {
  const map = {};
  reservas.forEach(r => {
    if (r.Estado === 'Cancelada' || !isISO_(r.CheckIn)) return;
    nightsOf_(r).forEach(d => {
      if (d >= from && d <= to) {
        map[r.CabanaID] = map[r.CabanaID] || {};
        map[r.CabanaID][d] = 1;
      }
    });
  });
  const out = {};
  Object.keys(map).forEach(k => { out[k] = Object.keys(map[k]).sort(); });
  return out;
}

function nightsOf_(r) {
  const ci = r.CheckIn;
  const co = isISO_(r.CheckOut) ? r.CheckOut : ci;
  const n = diffDays_(ci, co);
  if (n <= 0) return [ci];
  const arr = [];
  for (let i = 0; i < n; i++) arr.push(addDays_(ci, i));
  return arr;
}

function incrementPromo_(codigo) {
  const t = readTable_('Promociones');
  const row = t.rows.find(r => String(r.Codigo).toUpperCase() === String(codigo).toUpperCase());
  if (row) setField_('Promociones', row._row, 'Usos', num_(row.Usos, 0) + 1);
}

/* ================================================================
 *  GOOGLE CALENDAR
 * ================================================================ */

function cal_(ctx) {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty(APP.PROP_CAL) || (ctx ? ctx.config.CALENDAR_ID : getConfig_().CALENDAR_ID);
  let cal = null;
  if (id) { try { cal = CalendarApp.getCalendarById(id); } catch (e) { cal = null; } }
  return cal || CalendarApp.getDefaultCalendar();
}

function upsertEvent_(r, ctx) {
  const cal = cal_(ctx);
  const cfg = ctx.config;
  const cab = ctx.cabanas.find(c => c.ID === r.CabanaID) || {};
  const tipo = findTipo_(ctx, r.TipoModo) || {};
  const simbolo = cfg.SIMBOLO || 'Gs.';
  const esDia = String(r.CheckOut) === String(r.CheckIn);

  const prefijo = { Pendiente: '[PENDIENTE]', Confirmada: '[CONFIRMADA]', Completada: '[COMPLETADA]', Cancelada: '[CANCELADA]' }[r.Estado] || '';
  const title = prefijo + ' ' + (cab.Nombre || r.CabanaID) + ' | ' + r.Cliente + ' (' + r.Huespedes + ' pax)';

  const start = esDia
    ? dateTime_(r.CheckIn, r.HoraLlegada || '09:00')
    : dateTime_(r.CheckIn, r.HoraLlegada || cfg.CHECKIN_HORA || '14:00');
  let end = esDia
    ? dateTime_(r.CheckIn, cfgDeepWorkSalida_(cfg))
    : dateTime_(r.CheckOut, cfg.CHECKOUT_HORA || '10:00');
  if (end <= start) end = new Date(start.getTime() + 4 * 3600 * 1000);

  const desc = [
    'Código: ' + r.Codigo,
    'Estado: ' + r.Estado,
    'Tipo: ' + (tipo.Nombre || r.TipoModo),
    r.TarifaNombre ? 'Tarifa: ' + r.TarifaNombre + (isTrue_(r.Paquete) ? ' (paquete entre semana)' : '') : '',
    'Cliente: ' + r.Cliente,
    'Teléfono: ' + (r.Telefono || '-'),
    'Email: ' + (r.Email || '-'),
    'Huéspedes: ' + r.Huespedes,
    'Llegada: ' + r.CheckIn + ' ' + (r.HoraLlegada || ''),
    'Salida: ' + r.CheckOut,
    'Total: ' + simbolo + ' ' + fmtMoney_(r.Total),
    'Seña: ' + simbolo + ' ' + fmtMoney_(r.Sena),
    r.PromoCodigo ? 'Promo: ' + r.PromoCodigo : '',
    r.GrupoID ? 'Serie programada: ' + r.GrupoID : '',
    r.Notas ? 'Notas: ' + r.Notas : '',
    'Origen: ' + (r.Origen || '-')
  ].filter(String).join('\n');

  let ev = null;
  if (r.EventID) { try { ev = cal.getEventById(r.EventID); } catch (e) { ev = null; } }
  if (ev) {
    ev.setTitle(title);
    ev.setDescription(desc);
    ev.setTime(start, end);
  } else {
    ev = cal.createEvent(title, start, end, { description: desc, location: cab.Ubicacion || cfg.DIRECCION || '' });
  }
  const color = {
    Pendiente: CalendarApp.EventColor.ORANGE,
    Confirmada: CalendarApp.EventColor.GREEN,
    Completada: CalendarApp.EventColor.BLUE,
    Cancelada: CalendarApp.EventColor.GRAY
  }[r.Estado];
  if (color) ev.setColor(color);
  return ev.getId();
}

function syncCalendar_() {
  const ctx = loadCtx_();
  let n = 0;
  ctx.reservas.forEach(r => {
    if (!isISO_(r.CheckIn)) return;
    try {
      const ev = upsertEvent_(r, ctx);
      if (ev && ev !== r.EventID) setField_('Reservas', r._row, 'EventID', ev);
      n++;
    } catch (e) { console.warn(r.Codigo + ': ' + e); }
  });
  return n;
}

/* ================================================================
 *  NOTIFICACIONES POR EMAIL
 * ================================================================ */

function notify_(lista, q, ctx) {
  const cfg = ctx.config;
  const r = lista[0];

  if (isTrue_(cfg.NOTIFICAR_EMAIL)) {
    try {
      const owner = cfg.EMAIL_NOTIF || Session.getEffectiveUser().getEmail();
      if (owner) {
        MailApp.sendEmail({
          to: owner,
          subject: 'Nueva reserva ' + r.Codigo + ' | ' + q.cabanaNombre,
          htmlBody: '<p>Entró una reserva de <b>' + escHtml_(r.Cliente) + '</b> (' + escHtml_(r.Telefono || '-') + ', ' +
            escHtml_(r.Email || '-') + ').</p>' + detalleTabla_(lista, q, cfg)
        });
      }
    } catch (e) { console.warn('Aviso al dueño no enviado: ' + e); }
    try {
      if (r.Email) {
        const mail = buildGuestEmail_(lista, q, cfg);
        MailApp.sendEmail({ to: r.Email, name: cfg.NEGOCIO_NOMBRE || APP.NOMBRE, subject: mail.subject, htmlBody: mail.html });
      }
    } catch (e) { console.warn('Email al huésped no enviado: ' + e); }
  }

  if (isTrue_(cfg.WA_ACTIVO) && r.Telefono) {
    let nota;
    try {
      sendWhatsappTemplate_(waPhone_(r.Telefono, cfg), guestVars_(lista, q, cfg), cfg);
      nota = 'WhatsApp automático enviado.';
    } catch (e) {
      nota = 'WhatsApp automático NO enviado: ' + String(e.message || e).slice(0, 150);
      console.warn(nota);
    }
    if (r._row) {
      r.Notas = [r.Notas, nota].filter(String).join(' ');
      setField_('Reservas', r._row, 'Notas', r.Notas);
    }
  }
}

/* ================================================================
 *  PLANTILLAS DE MENSAJES
 * ================================================================ */

/**
 * Valor de configuración. Si la clave NO existe usa el valor por defecto;
 * si existe y está vacía, respeta el vacío.
 * CORREGIDO: antes un texto vaciado a propósito volvía al valor por defecto,
 * así que borrar CONDICIONES_RESERVA no desactivaba la aceptación.
 */
function cfgText_(cfg, key) {
  if (cfg && Object.prototype.hasOwnProperty.call(cfg, key) && cfg[key] !== null && cfg[key] !== undefined) {
    return String(cfg[key]);
  }
  const d = CONFIG_DEFAULTS.find(x => x.Clave === key);
  return d ? String(d.Valor) : '';
}

function baseVars_(cfg) {
  return {
    negocio: cfg.NEGOCIO_NOMBRE || APP.NOMBRE,
    whatsapp: cfg.WHATSAPP || cfg.TELEFONO || '',
    telefono: cfg.TELEFONO || '',
    direccion: cfg.DIRECCION || '',
    checkin: cfg.CHECKIN_HORA || '14:00',
    checkout: cfg.CHECKOUT_HORA || '10:00',
    sena_pct: String(num_(cfg.SENA_PCT, 0))
  };
}

function condicionesTexto_(cfg) {
  return fillTemplate_(cfgText_(cfg, 'CONDICIONES_RESERVA'), baseVars_(cfg));
}

function fillTemplate_(tpl, vars) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) =>
    Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m);
}

function escHtml_(t) {
  return String(t == null ? '' : t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** Texto plano -> HTML: respeta saltos de línea y *negrita*. */
function textToHtml_(t) {
  return escHtml_(t).replace(/\*([^*\n]+)\*/g, '<b>$1</b>').replace(/\n/g, '<br>');
}

function detalleTabla_(lista, q, cfg) {
  const s = cfg.SIMBOLO || 'Gs.';
  const fechas = lista.map(x => humanDate_(x.CheckIn) + (x.CheckOut !== x.CheckIn ? ' al ' + humanDate_(x.CheckOut) : '')).join('<br>');
  const tarifa = q.tarifaNombre ? q.tarifaNombre + (q.paquete ? ' + paquete entre semana' : '') : '';
  const filas = [
    ['Código', escHtml_(lista.map(x => x.Codigo).join(', '))],
    ['Cabaña', escHtml_(q.cabanaNombre)],
    ['Tipo', escHtml_(q.tipoNombre)],
    ['Fechas', fechas],
    ['Huéspedes', q.huespedes],
    tarifa ? ['Tarifa', escHtml_(tarifa)] : null,
    ['Total', s + ' ' + fmtMoney_(q.total)],
    ['Seña', s + ' ' + fmtMoney_(q.sena)],
    ['Estado', escHtml_(lista[0].Estado)]
  ].filter(Boolean)
    .map(f => '<tr><td style="padding:6px 12px;color:#8E8E93">' + f[0] + '</td><td style="padding:6px 12px;color:#1A1A1A"><b>' + f[1] + '</b></td></tr>').join('');
  return '<table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px;background:#F9F9F9;border-radius:12px">' + filas + '</table>';
}

/** Variables comunes para email y WhatsApp. */
function guestVars_(lista, q, cfg) {
  const s = cfg.SIMBOLO || 'Gs.';
  const r = lista[0];
  const fechas = lista.map(x => humanDate_(x.CheckIn) + (x.CheckOut !== x.CheckIn ? ' al ' + humanDate_(x.CheckOut) : ''));
  const tarifaTxt = q.tarifaNombre ? q.tarifaNombre + (q.paquete ? ' + paquete entre semana' : '') : '';
  const vars = Object.assign(baseVars_(cfg), {
    nombre: r.Cliente,
    codigo: lista.map(x => x.Codigo).join(', '),
    cabana: q.cabanaNombre,
    tipo: q.tipoNombre,
    tarifa: tarifaTxt,
    fechas: fechas.join('\n'),
    huespedes: String(q.huespedes),
    total: s + ' ' + fmtMoney_(q.total),
    sena: s + ' ' + fmtMoney_(q.sena),
    estado: r.Estado,
    datos_bancarios: cfgText_(cfg, 'DATOS_BANCARIOS') || '(consultanos los datos por WhatsApp)',
    condiciones: condicionesTexto_(cfg)
  });
  const dias = diffDays_(today_(), r.CheckIn);
  const ubicacion = q.ubicacion || cfg.DIRECCION || '';
  vars.dias = String(Math.max(dias, 0));
  vars.cuando = dias <= 0 ? 'hoy' : dias === 1 ? 'mañana' : 'en ' + dias + ' días';
  vars.llegada = diaSemana_(r.CheckIn) + ' ' + humanDate_(r.CheckIn);
  vars.hora_llegada = String(r.HoraLlegada || cfg.CHECKIN_HORA || '14:00');
  vars.ubicacion = ubicacion;
  vars.mapa = ubicacion ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(ubicacion) : '';
  vars.detalle = [
    'Cabaña: ' + vars.cabana,
    'Tipo: ' + vars.tipo,
    tarifaTxt ? 'Tarifa: ' + tarifaTxt : '',
    'Fechas: ' + fechas.join(' / '),
    'Huéspedes: ' + vars.huespedes,
    'Total: ' + vars.total,
    'Seña: ' + vars.sena
  ].filter(String).join('\n');
  return vars;
}

/** Arma asunto y cuerpo HTML del email de confirmación. */
function buildGuestEmail_(lista, q, cfg) {
  return buildEmail_(lista, q, cfg, 'ASUNTO_HUESPED', 'MENSAJE_HUESPED');
}

/** Arma un email a partir de las claves de asunto y mensaje indicadas. */
function buildEmail_(lista, q, cfg, claveAsunto, claveMensaje) {
  const MARCA = '@@DETALLE@@';
  const vars = Object.assign(guestVars_(lista, q, cfg), { detalle: MARCA });
  const subject = fillTemplate_(cfgText_(cfg, claveAsunto) || 'Tu reserva {codigo}', vars).replace(/\*/g, '');
  let html = textToHtml_(fillTemplate_(cfgText_(cfg, claveMensaje), vars));
  html = html.replace(/(https:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
  html = html.replace(MARCA, detalleTabla_(lista, q, cfg));
  html = '<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.55;color:#1A1A1A;max-width:560px">' + html + '</div>';
  return { subject: subject, html: html };
}

/** Texto del WhatsApp al huésped (el mismo que arma el botón del panel). */
function buildGuestWhatsapp_(lista, q, cfg) {
  return fillTemplate_(cfgText_(cfg, 'MENSAJE_WHATSAPP'), guestVars_(lista, q, cfg));
}

/* ================================================================
 *  WHATSAPP CLOUD API
 *  Requisitos (Meta): cuenta de WhatsApp Business Platform, número
 *  verificado, token permanente y una plantilla "Utilidad" aprobada.
 *  Los mensajes que inicia el negocio SOLO pueden ser plantillas
 *  aprobadas; por eso el envío automático usa WA_PLANTILLA y WA_PARAMS.
 * ================================================================ */

/** Normaliza un teléfono al formato internacional sin "+" (0981 123 456 -> 595981123456). */
function waPhone_(tel, cfg) {
  let n = String(tel || '').replace(/\D/g, '');
  if (!n) return '';
  const cc = String(cfg.WA_CODIGO_PAIS || '595').replace(/\D/g, '');
  if (n.indexOf('00') === 0) n = n.slice(2);
  else if (n.charAt(0) === '0') n = cc + n.slice(1);
  else if (cc && n.indexOf(cc) !== 0 && n.length <= 9) n = cc + n;
  return n;
}

/** Meta no admite saltos de línea ni tabulaciones dentro de un parámetro. */
function waParam_(v) {
  const t = String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' | ').replace(/ {4,}/g, '   ').trim();
  return (t || '-').slice(0, 1000);
}

function sendWhatsappTemplate_(to, vars, cfg) {
  const token = PropertiesService.getScriptProperties().getProperty(APP.PROP_WA_TOKEN);
  if (!token) throw new Error('Falta el token de WhatsApp (pestaña Mensajes del panel).');
  if (!cfg.WA_PHONE_ID) throw new Error('Falta el Phone number ID de WhatsApp.');
  if (!cfg.WA_PLANTILLA) throw new Error('Falta el nombre de la plantilla de WhatsApp.');
  if (!to) throw new Error('El huésped no tiene teléfono.');

  const claves = String(cfg.WA_PARAMS || '').split(',').map(x => x.trim()).filter(String);
  const template = { name: String(cfg.WA_PLANTILLA).trim(), language: { code: String(cfg.WA_IDIOMA || 'es').trim() } };
  if (claves.length) {
    template.components = [{
      type: 'body',
      parameters: claves.map(k => ({ type: 'text', text: waParam_(vars[k]) }))
    }];
  }
  const res = UrlFetchApp.fetch(
    'https://graph.facebook.com/' + APP.WA_API_VERSION + '/' + encodeURIComponent(String(cfg.WA_PHONE_ID).trim()) + '/messages',
    {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify({ messaging_product: 'whatsapp', to: to, type: 'template', template: template }),
      muteHttpExceptions: true
    }
  );
  let body = {};
  try { body = JSON.parse(res.getContentText() || '{}'); } catch (e) { body = {}; }
  if (res.getResponseCode() >= 300) {
    const err = body.error || {};
    throw new Error('WhatsApp rechazó el envío: ' + (err.message || ('HTTP ' + res.getResponseCode())) +
      (err.error_data && err.error_data.details ? ' (' + err.error_data.details + ')' : ''));
  }
  return body.messages && body.messages[0] ? body.messages[0].id : '';
}

/* ================================================================
 *  MIGRACIONES  (nunca borran datos)
 * ================================================================ */

/** Migraciones seguras para hojas creadas con versiones anteriores. */
function ensureUpgrades_() {
  headersReset_();
  ensureSheetExists_('Tarifas');
  ensureSheetExists_('MovimientosFinancieros');
  HOJAS.forEach(ensureColumns_);
  ensureConfigKeys_();
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('RESERVAS_UPGRADE') === '13') return;
  migrarDeepWorkDay_();
  migrarRolesYSeguridadUsuarios_();
  try {
    const inList = list => SpreadsheetApp.newDataValidation().requireValueInList(list, true).setAllowInvalid(false).build();
    const shU = sheet_('Usuarios');
    shU.getRange(2, col_('Usuarios', 'Rol'), Math.max(shU.getMaxRows() - 1, 1), 1).setDataValidation(inList(Object.keys(ROLES)));
    const shR = sheet_('Reservas');
    shR.getRange(2, col_('Reservas', 'Estado'), Math.max(shR.getMaxRows() - 1, 1), 1).setDataValidation(inList(APP.ESTADOS));
    validarTarifas_(ss_());
  } catch (e) { console.warn('Validaciones: ' + e); }
  props.setProperty('RESERVAS_UPGRADE', '13');
}

/**
 * Convierte ADMIN en DUENO y migra claves antiguas fuera de la hoja.
 * La columna Password se borra solo después de que cada clave disponible
 * haya quedado protegida en las Propiedades del script.
 */
function migrarRolesYSeguridadUsuarios_() {
  // La hoja anterior acepta solo ADMIN, LIMPIEZA y OPERADOR. Antes de
  // transformar ADMIN en DUENO, habilitamos ambos valores temporalmente;
  // al finalizar ensureUpgrades_ deja únicamente los roles nuevos.
  try {
    const sh = sheet_('Usuarios');
    const regla = SpreadsheetApp.newDataValidation()
      .requireValueInList(['ADMIN'].concat(Object.keys(ROLES)), true)
      .setAllowInvalid(false).build();
    sh.getRange(2, col_('Usuarios', 'Rol'), Math.max(sh.getMaxRows() - 1, 1), 1).setDataValidation(regla);
  } catch (e) { console.warn('No se pudo preparar la validación temporal de roles: ' + e); }

  let tabla = readTable_('Usuarios');
  tabla.rows.forEach(r => {
    const rol = normalizarRol_(r.Rol);
    if (ROLES[rol] && String(r.Rol || '').toUpperCase() !== rol) {
      updateObj_('Usuarios', r._row, Object.assign({}, r, { Rol: rol }));
    }
  });

  tabla = readTable_('Usuarios');
  const hayDueno = tabla.rows.some(r => isTrue_(r.Activo) && normalizarRol_(r.Rol) === 'DUENO');
  if (!hayDueno) {
    const candidato = tabla.rows.find(r => isTrue_(r.Activo));
    if (candidato) {
      updateObj_('Usuarios', candidato._row, Object.assign({}, candidato, { Rol: 'DUENO' }));
      tabla = readTable_('Usuarios');
      console.warn('No había dueño activo; se promovió a ' + candidato.Usuario + ' para evitar bloquear la app.');
    }
  }

  const colPassword = tabla.headers.indexOf('Password');
  if (colPassword < 0) return; // instalación nueva o migración ya completada

  tabla.rows.forEach(r => {
    const usuario = String(r.Usuario || '').trim().toLowerCase();
    const legacy = String(r.Password || '');
    if (usuario && legacy && !credential_(usuario)) setPassword_(usuario, legacy);
  });

  const sh = tabla.sh;
  if (sh.getLastRow() > 1) sh.getRange(2, colPassword + 1, sh.getLastRow() - 1, 1).clearContent();
  sh.deleteColumn(colPassword + 1);
  headersReset_('Usuarios');
  console.log('Seguridad de Usuarios actualizada: se eliminaron las contraseñas de la hoja.');
}

/** Crea una hoja del esquema si no existe. No toca las que ya están. */
function ensureSheetExists_(name) {
  const ss = ss_();
  const sh = ss.getSheetByName(name);
  if (sh) return sh;
  return buildSheet_(ss, name);
}

function insertColAt_(sh, pos) {
  const max = sh.getMaxColumns();
  if (pos <= max) sh.insertColumnBefore(pos);
  else sh.insertColumnsAfter(max, pos - max);
}

/**
 * Agrega las columnas del esquema que falten EN SU POSICIÓN, no al final.
 * CORREGIDO: la versión anterior las agregaba al final y desalineaba la hoja
 * respecto de SCHEMA, que es lo que rompía las escrituras.
 * Insertar una columna corre los datos junto con su encabezado: no se pierde nada.
 */
function ensureColumns_(name) {
  const sh = ss_().getSheetByName(name);
  if (!sh) return;
  const campos = SCHEMA[name] || [];
  const head = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0].map(h => String(h).trim());
  let cambios = 0;
  campos.forEach((h, idx) => {
    if (head.indexOf(h) >= 0) return;
    let destino = 0;
    for (let k = 0; k < idx; k++) {
      const p = head.indexOf(campos[k]) + 1;
      if (p > destino) destino = p;
    }
    const pos = destino + 1;
    insertColAt_(sh, pos);
    head.splice(pos - 1, 0, h);
    formatColumn_(sh, h, pos);
    cambios++;
  });
  if (!cambios) return;
  headersReset_(name);
  if (sh.getLastRow() > 1) {
    try { writeFormulas_(sh, name, 2, sh.getLastRow() - 1); } catch (e) { console.warn('Fórmulas ' + name + ': ' + e); }
  }
  console.log(name + ': ' + cambios + ' columna(s) agregada(s). El orden no importa: todo se ubica por encabezado.');
}

/** Agrega a Configuracion las claves nuevas que falten. Nunca borra ni pisa valores. */
function ensureConfigKeys_() {
  const t = readTable_('Configuracion');
  const existentes = t.rows.map(r => r.Clave);
  CONFIG_DEFAULTS.forEach(d => {
    if (existentes.indexOf(d.Clave) < 0) appendObj_('Configuracion', d);
  });
}

/**
 * Renombra de forma segura el antiguo "Día de campo" a Deep Work Day.
 * Mantiene el mismo modo interno (DIA) para no romper reservas, promociones
 * ni reportes existentes; solo cambia lo visible y sus claves de configuración.
 */
function migrarDeepWorkDay_() {
  const tipos = readTable_('TiposReserva');
  const dia = tipos.rows.find(r => String(r.Modo || '').toUpperCase() === 'DIA');
  if (dia) {
    updateObj_('TiposReserva', dia._row, Object.assign({}, dia, {
      Nombre: 'Deep Work Day',
      Descripcion: 'Jornada de trabajo enfocada, sin pernocte. Disponible de lunes a jueves.',
      Icono: 'briefcase'
    }));
  }

  const cfg = readTable_('Configuracion');
  const renombrarClave = (anterior, nueva, valorDefault, descripcion) => {
    const actual = cfg.rows.find(r => r.Clave === nueva);
    const vieja = cfg.rows.find(r => r.Clave === anterior);
    if (actual) {
      updateObj_('Configuracion', actual._row, Object.assign({}, actual, { Descripcion: descripcion }));
      return;
    }
    if (vieja) {
      updateObj_('Configuracion', vieja._row, Object.assign({}, vieja, {
        Clave: nueva,
        Valor: vieja.Valor === '' ? valorDefault : vieja.Valor,
        Descripcion: descripcion
      }));
      return;
    }
    appendObj_('Configuracion', { Clave: nueva, Valor: valorDefault, Descripcion: descripcion });
  };

  renombrarClave('DAYUSE_SALIDA', 'DEEP_WORK_SALIDA', '19:00', 'Hora de salida del Deep Work Day');
  renombrarClave('DAYUSE_PCT', 'DEEP_WORK_PCT', '50', '% de la tarifa diaria que cobra el Deep Work Day');
}

/* ================================================================
 *  SETUP: crea hojas, columnas, relaciones, calendario y datos
 * ================================================================ */

/**
 * Reescribe las fórmulas de Cabanas, Reservas y Resumen sin tocar los datos.
 * Usala si alguna fila muestra error de fórmula.
 */
function repararFormulas() {
  requireEditorOwner_();
  const ss = ss_();
  PropertiesService.getScriptProperties().deleteProperty(APP.PROP_SEP);
  _sepCache = null;
  headersReset_();
  const sep = formulaSep_();
  let filas = 0;
  Object.keys(FORMULA_FIELDS).forEach(name => {
    const sh = ss.getSheetByName(name);
    if (!sh || sh.getLastRow() < 2) return;
    const n = sh.getLastRow() - 1;
    writeFormulas_(sh, name, 2, n);
    filas += n;
  });
  if (ss.getSheetByName('Resumen')) buildResumen_(ss);
  const msg = 'Fórmulas reparadas en ' + filas + ' filas (Cabanas y Reservas) y en la hoja Resumen. ' +
    'Separador usado: "' + sep + '".';
  console.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { /* desde el editor */ }
  return msg;
}

function setupdemodata() { requireEditorOwner_(); return setupCore_(false); }

/** Crea la base la primera vez. Si ya hay datos, no hace nada. */
function setupDemoData() { requireEditorOwner_(); return setupCore_(false); }

/** Reinicia todo con datos de ejemplo. BORRA reservas, cabañas y ajustes. */
function setupDemoDataForzado() { requireEditorOwner_(); return setupCore_(true); }

function setupCore_(forzar) {
  const props = PropertiesService.getScriptProperties();
  const tz = tz_();

  // 1) Hoja de cálculo (vinculada o nueva)
  let ss = null;
  try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { ss = null; }
  if (!ss) {
    const id = props.getProperty(APP.PROP_SS);
    if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; } }
  }
  if (!ss) ss = SpreadsheetApp.create('Reservas de Cabañas | Base de datos');

  // Protección: no pisar una base que ya tiene datos
  const cabSh = ss.getSheetByName('Cabanas');
  if (!forzar && cabSh && cabSh.getLastRow() > 1) {
    const msg = 'La base ya tiene datos, así que no se borró nada.\n' +
      'Para actualizar la app no hace falta setupDemoData: pegá el código nuevo, ejecutá\n' +
      'actualizarEstructura() y después diagnostico(), y creá una Nueva versión de la implementación.\n' +
      'Si de verdad querés BORRAR TODO y empezar de cero, ejecutá setupDemoDataForzado().';
    console.log(msg);
    try { SpreadsheetApp.getUi().alert(msg); } catch (e) { /* desde el editor */ }
    return msg;
  }
  props.setProperty(APP.PROP_SS, ss.getId());
  ss.setSpreadsheetTimeZone(tz);
  headersReset_();

  // 2) Calendario dedicado
  let cal = null;
  const calId = props.getProperty(APP.PROP_CAL);
  if (calId) { try { cal = CalendarApp.getCalendarById(calId); } catch (e) { cal = null; } }
  if (cal) { try { cal.setName('Reservas | ' + APP.NOMBRE); } catch (e) { /* opcional */ } }
  if (!cal) {
    cal = CalendarApp.createCalendar('Reservas | ' + APP.NOMBRE, { timeZone: tz, summary: 'Reservas creadas desde la app web' });
    try { cal.setColor('#FF7A00'); } catch (e) { /* opcional */ }
    props.setProperty(APP.PROP_CAL, cal.getId());
  }

  // 3) Borrar eventos de una demo anterior
  const oldRes = ss.getSheetByName('Reservas');
  if (oldRes && oldRes.getLastRow() > 1) {
    const head = oldRes.getRange(1, 1, 1, oldRes.getLastColumn()).getValues()[0];
    const ix = head.indexOf('EventID');
    if (ix >= 0) {
      oldRes.getRange(2, ix + 1, oldRes.getLastRow() - 1, 1).getValues().forEach(v => {
        if (!v[0]) return;
        try { const ev = cal.getEventById(v[0]); if (ev) ev.deleteEvent(); } catch (e) { /* ya no existe */ }
      });
    }
  }

  // 4) Estructura de hojas
  HOJAS.forEach(name => buildSheet_(ss, name));
  const resumen = ss.getSheetByName('Resumen') || ss.insertSheet('Resumen');
  resumen.clear();
  ss.getSheets().forEach(sh => {
    if (/^(Hoja|Sheet)\s?1$/i.test(sh.getName()) && sh.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(sh);
  });

  // 5) Datos base
  const hoy = today_();
  const img = id => 'https://images.unsplash.com/' + id + '?auto=format&fit=crop&w=1400&q=70';

  writeRows_('Configuracion', [
    { Clave: 'NEGOCIO_NOMBRE', Valor: APP.NOMBRE, Descripcion: 'Nombre que ve el cliente' },
    { Clave: 'ESLOGAN', Valor: 'Cabañas de montaña entre el monte y el arroyo, a una hora de Asunción.', Descripcion: 'Texto bajo el título' },
    { Clave: 'SIMBOLO', Valor: 'Gs.', Descripcion: 'Símbolo de moneda' },
    { Clave: 'DIRECCION', Valor: 'Cordillera, Paraguay', Descripcion: 'Dirección general' },
    { Clave: 'TELEFONO', Valor: '+595 981 000 000', Descripcion: 'Teléfono visible' },
    { Clave: 'WHATSAPP', Valor: '595981000000', Descripcion: 'Número para wa.me (solo dígitos)' },
    { Clave: 'EMAIL_NOTIF', Valor: '', Descripcion: 'Email para avisos (vacío = dueño del script)' },
    { Clave: 'CHECKIN_HORA', Valor: '14:00', Descripcion: 'Hora de check-in' },
    { Clave: 'CHECKOUT_HORA', Valor: '11:00', Descripcion: 'Hora de check-out' },
    { Clave: 'DEEP_WORK_SALIDA', Valor: '19:00', Descripcion: 'Hora de salida del Deep Work Day' },
    { Clave: 'DEEP_WORK_PCT', Valor: '50', Descripcion: '% de la tarifa diaria que cobra el Deep Work Day' },
    { Clave: 'SENA_PCT', Valor: '30', Descripcion: '% de seña para confirmar' },
    { Clave: 'MAX_DESCUENTO', Valor: '40', Descripcion: 'Tope de descuento acumulado (%)' },
    { Clave: 'ESTADO_INICIAL', Valor: 'Pendiente', Descripcion: 'Estado de las reservas web' },
    { Clave: 'NOTIFICAR_EMAIL', Valor: 'SI', Descripcion: 'SI / NO: enviar emails' },
    { Clave: 'HERO_IMG', Valor: img('photo-1449158743715-0a90ebb6d2d8'), Descripcion: 'Imagen principal' },
    { Clave: 'CALENDAR_ID', Valor: cal.getId(), Descripcion: 'Calendario de reservas (automático)' }
  ].concat(CONFIG_DEFAULTS));

  const usuariosIniciales = [
    { Usuario: 'dueno', Nombre: 'Dueño', Rol: 'DUENO', Activo: true, UltimoAcceso: '' },
    { Usuario: 'operador', Nombre: 'Operador', Rol: 'OPERADOR', Activo: true, UltimoAcceso: '' },
    { Usuario: 'limpieza', Nombre: 'Equipo de limpieza', Rol: 'LIMPIEZA', Activo: true, UltimoAcceso: '' }
  ];
  const credencialesIniciales = usuariosIniciales.map(u => ({ usuario: u.Usuario, password: passwordInicial_() }));
  writeRows_('Usuarios', usuariosIniciales);
  credencialesIniciales.forEach(x => setPassword_(x.usuario, x.password));

  writeRows_('Cabanas', [
    {
      ID: 'CAB-01', Nombre: 'Cabaña Alpina Hü', Capacidad: 10, Habitaciones: 2, Banos: 1,
      Descripcion: 'Cabaña exclusiva con aire acondicionado, parrilla, piscina y cocina equipada. Cuenta con wifi, TV, una cama matrimonial, dos camas singles y sofá cama. Ideal para parejas, familias o grupos.',
      PrecioNoche: 450000, PrecioFinSemana: 650000,
      Amenidades: 'Wi-Fi, Aire acondicionado, Parrilla, Piscina, Cocina equipada, TV, Estacionamiento',
      ImagenURL: img('photo-1510798831971-661eb04b3739'), Ubicacion: 'Cordillera, Paraguay',
      Activa: true, Creado: new Date()
    },
    {
      ID: 'CAB-02', Nombre: 'Cabaña Yvága', Capacidad: 2, Habitaciones: 1, Banos: 1,
      Descripcion: 'Pensada para parejas: cama king, bañera exterior y un deck que mira al atardecer. La más apartada del complejo.',
      PrecioNoche: 380000, PrecioFinSemana: 480000,
      Amenidades: 'Wi-Fi, Aire acondicionado, Bañera exterior, Desayuno incluido, Deck privado',
      ImagenURL: img('photo-1542718610-a1d656d1884c'), Ubicacion: 'Cordillera, Paraguay',
      Activa: true, Creado: new Date()
    }
  ]);

  // Tramos de precio por cantidad de personas (los del flyer de Alpina Hü)
  writeRows_('Tarifas', TARIFAS_SUGERIDAS.map((s, i) => ({
    ID: 'TAR-' + String(i + 1).padStart(2, '0'),
    CabanaID: 'CAB-01',
    Nombre: s.Nombre,
    MinPersonas: s.MinPersonas,
    MaxPersonas: s.MaxPersonas,
    TipoPrecio: s.TipoPrecio,
    PrecioSemana: s.PrecioSemana,
    PrecioFinSemana: s.PrecioFinSemana,
    TipoPaquete: s.TipoPaquete,
    PrecioPaquete: s.PrecioPaquete,
    PaqueteMinNoches: s.PaqueteMinNoches,
    Orden: s.MinPersonas,
    Activa: true
  })).concat([{
    ID: 'TAR-05', CabanaID: 'CAB-02', Nombre: 'Parejas', MinPersonas: 1, MaxPersonas: 2, TipoPrecio: 'FIJO',
    PrecioSemana: 380000, PrecioFinSemana: 480000, TipoPaquete: 'FIJO', PrecioPaquete: 300000,
    PaqueteMinNoches: 2, Orden: 1, Activa: true
  }]));

  writeRows_('TiposReserva', [
    { Modo: 'RANGO', Nombre: 'Estadía estándar', Descripcion: 'Elegís llegada y salida, de 1 a 14 noches.', MinNoches: 1, MaxNoches: 14, DescuentoPct: 0, Icono: 'moon', Activo: true },
    { Modo: 'LARGA', Nombre: 'Noches consecutivas', Descripcion: 'Desde 7 noches seguidas con 15% de descuento.', MinNoches: 7, MaxNoches: 30, DescuentoPct: 15, Icono: 'briefcase', Activo: true },
    { Modo: 'FINDE', Nombre: 'Fin de semana', Descripcion: 'Paquete de viernes a domingo.', MinNoches: 2, MaxNoches: 2, DescuentoPct: 0, Icono: 'zap', Activo: true },
    { Modo: 'RECURRENTE', Nombre: 'Estadía programada', Descripcion: 'La misma estadía repetida cada semana, quincena o mes, con 10% de descuento.', MinNoches: 1, MaxNoches: 6, DescuentoPct: 10, Icono: 'repeat', Activo: true },
    { Modo: 'DIA', Nombre: 'Deep Work Day', Descripcion: 'Jornada de trabajo enfocada, sin pernocte. Disponible de lunes a jueves.', MinNoches: 0, MaxNoches: 0, DescuentoPct: 0, Icono: 'briefcase', Activo: true }
  ]);

  writeRows_('Promociones', [
    { Codigo: 'BIENVENIDA10', Descripcion: '10% en tu primera reserva', DescuentoPct: 10, CabanaID: 'TODAS', TipoModo: 'TODOS', FechaInicio: hoy, FechaFin: addDays_(hoy, 180), MinNoches: 1, Activa: true, Usos: 0 },
    { Codigo: 'GRUPOS15', Descripcion: '15% para grupos en estadías largas', DescuentoPct: 15, CabanaID: 'CAB-01', TipoModo: 'LARGA', FechaInicio: hoy, FechaFin: addDays_(hoy, 90), MinNoches: 7, Activa: true, Usos: 0 }
  ]);

  writeRows_('Resenas', [
    { ID: 'RV-01', CabanaID: 'CAB-01', Autor: 'Carolina R.', Rating: 5, Comentario: 'Todo impecable y la parrilla lista para usar. Volvemos seguro.', Fecha: addDays_(hoy, -40), Visible: true },
    { ID: 'RV-02', CabanaID: 'CAB-01', Autor: 'Diego M.', Rating: 5, Comentario: 'Silencio total a la noche. Los chicos no querían salir de la piscina.', Fecha: addDays_(hoy, -22), Visible: true },
    { ID: 'RV-03', CabanaID: 'CAB-02', Autor: 'Paula y Tomás', Rating: 5, Comentario: 'La bañera afuera al atardecer vale el viaje.', Fecha: addDays_(hoy, -15), Visible: true },
    { ID: 'RV-04', CabanaID: 'CAB-01', Autor: 'Familia Rolón', Rating: 5, Comentario: 'Entramos ocho cómodos. La cocina tiene de todo.', Fecha: addDays_(hoy, -9), Visible: true }
  ]);

  // 6) Relaciones (validaciones) y formato condicional
  applyValidations_(ss);

  // 7) Reservas demo (pasan por el mismo motor que la web)
  const next = (from, dow, minAhead) => { let d = addDays_(from, minAhead); while (dow_(d) !== dow) d = addDays_(d, 1); return d; };
  const lunes = next(hoy, 1, 3);
  const viernes = next(hoy, 5, 5);
  const demos = [
    { cabanaId: 'CAB-01', tipo: 'RANGO', checkIn: lunes, checkOut: addDays_(lunes, 2), huespedes: 2, hora: '15:00', cliente: 'María González', telefono: '0981 123 456', email: 'maria.gonzalez@example.com', estado: 'Confirmada', notas: 'Paquete entre semana para pareja' },
    { cabanaId: 'CAB-01', tipo: 'FINDE', checkIn: viernes, huespedes: 6, hora: '18:30', cliente: 'Lucas Benítez', telefono: '0971 555 010', email: 'lucas.benitez@example.com', estado: 'Pendiente' },
    { cabanaId: 'CAB-02', tipo: 'RANGO', checkIn: addDays_(hoy, 12), checkOut: addDays_(hoy, 14), huespedes: 2, hora: '14:00', cliente: 'Familia Ortiz', telefono: '0985 222 333', email: 'ortiz.familia@example.com', estado: 'Confirmada', promo: 'BIENVENIDA10' },
    { cabanaId: 'CAB-01', tipo: 'DIA', checkIn: addDays_(hoy, 8), huespedes: 4, hora: '10:00', cliente: 'Ana Duarte', telefono: '0982 444 999', email: 'ana.duarte@example.com', estado: 'Pendiente' }
  ];
  demos.forEach(d => {
    try { createCore_(d, { origen: 'Demo', estado: d.estado, admin: true, silent: true }); }
    catch (e) { console.warn('Demo no creada: ' + e.message); }
  });

  // 8) Resumen con fórmulas cruzadas
  buildResumen_(ss);
  ss.setActiveSheet(ss.getSheetByName('Reservas'));

  const msg = 'Listo.\n' +
    'Hoja: ' + ss.getUrl() + '\n' +
    'Calendario: ' + cal.getName() + '\n' +
    '\nCredenciales temporales (copialas ahora y cambialas al ingresar):\n' +
    credencialesIniciales.map(x => '- ' + x.usuario + ': ' + x.password).join('\n') + '\n' +
    'Siguiente paso: Implementar > Aplicación web.';
  console.log('Base creada. Las credenciales temporales se mostraron en el aviso de configuración.');
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { /* ejecutado desde el editor */ }
  return msg;
}

function buildSheet_(ss, name) {
  const headers = SCHEMA[name];
  const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.clear();
  sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).clearDataValidations();
  sh.setConditionalFormatRules([]);
  if (sh.getMaxColumns() < headers.length) sh.insertColumnsAfter(sh.getMaxColumns(), headers.length - sh.getMaxColumns());

  sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  sh.setRowHeight(1, 32);
  sh.setFrozenRows(1);
  headersReset_(name);
  headers.forEach((h, i) => formatColumn_(sh, h, i + 1));
  return sh;
}

function applyValidations_(ss) {
  const colRange = (sheet, field) => ss.getSheetByName(sheet).getRange(2, col_(sheet, field), 999, 1);
  const inRange = (sheet, field) => SpreadsheetApp.newDataValidation()
    .requireValueInRange(colRange(sheet, field), true).setAllowInvalid(false).build();
  const inList = list => SpreadsheetApp.newDataValidation().requireValueInList(list, true).setAllowInvalid(false).build();

  colRange('Reservas', 'CabanaID').setDataValidation(inRange('Cabanas', 'ID'));
  colRange('Reservas', 'TipoModo').setDataValidation(inRange('TiposReserva', 'Modo'));
  colRange('Reservas', 'Estado').setDataValidation(inList(APP.ESTADOS));
  colRange('Resenas', 'CabanaID').setDataValidation(inRange('Cabanas', 'ID'));
  colRange('Resenas', 'Rating').setDataValidation(SpreadsheetApp.newDataValidation().requireNumberBetween(1, 5).build());
  colRange('TiposReserva', 'Modo').setDataValidation(inList(APP.MODOS));
  colRange('Usuarios', 'Rol').setDataValidation(inList(Object.keys(ROLES)));
  validarTarifas_(ss);

  const estados = colRange('Reservas', 'Estado');
  const reglas = [
    ['Pendiente', '#FFE8D6', '#B85600'],
    ['Confirmada', '#E3F5EA', '#1E7A45'],
    ['Completada', '#E8EEF9', '#2F5AA8'],
    ['Cancelada', '#F2F2F4', '#8E8E93']
  ].map(x => SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo(x[0]).setBackground(x[1]).setFontColor(x[2]).setRanges([estados]).build());
  ss.getSheetByName('Reservas').setConditionalFormatRules(reglas);
}

function validarTarifas_(ss) {
  const sh = ss.getSheetByName('Tarifas');
  if (!sh || !ss.getSheetByName('Cabanas')) return;
  const cabIds = ss.getSheetByName('Cabanas').getRange(2, col_('Cabanas', 'ID'), 999, 1);
  sh.getRange(2, col_('Tarifas', 'CabanaID'), 999, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInRange(cabIds, true).setAllowInvalid(false).build());
  sh.getRange(2, col_('Tarifas', 'TipoPrecio'), 999, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(APP.TIPOS_PRECIO, true).setAllowInvalid(false).build());
  sh.getRange(2, col_('Tarifas', 'Activa'), 999, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireCheckbox().build());
}

function buildResumen_(ss) {
  const sh = ss.getSheetByName('Resumen');
  sh.clear();
  const C = (sheet, field) => sheet + '!' + L_(sheet, field) + '2:' + L_(sheet, field);
  const est = C('Reservas', 'Estado');
  const cab = C('Reservas', 'CabanaID');
  const idL = L_('Cabanas', 'ID');
  const cabAncho = letter_(headers_('Cabanas').length);
  const nomL = L_('Cabanas', 'Nombre');
  const ixRating = col_('Cabanas', 'Rating') - col_('Cabanas', 'ID') + 1;
  const ixActiva = col_('Cabanas', 'Activa') - col_('Cabanas', 'ID') + 1;

  sh.getRange('A1').setValue('Resumen general').setFontSize(16).setFontWeight('bold').setFontColor('#FF7A00');
  sh.getRange('A3:A6').setValues([['Ingresos (sin canceladas)'], ['Reservas activas'], ['Pendientes de seña'], ['Noches vendidas']]);
  sh.getRange('B3:B6').setFormulas([
    [fx_('=SUMIFS(' + C('Reservas', 'Total') + ',' + est + ',"<>Cancelada")')],
    [fx_('=COUNTIFS(' + C('Reservas', 'Codigo') + ',"<>",' + est + ',"<>Cancelada")')],
    [fx_('=COUNTIF(' + est + ',"Pendiente")')],
    [fx_('=SUMIFS(' + C('Reservas', 'Noches') + ',' + est + ',"<>Cancelada")')]
  ]);
  sh.getRange('B3').setNumberFormat('#,##0');
  sh.getRange('A3:A6').setFontColor('#8E8E93');
  sh.getRange('B3:B6').setFontWeight('bold');

  sh.getRange('A8:G8').setValues([['ID', 'Cabaña', 'Reservas', 'Noches', 'Ingresos', 'Rating', 'Estado']]);
  sh.getRange('A9').setFormula(fx_('=FILTER(Cabanas!' + idL + '2:' + nomL + ',Cabanas!' + idL + '2:' + idL + '<>"")'));
  sh.getRange('C9').setFormula(fx_('=ARRAYFORMULA(IF(A9:A="","",COUNTIFS(' + cab + ',A9:A,' + est + ',"<>Cancelada")))'));
  sh.getRange('D9').setFormula(fx_('=ARRAYFORMULA(IF(A9:A="","",SUMIFS(' + C('Reservas', 'Noches') + ',' + cab + ',A9:A,' + est + ',"<>Cancelada")))'));
  sh.getRange('E9').setFormula(fx_('=ARRAYFORMULA(IF(A9:A="","",SUMIFS(' + C('Reservas', 'Total') + ',' + cab + ',A9:A,' + est + ',"<>Cancelada")))'));
  sh.getRange('F9').setFormula(fx_('=ARRAYFORMULA(IF(A9:A="","",IFERROR(VLOOKUP(A9:A,Cabanas!' + idL + ':' + cabAncho + ',' + ixRating + ',FALSE),0)))'));
  sh.getRange('G9').setFormula(fx_('=ARRAYFORMULA(IF(A9:A="","",IF(VLOOKUP(A9:A,Cabanas!' + idL + ':' + cabAncho + ',' + ixActiva + ',FALSE),"Activa","Inactiva")))'));
  sh.getRange('E9:E60').setNumberFormat('#,##0');

  sh.getRange('I8:J8').setValues([['Estado', 'Cantidad']]);
  APP.ESTADOS.forEach((e, i) => {
    sh.getRange(9 + i, 9).setValue(e);
    sh.getRange(9 + i, 10).setFormula(fx_('=COUNTIF(' + est + ',I' + (9 + i) + ')'));
  });

  [sh.getRange('A8:G8'), sh.getRange('I8:J8')].forEach(r =>
    r.setFontWeight('bold').setFontColor('#FFFFFF').setBackground('#FF7A00'));
  sh.setColumnWidth(1, 200);
  sh.setColumnWidth(2, 180);
  sh.setFrozenRows(1);
}

/* ================================================================
 *  CAPA DE DATOS
 *  ACÁ ESTABA EL ERROR. Antes las escrituras ubicaban la columna por la
 *  posición del campo en SCHEMA y las lecturas por el encabezado real.
 *  Ahora TODO se ubica por encabezado, así que el orden físico de la hoja
 *  dejó de importar.
 * ================================================================ */

var _HEAD_CACHE = {};

function headersReset_(name) {
  if (name) delete _HEAD_CACHE[name];
  else _HEAD_CACHE = {};
}

/** Encabezados reales de la hoja. Única fuente de verdad para ubicar columnas. */
function headers_(name) {
  if (_HEAD_CACHE[name]) return _HEAD_CACHE[name];
  const sh = sheet_(name);
  const ancho = Math.max(sh.getLastColumn(), 1);
  const head = sh.getRange(1, 1, 1, ancho).getValues()[0].map(h => String(h).trim());
  return (_HEAD_CACHE[name] = head);
}

/** Número de columna (1..n) de un campo, leído del encabezado. */
function col_(name, field) {
  let i = headers_(name).indexOf(field);
  if (i < 0 && SCHEMA[name] && SCHEMA[name].indexOf(field) >= 0) {
    ensureColumns_(name);                 // hoja de una versión vieja: se crea la columna
    i = headers_(name).indexOf(field);
  }
  if (i < 0) throw new Error('Falta la columna "' + field + '" en la hoja ' + name + '. Ejecutá actualizarEstructura().');
  return i + 1;
}

function ss_() {
  const id = PropertiesService.getScriptProperties().getProperty(APP.PROP_SS);
  if (id) return SpreadsheetApp.openById(id);
  let active = null;
  try { active = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { active = null; }
  if (active) return active;
  throw new Error('La base de datos todavía no existe. Ejecutá setupDemoData() desde el editor.');
}

function sheet_(name) {
  const sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('Falta la hoja "' + name + '". Ejecutá actualizarEstructura() desde el editor.');
  return sh;
}

function readTable_(name) {
  const sh = sheet_(name);
  const values = sh.getDataRange().getValues();
  const headers = (values.shift() || []).map(h => String(h).trim());
  _HEAD_CACHE[name] = headers;
  const tz = tz_();
  const idField = (SCHEMA[name] || [])[0];
  const idCol = idField ? headers.indexOf(idField) : 0;
  const clave = idCol >= 0 ? idCol : 0;
  const rows = [];
  values.forEach((r, i) => {
    if (r[clave] === '' || r[clave] === null) return;
    const o = { _row: i + 2 };
    headers.forEach((h, j) => { if (h) o[h] = normalize_(r[j], tz); });
    rows.push(o);
  });
  return { sh: sh, headers: headers, rows: rows };
}

/** Igual que readTable_, pero si la hoja todavía no existe devuelve una tabla vacía. */
function readTableSafe_(name) {
  try {
    if (!ss_().getSheetByName(name)) return { sh: null, headers: SCHEMA[name] || [], rows: [] };
  } catch (e) {
    return { sh: null, headers: SCHEMA[name] || [], rows: [] };
  }
  return readTable_(name);
}

function normalize_(v, tz) {
  if (v instanceof Date) {
    if (v.getFullYear() < 1900) return Utilities.formatDate(v, tz, 'HH:mm');
    const hm = Utilities.formatDate(v, tz, 'HH:mm');
    return hm === '00:00'
      ? Utilities.formatDate(v, tz, 'yyyy-MM-dd')
      : Utilities.formatDate(v, tz, 'yyyy-MM-dd HH:mm');
  }
  return v;
}

/* ---------------- Fórmulas de la hoja ---------------- */

const FORMULA_FIELDS = {
  Cabanas: ['Rating', 'NumResenas'],
  Reservas: ['CabanaNombre', 'TipoNombre']
};

/** Rango "Hoja!X:Y" y el índice de Y dentro de ese rango, ubicados por encabezado. */
function lookupRange_(sheetName, desde, hasta) {
  const a = col_(sheetName, desde);
  const b = col_(sheetName, hasta);
  return { rango: sheetName + '!' + letter_(a) + ':' + letter_(b), indice: b - a + 1 };
}

function formulaFor_(name, field, r) {
  const colOf = (sheet, f) => sheet + '!' + L_(sheet, f) + ':' + L_(sheet, f);
  if (name === 'Cabanas') {
    const id = L_('Cabanas', 'ID') + r;
    const rc = colOf('Resenas', 'CabanaID');
    const rv = colOf('Resenas', 'Visible');
    if (field === 'Rating') return '=IFERROR(ROUND(AVERAGEIFS(' + colOf('Resenas', 'Rating') + ',' + rc + ',' + id + ',' + rv + ',TRUE),1),0)';
    if (field === 'NumResenas') return '=COUNTIFS(' + rc + ',' + id + ',' + rv + ',TRUE)';
  }
  if (name === 'Reservas') {
    if (field === 'CabanaNombre') {
      const lk = lookupRange_('Cabanas', 'ID', 'Nombre');
      return '=IFERROR(VLOOKUP(' + L_('Reservas', 'CabanaID') + r + ',' + lk.rango + ',' + lk.indice + ',FALSE),"")';
    }
    if (field === 'TipoNombre') {
      const lk = lookupRange_('TiposReserva', 'Modo', 'Nombre');
      return '=IFERROR(VLOOKUP(' + L_('Reservas', 'TipoModo') + r + ',' + lk.rango + ',' + lk.indice + ',FALSE),"")';
    }
  }
  return null;
}

let _sepCache = null;

/** Separador que acepta esta hoja: ';' o ','. Se detecta una vez y se recuerda. */
function formulaSep_() {
  if (APP.SEPARADOR_FORMULAS === ';' || APP.SEPARADOR_FORMULAS === ',') return APP.SEPARADOR_FORMULAS;
  if (_sepCache) return _sepCache;
  const props = PropertiesService.getScriptProperties();
  const guardado = props.getProperty(APP.PROP_SEP);
  if (guardado === ';' || guardado === ',') return (_sepCache = guardado);
  const sep = detectSep_(ss_());
  props.setProperty(APP.PROP_SEP, sep);
  return (_sepCache = sep);
}

/** Escribe una fórmula de prueba en una hoja temporal: primero con ';', luego con ','. */
function detectSep_(ss) {
  const nombre = '_prueba_separador';
  const vieja = ss.getSheetByName(nombre);
  if (vieja) ss.deleteSheet(vieja);
  const sh = ss.insertSheet(nombre);
  try {
    const cell = sh.getRange('A1');
    const candidatos = [';', ','];
    for (let i = 0; i < candidatos.length; i++) {
      const sep = candidatos[i];
      cell.setFormula('=IF(1=1' + sep + '"OK"' + sep + '"NO")');
      SpreadsheetApp.flush();
      if (cell.getDisplayValue() === 'OK') return sep;
      cell.clearContent();
    }
    return ';';
  } finally {
    ss.deleteSheet(sh);
  }
}

/** Cambia las comas separadoras (fuera de comillas) por el separador de la hoja. */
function fx_(f) {
  if (formulaSep_() !== ';') return f;
  let out = '';
  let enTexto = false;
  for (const ch of String(f)) {
    if (ch === '"') enTexto = !enTexto;
    out += (!enTexto && ch === ',') ? ';' : ch;
  }
  return out;
}

function writeFormulas_(sh, name, startRow, count) {
  (FORMULA_FIELDS[name] || []).forEach(field => {
    const formulas = [];
    for (let i = 0; i < count; i++) formulas.push([fx_(formulaFor_(name, field, startRow + i))]);
    sh.getRange(startRow, col_(name, field), count, 1).setFormulas(formulas);
  });
}

/* ---------------- Escrituras (siempre por encabezado) ---------------- */

/**
 * Arma la fila completa según los encabezados REALES.
 * - Los campos con fórmula quedan vacíos (los escribe writeFormulas_).
 * - Las columnas que no son del esquema, o que el objeto no trae, se dejan
 *   como estaban (si se está actualizando una fila existente).
 */
function rowValues_(name, obj, existing) {
  const head = headers_(name);
  const campos = SCHEMA[name] || [];
  const fFields = FORMULA_FIELDS[name] || [];
  return head.map((h, i) => {
    if (fFields.indexOf(h) >= 0) return '';
    const gestionada = h && campos.indexOf(h) >= 0 && Object.prototype.hasOwnProperty.call(obj, h);
    if (!gestionada) return existing ? existing[i] : '';
    let v = obj[h];
    if (v === undefined || v === null) return '';
    if (DATE_FIELDS.indexOf(h) >= 0 && v !== '' && !(v instanceof Date)) v = parseDate_(v);
    return v;
  });
}

function writeRows_(name, list) {
  if (!list.length) return;
  const sh = sheet_(name);
  const w = headers_(name).length;
  const data = list.map(o => rowValues_(name, o, null));
  sh.getRange(2, 1, data.length, w).setValues(data);
  writeFormulas_(sh, name, 2, data.length);
  applyCheckboxes_(sh, name, 2, data.length);
}

function appendObj_(name, obj) {
  const sh = sheet_(name);
  const w = headers_(name).length;
  const r = sh.getLastRow() + 1;
  if (r > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 200);
  sh.getRange(r, 1, 1, w).setValues([rowValues_(name, obj, null)]);
  writeFormulas_(sh, name, r, 1);
  applyCheckboxes_(sh, name, r, 1);
  SpreadsheetApp.flush();
  return r;
}

function updateObj_(name, r, obj) {
  const sh = sheet_(name);
  const w = headers_(name).length;
  const existing = sh.getRange(r, 1, 1, w).getValues()[0];
  sh.getRange(r, 1, 1, w).setValues([rowValues_(name, obj, existing)]);
  writeFormulas_(sh, name, r, 1);
  applyCheckboxes_(sh, name, r, 1);
  SpreadsheetApp.flush();
}

function setField_(name, r, field, value) {
  if (DATE_FIELDS.indexOf(field) >= 0 && value && !(value instanceof Date)) value = parseDate_(value);
  sheet_(name).getRange(r, col_(name, field)).setValue(value);
  SpreadsheetApp.flush();
}

function applyCheckboxes_(sh, name, startRow, count) {
  const rule = SpreadsheetApp.newDataValidation().requireCheckbox().build();
  headers_(name).forEach((h, i) => {
    if (BOOL_FIELDS.indexOf(h) >= 0) sh.getRange(startRow, i + 1, count, 1).setDataValidation(rule);
  });
}

/** Formato, ancho y encabezado de una columna. */
function formatColumn_(sh, h, c) {
  const rows = Math.max(sh.getMaxRows() - 1, 1);
  const r = sh.getRange(2, c, rows, 1);
  if (TEXT_FIELDS.indexOf(h) >= 0) r.setNumberFormat('@');
  else if (DATE_FIELDS.indexOf(h) >= 0) r.setNumberFormat('dd/mm/yyyy');
  else if (MONEY_FIELDS.indexOf(h) >= 0) r.setNumberFormat('#,##0');
  else if (h === 'Creado' || h === 'UltimoAcceso') r.setNumberFormat('dd/mm/yyyy hh:mm');
  else if (h === 'Rating') r.setNumberFormat('0.0');
  if (BOOL_FIELDS.indexOf(h) >= 0) r.setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());
  sh.setColumnWidth(c, COL_WIDTHS[h] || 120);
  sh.getRange(1, c).setValue(h)
    .setFontWeight('bold').setFontColor('#FFFFFF').setBackground('#FF7A00').setVerticalAlignment('middle');
}

function getConfig_() {
  const c = {};
  readTable_('Configuracion').rows.forEach(r => { c[r.Clave] = r.Valor; });
  return c;
}

/** Compatibilidad con bases creadas antes de renombrar Día de campo. */
function cfgDeepWorkSalida_(c) {
  return String((c && (c.DEEP_WORK_SALIDA || c.DAYUSE_SALIDA)) || '19:00');
}

/**
 * Porcentaje que se aplica al precio diario de la tarifa seleccionada.
 * Usa la clave anterior solo como respaldo hasta que se ejecute actualizarEstructura().
 */
function cfgDeepWorkPct_(c) {
  const valor = c && c.DEEP_WORK_PCT !== undefined && c.DEEP_WORK_PCT !== ''
    ? c.DEEP_WORK_PCT
    : (c && c.DAYUSE_PCT);
  return clamp_(num_(valor, 50), 0, 100);
}

function setConfig_(key, value) {
  const t = readTable_('Configuracion');
  const row = t.rows.find(r => r.Clave === key);
  if (row) setField_('Configuracion', row._row, 'Valor', String(value));
  else appendObj_('Configuracion', { Clave: key, Valor: String(value), Descripcion: '' });
}

/* ================================================================
 *  SALIDAS (objetos planos para el cliente; sin Date)
 * ================================================================ */

function cabinOut_(c, tarifas) {
  const pn = num_(c.PrecioNoche, 0);
  const lista = tarifasDe_(tarifas || [], c.ID);
  return {
    ID: c.ID, Nombre: c.Nombre, Descripcion: c.Descripcion,
    Capacidad: num_(c.Capacidad, 1), Habitaciones: num_(c.Habitaciones, 1), Banos: num_(c.Banos, 1),
    PrecioNoche: pn, PrecioFinSemana: num_(c.PrecioFinSemana, pn),
    PrecioDesde: precioDesde_(c, tarifas || []),
    Tarifas: lista.map(tarifaOut_),
    Amenidades: String(c.Amenidades || '').split(',').map(s => s.trim()).filter(String),
    ImagenURL: c.ImagenURL || '', Ubicacion: c.Ubicacion || '',
    Rating: num_(c.Rating, 0), NumResenas: num_(c.NumResenas, 0),
    Activa: isTrue_(c.Activa)
  };
}

function tarifaOut_(t) {
  const min = num_(t.MinPersonas, 1);
  return {
    ID: String(t.ID), CabanaID: String(t.CabanaID),
    Nombre: String(t.Nombre || ''),
    MinPersonas: min,
    MaxPersonas: num_(t.MaxPersonas, 0) || min,
    TipoPrecio: String(t.TipoPrecio || 'FIJO').toUpperCase(),
    PrecioSemana: num_(t.PrecioSemana, 0),
    PrecioFinSemana: num_(t.PrecioFinSemana, num_(t.PrecioSemana, 0)),
    TipoPaquete: String(t.TipoPaquete || '').toUpperCase(),
    PrecioPaquete: num_(t.PrecioPaquete, 0),
    PaqueteMinNoches: num_(t.PaqueteMinNoches, 2) || 2,
    Orden: num_(t.Orden, min),
    Activa: isTrue_(t.Activa)
  };
}

function typeOut_(t) {
  return {
    Modo: String(t.Modo).toUpperCase(), Nombre: t.Nombre, Descripcion: t.Descripcion,
    MinNoches: num_(t.MinNoches, 0), MaxNoches: num_(t.MaxNoches, 0),
    DescuentoPct: num_(t.DescuentoPct, 0), Icono: t.Icono || 'moon', Activo: isTrue_(t.Activo)
  };
}

function promoOut_(p) {
  return {
    Codigo: String(p.Codigo), Descripcion: p.Descripcion, DescuentoPct: num_(p.DescuentoPct, 0),
    CabanaID: p.CabanaID || 'TODAS', TipoModo: String(p.TipoModo || 'TODOS').toUpperCase(),
    FechaInicio: p.FechaInicio || '', FechaFin: p.FechaFin || '',
    MinNoches: num_(p.MinNoches, 0), Activa: isTrue_(p.Activa), Usos: num_(p.Usos, 0)
  };
}

function reservaOut_(r, ctx) {
  const cab = ctx.cabanas.find(c => c.ID === r.CabanaID) || {};
  const tipo = findTipo_(ctx, r.TipoModo) || {};
  return {
    ID: String(r.ID), Codigo: String(r.Codigo).trim(), GrupoID: r.GrupoID || '',
    CabanaID: String(r.CabanaID || '').trim(), CabanaNombre: r.CabanaNombre || cab.Nombre || r.CabanaID,
    TipoModo: r.TipoModo, TipoNombre: String(r.Origen || '').indexOf('Externa · ') === 0 ? 'Reserva externa' : (r.TipoNombre || tipo.Nombre || r.TipoModo),
    TarifaID: String(r.TarifaID || ''), TarifaNombre: String(r.TarifaNombre || ''), Paquete: isTrue_(r.Paquete),
    Cliente: r.Cliente, Email: r.Email, Telefono: String(r.Telefono || ''),
    Huespedes: num_(r.Huespedes, 0), CheckIn: r.CheckIn, CheckOut: r.CheckOut, HoraLlegada: String(r.HoraLlegada || ''),
    Noches: num_(r.Noches, 0), Subtotal: num_(r.Subtotal, 0), Descuento: num_(r.Descuento, 0),
    Total: num_(r.Total, 0), Sena: num_(r.Sena, 0), PromoCodigo: r.PromoCodigo || '',
    Estado: String(r.Estado || '').trim(), Notas: r.Notas || '', Origen: r.Origen || '', Creado: String(r.Creado || ''),
    TieneEvento: !!r.EventID
  };
}

/* ================================================================
 *  UTILIDADES
 * ================================================================ */

function findTipo_(ctx, modo) {
  const m = String(modo || '').toUpperCase();
  return ctx.tipos.find(t => String(t.Modo).toUpperCase() === m) || null;
}

/**
 * Convierte enlaces de Google Drive en enlaces de imagen directos.
 * El archivo debe estar compartido como "Cualquier persona con el enlace".
 */
function normalizeImageUrl_(url) {
  const u = String(url || '').trim();
  const m = u.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:export=\w+&)?id=)([\w-]{20,})/);
  return m ? 'https://drive.google.com/thumbnail?id=' + m[1] + '&sz=w1600' : u;
}

function tz_() { return Session.getScriptTimeZone() || 'America/Asuncion'; }
function today_() { return Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd'); }
function isISO_(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }

function parseDate_(s) {
  if (s instanceof Date) return s;
  const p = String(s).slice(0, 10).split('-').map(Number);
  return new Date(p[0], p[1] - 1, p[2]);
}

function dateTime_(iso, hhmm) {
  const p = String(iso).split('-').map(Number);
  const t = String(hhmm || '00:00').split(':').map(Number);
  return new Date(p[0], p[1] - 1, p[2], t[0] || 0, t[1] || 0);
}

function utc_(s) { return new Date(String(s).slice(0, 10) + 'T00:00:00Z'); }
function addDays_(s, n) { const d = utc_(s); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function diffDays_(a, b) { return Math.round((utc_(b) - utc_(a)) / 86400000); }
function dow_(s) { return utc_(s).getUTCDay(); }

function addMonths_(s, n) {
  const d = utc_(s);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}

function daysInMonth_(ym) {
  const p = ym.split('-').map(Number);
  return new Date(Date.UTC(p[0], p[1], 0)).getUTCDate();
}

function diaSemana_(iso) {
  return ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'][dow_(iso)];
}

function humanDate_(iso) {
  const m = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const p = String(iso).split('-').map(Number);
  return p[2] + ' ' + m[p[1] - 1] + ' ' + p[0];
}

function isTrue_(v) {
  return v === true || /^(true|verdadero|si|sí|1|yes)$/i.test(String(v).trim());
}

function num_(v, d) {
  if (v === '' || v === null || v === undefined) return d;
  const n = Number(v);
  return isNaN(n) ? d : n;
}

function int_(v) { return Math.round(num_(v, 0)); }
function clamp_(n, a, b) { return Math.min(Math.max(n, a), b); }

function clean_(v, max) {
  return String(v === undefined || v === null ? '' : v)
    .replace(/[<>]/g, '')
    .replace(/^[=@]+/, '')             // evita inyección de fórmulas en la hoja
    .replace(/^[+\-](?=[^\d\s])/, '')  // permite "+595..." pero no "+SUM(...)"
    .trim()
    .slice(0, max || 200);
}

function fmtMoney_(n) {
  return String(Math.round(num_(n, 0))).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function shortId_() { return Utilities.getUuid().replace(/-/g, '').slice(0, 8).toUpperCase(); }

/**
 * Código de reserva. CORREGIDO: ahora verifica que no esté usado, porque es la
 * llave con la que el huésped consulta su reserva.
 */
function makeCode_(usados) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let intento = 0; intento < 40; intento++) {
    let s = '';
    for (let i = 0; i < 6; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
    const code = APP.PREFIJO_CODIGO + s;
    if (!usados || !usados[code]) {
      if (usados) usados[code] = true;
      return code;
    }
  }
  return APP.PREFIJO_CODIGO + shortId_().slice(0, 6);
}

function nextId_(rows, field, prefix) {
  let max = 0;
  rows.forEach(r => {
    const m = String(r[field] || '').match(/(\d+)$/);
    if (m) max = Math.max(max, Number(m[1]));
  });
  return prefix + String(max + 1).padStart(2, '0');
}

function letter_(n) {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function L_(name, field) { return letter_(col_(name, field)); }
