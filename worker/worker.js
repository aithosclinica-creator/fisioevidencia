// FisioEvidencia: servicio de resumen de literatura (Cloudflare Worker).
// Guarda la clave de la IA fuera de la web pública.
//
// Variables que hay que crear en Cloudflare (Settings > Variables and Secrets):
//   GEMINI_API_KEY     (Secret)  la clave gratuita de aistudio.google.com  <- opción por defecto
//   ACCESS_CODE        (Secret)  un código que solo conozcas tú; la app lo pide una vez
// Opcionales:
//   GEMINI_MODEL       (Text)    modelo de Gemini preferido; si falla se prueban otros gratuitos
//   ANTHROPIC_API_KEY  (Secret)  si no hay clave de Gemini, se usa Claude (de pago)
//
// Se usa fetch directo porque el editor web de Cloudflare no permite instalar SDKs.

const ALLOWED_ORIGINS = [
  "https://raw.githack.com",
  "https://rawcdn.githack.com",
  "https://aithosclinica-creator.github.io",
];
const MAX_ARTICLES = 30;
const MAX_ABSTRACT = 3000;

const SYSTEM = `Eres un asistente que resume literatura científica para fisioterapeutas colegiados en España.

Reglas estrictas:
- Usa SOLO la información de los resúmenes de artículos que se te dan. No añadas conocimiento propio, ni datos, ni estudios que no estén en la lista.
- Cada hallazgo debe citar el número o números de los artículos que lo respaldan. Si algo no está respaldado por un artículo de la lista, no lo escribas.
- Describe lo que hicieron y encontraron los estudios ("los estudios aplicaron...", "se observó..."). No des recomendaciones, no uses imperativos y no te dirijas a un paciente concreto. Es un resumen de la literatura, no un consejo clínico.
- Da prioridad a guías de práctica clínica, después a revisiones sistemáticas y después a ensayos.
- Señala con claridad cuando la evidencia es contradictoria, escasa, de muestras pequeñas o de baja calidad según los propios autores.
- Si los artículos no responden a la pregunta, dilo y deja los hallazgos vacíos.
- Ranking de técnicas: ordena como máximo 3 técnicas según el respaldo que les da la evidencia recuperada para esta patología (no para un paciente concreto). Criterios, en este orden: nivel del estudio (guía > revisión sistemática > ensayo), comparación directa entre técnicas, consistencia de los resultados y tamaño del efecto si se menciona. En "motivo" explica en una frase por qué está en ese puesto, con citas. Marca "comparacion": "directa" solo si algún artículo compara esas técnicas entre sí; si no, "indirecta".
- Si la evidencia recuperada no permite ordenar con un mínimo de rigor (pocos estudios, resultados contradictorios o sin comparaciones), pon ranking_posible = false, deja el ranking vacío y explica el porqué en ranking_nota. Es preferible no ordenar a ordenar mal.
- La certeza es una estimación aproximada a partir de resúmenes, no una evaluación GRADE formal.
- Responde SOLO con un objeto JSON con los campos: resumen (texto), certeza ("alta"|"moderada"|"baja"|"muy baja"|"insuficiente"), hallazgos (lista de {texto, nivel: "guia"|"revision"|"eca"|"mixto", solidez: "consistente"|"contradictoria"|"limitada", refs: [números de artículo]}), tecnicas (lista de {tecnica, texto, refs}), ranking_posible (true|false), ranking_nota (texto), ranking (lista de hasta 3 {puesto, tecnica, motivo, comparacion: "directa"|"indirecta", refs}), lagunas (texto).
- Escribe en español, frases cortas y claras. Conserva en inglés solo los nombres de escalas o técnicas que no tengan traducción habitual.`;

const SCHEMA = {
  type: "object",
  properties: {
    resumen: { type: "string", description: "2 a 4 frases con la visión general de lo que dice la evidencia recuperada" },
    certeza: { type: "string", enum: ["alta", "moderada", "baja", "muy baja", "insuficiente"] },
    hallazgos: {
      type: "array",
      items: {
        type: "object",
        properties: {
          texto: { type: "string" },
          nivel: { type: "string", enum: ["guia", "revision", "eca", "mixto"] },
          solidez: { type: "string", enum: ["consistente", "contradictoria", "limitada"] },
          refs: { type: "array", items: { type: "integer" } },
        },
        required: ["texto", "nivel", "solidez", "refs"],
        additionalProperties: false,
      },
    },
    tecnicas: {
      type: "array",
      description: "Qué dice la evidencia sobre cada técnica concreta mencionada en los artículos (ejercicio, EPI, punción seca, terapia manual...)",
      items: {
        type: "object",
        properties: {
          tecnica: { type: "string" },
          texto: { type: "string" },
          refs: { type: "array", items: { type: "integer" } },
        },
        required: ["tecnica", "texto", "refs"],
        additionalProperties: false,
      },
    },
    ranking_posible: { type: "boolean" },
    ranking_nota: { type: "string", description: "Cómo se ha ordenado, o por qué no se puede ordenar" },
    ranking: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        properties: {
          puesto: { type: "integer", minimum: 1, maximum: 3 },
          tecnica: { type: "string" },
          motivo: { type: "string" },
          comparacion: { type: "string", enum: ["directa", "indirecta"] },
          refs: { type: "array", items: { type: "integer" } },
        },
        required: ["puesto", "tecnica", "motivo", "comparacion", "refs"],
        additionalProperties: false,
      },
    },
    lagunas: { type: "string", description: "Qué no se sabe o qué falta en esta evidencia" },
  },
  required: ["resumen", "certeza", "hallazgos", "tecnicas", "ranking_posible", "ranking_nota", "ranking", "lagunas"],
  additionalProperties: false,
};

const SUMMARY_TASK = {
  system: SYSTEM,
  schema: SCHEMA,
  normalize(out) {
    out.hallazgos = Array.isArray(out.hallazgos) ? out.hallazgos : [];
    out.tecnicas = Array.isArray(out.tecnicas) ? out.tecnicas : [];
    out.ranking = Array.isArray(out.ranking) ? out.ranking.slice(0, 3) : [];
    return out;
  },
};

// ---- Historia clínica a partir de la conversación (PROTOTIPO: solo pacientes ficticios) ----
const HISTORY_FIELDS = [
  ["motivo_consulta", "Motivo de consulta"],
  ["inicio_evolucion", "Inicio y evolución (cuándo, cómo empezó, mecanismo, curso)"],
  ["localizacion_irradiacion", "Localización e irradiación del dolor o síntoma"],
  ["caracteristicas_dolor", "Tipo de dolor, intensidad (EVA/NPRS si se dice) y comportamiento en 24 h"],
  ["agravantes_aliviantes", "Qué lo empeora y qué lo alivia"],
  ["funcion_limitaciones", "Limitaciones funcionales y actividades afectadas"],
  ["actividad_trabajo", "Actividad física, deporte y trabajo"],
  ["antecedentes", "Antecedentes médicos, lesiones y cirugías previas"],
  ["medicacion", "Medicación actual"],
  ["pruebas_previas", "Pruebas de imagen u otras pruebas y tratamientos previos"],
  ["factores_psicosociales", "Creencias, miedo al movimiento, estrés, sueño, expectativas"],
  ["objetivos_paciente", "Objetivos y expectativas del paciente"],
];
const HISTORY_SYSTEM = `Eres un asistente de documentación para fisioterapeutas. Recibes la transcripción de una entrevista clínica (fisioterapeuta y paciente, sin etiquetas de quién habla) y redactas la anamnesis estructurada.

Reglas estrictas:
- Usa SOLO lo que se dice en la transcripción. No inventes, no supongas y no completes con datos típicos. Si un apartado no se menciona, déjalo vacío.
- Para cada apartado con contenido, copia en "cita" la frase literal de la transcripción de la que sale (la más representativa).
- No hagas diagnósticos, no propongas pruebas ni tratamientos. Solo documentas lo que se ha dicho.
- "senales_mencionadas": lista los síntomas que se han dicho en la conversación y que suelen revisarse como posibles banderas rojas (dolor nocturno que no cambia con la postura, pérdida de peso sin explicación, fiebre, alteraciones de esfínteres, anestesia en silla de montar, déficit neurológico progresivo, antecedentes de cáncer, traumatismo importante...). Solo si se han dicho; nunca interpretes ni concluyas.
- "no_preguntado": lista breve de apartados de una anamnesis musculoesquelética estándar que no aparecen en la transcripción, para que el fisioterapeuta decida si preguntarlos.
- Escribe en español, en tercera persona y con estilo de historia clínica, frases cortas.
- Responde SOLO con un objeto JSON con los campos: ${HISTORY_FIELDS.map(f => f[0]).join(", ")} (cada uno {texto, cita}), senales_mencionadas (lista de {texto, cita}), no_preguntado (lista de textos).`;
const fieldSchema = { type: "object", properties: { texto: { type: "string" }, cita: { type: "string" } }, required: ["texto", "cita"], additionalProperties: false };
const HISTORY_SCHEMA = {
  type: "object",
  properties: {
    ...Object.fromEntries(HISTORY_FIELDS.map(([k, d]) => [k, { ...fieldSchema, description: d }])),
    senales_mencionadas: { type: "array", items: fieldSchema },
    no_preguntado: { type: "array", items: { type: "string" } },
  },
  required: [...HISTORY_FIELDS.map(f => f[0]), "senales_mencionadas", "no_preguntado"],
  additionalProperties: false,
};
const HISTORY_TASK = {
  system: HISTORY_SYSTEM,
  schema: HISTORY_SCHEMA,
  normalize(out) {
    for (const [k] of HISTORY_FIELDS) {
      const v = out[k];
      out[k] = v && typeof v === "object" ? { texto: String(v.texto || ""), cita: String(v.cita || "") } : { texto: typeof v === "string" ? v : "", cita: "" };
    }
    out.senales_mencionadas = Array.isArray(out.senales_mencionadas) ? out.senales_mencionadas : [];
    out.no_preguntado = Array.isArray(out.no_preguntado) ? out.no_preguntado.map(String) : [];
    return out;
  },
};

async function handleHistory(body, env, origin) {
  if (body.ficticio !== true) return json({ error: "Este prototipo solo admite pacientes ficticios" }, 400, origin);
  const transcript = String(body.transcript || "").slice(0, 20000);
  if (transcript.trim().length < 40) return json({ error: "La transcripción es demasiado corta" }, 400, origin);
  if (hasPII(transcript)) return json({ error: "La transcripción parece contener datos identificativos (DNI, teléfono o email). Quítalos." }, 400, origin);
  try {
    const out = env.GEMINI_API_KEY ? await callGemini(env, "Transcripción de la entrevista:\n\n" + transcript, HISTORY_TASK)
                                   : await callClaude(env, "Transcripción de la entrevista:\n\n" + transcript, HISTORY_TASK);
    out.campos = HISTORY_FIELDS;
    return json(out, 200, origin);
  } catch (e) {
    return json({ error: e.message, detail: e.detail }, e.status || 502, origin);
  }
}

function cors(origin) {
  const ok = ALLOWED_ORIGINS.includes(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Access-Code",
    "Vary": "Origin",
  };
}
function json(body, status, origin) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...cors(origin) } });
}
function hasPII(s) {
  return /\b\d{8}\s?[A-Za-z]\b|\b[XYZxyz]\d{7}[A-Za-z]\b|[^\s@]+@[^\s@]+\.[^\s@]+|\b[6789]\d{2}\s?\d{3}\s?\d{3}\b/.test(s);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
    if (request.method !== "POST") return json({ error: "Método no permitido" }, 405, origin);
    if (!ALLOWED_ORIGINS.includes(origin)) return json({ error: "Origen no permitido" }, 403, origin);
    if (!env.ACCESS_CODE || request.headers.get("X-Access-Code") !== env.ACCESS_CODE)
      return json({ error: "Código de acceso incorrecto" }, 401, origin);

    let body;
    try { body = await request.json(); } catch { return json({ error: "Petición no válida" }, 400, origin); }
    if (new URL(request.url).pathname.replace(/\/+$/, "") === "/historia") return handleHistory(body, env, origin);
    const question = String(body.question || "").slice(0, 300);
    const articles = Array.isArray(body.articles) ? body.articles.slice(0, MAX_ARTICLES) : [];
    if (!question || !articles.length) return json({ error: "Faltan la pregunta o los artículos" }, 400, origin);
    if (hasPII(question)) return json({ error: "La pregunta parece contener datos personales" }, 400, origin);

    const list = articles.map((a, i) =>
      `[${i + 1}] Tipo: ${String(a.type || "").slice(0, 40)} | Año: ${String(a.year || "").slice(0, 4)}\nTítulo: ${String(a.title || "").slice(0, 400)}\nResumen: ${String(a.abstract || "Sin resumen").slice(0, MAX_ABSTRACT)}`
    ).join("\n\n");

    const userText = `Pregunta del fisioterapeuta: ${question}\n\nArtículos recuperados (${articles.length}):\n\n${list}`;
    let out;
    try {
      out = env.GEMINI_API_KEY ? await callGemini(env, userText, SUMMARY_TASK) : await callClaude(env, userText, SUMMARY_TASK);
    } catch (e) {
      return json({ error: e.message, detail: e.detail }, e.status || 502, origin);
    }
    out.n = articles.length;
    return json(out, 200, origin);
  },
};

function fail(message, status, detail) { const e = new Error(message); e.status = status; e.detail = detail; return e; }

const GEMINI_FALLBACKS = ["gemini-3.5-flash", "gemini-3.1-flash-lite", "gemini-2.5-flash"];
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function callGemini(env, userText, task) {
  const models = [...new Set([env.GEMINI_MODEL, ...GEMINI_FALLBACKS].filter(Boolean))];
  const errors = [];
  for (const model of models) {
    // Hasta 3 intentos por modelo, esperando 1 s y 3 s entre ellos si Google está saturado.
    for (const wait of [0, 1000, 3000]) {
      if (wait) await sleep(wait);
      const r = await geminiOnce(env, model, userText, task);
      if (r.ok) return r.out;
      errors.push(model + ": " + r.status);
      if (r.fatal) throw r.fatal;
      if (!r.retry) break;           // p. ej. 404: este modelo no existe, pasar al siguiente
    }
  }
  const all429 = errors.every(e => e.endsWith(": 429"));
  throw fail(all429
    ? "Has llegado al límite gratuito de Gemini por ahora. Prueba en un minuto o mañana, o usa Copiar para Claude."
    : "Gemini está saturado ahora mismo. Prueba en unos minutos o usa Copiar para Claude.", all429 ? 429 : 503, errors.join(", "));
}

async function geminiOnce(env, model, userText, task) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const base = { system_instruction: { parts: [{ text: task.system }] }, contents: [{ role: "user", parts: [{ text: userText }] }] };
  const send = (generationConfig) => fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify({ ...base, generationConfig }),
  });
  // Formato estructurado documentado; si esta versión de la API no lo acepta, se pide JSON por instrucciones.
  let res = await send({ responseFormat: { text: { mimeType: "application/json", schema: task.schema } } });
  if (res.status === 400) res = await send({ responseMimeType: "application/json" });
  if ([429, 500, 503, 504].includes(res.status)) return { ok: false, status: res.status, retry: true };
  if (res.status === 404 || res.status === 403) return { ok: false, status: res.status, retry: false };
  if (res.status === 400 || res.status === 401) {
    const t = (await res.text()).slice(0, 300);
    return { ok: false, status: res.status, fatal: fail("Gemini rechazó la petición (" + res.status + "). Revisa que GEMINI_API_KEY esté bien copiada.", 502, t) };
  }
  if (!res.ok) return { ok: false, status: res.status, retry: true };
  const data = await res.json();
  const cand = (data.candidates || [])[0];
  if (!cand || !cand.content) return { ok: false, status: "sin respuesta", fatal: fail("Gemini no ha podido resumir esta búsqueda", 422) };
  if (cand.finishReason === "MAX_TOKENS") return { ok: false, status: "MAX_TOKENS", fatal: fail("El resumen salió demasiado largo; prueba con menos artículos", 422) };
  const text = (cand.content.parts || []).filter(p => !p.thought && p.text).map(p => p.text).join("");
  try { const out = task.normalize(parseOut(text)); out.model = model; return { ok: true, out }; }
  catch (e) { return { ok: false, status: "formato", retry: true }; }
}

function parseOut(text) {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "");
  let out;
  try { out = JSON.parse(t); } catch { throw fail("La respuesta de la IA no tenía el formato esperado", 502); }
  if (typeof out !== "object" || !out) throw fail("La respuesta de la IA no tenía el formato esperado", 502);
  return out;
}

async function callClaude(env, userText, task) {
  if (!env.ANTHROPIC_API_KEY) throw fail("Falta la clave de la IA en Cloudflare (GEMINI_API_KEY)", 500);
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2026-10-21",
        "anthropic-beta": "server-side-fallback-2026-07-01",
      },
      body: JSON.stringify({
        model: "claude-opus-5-5",
        max_tokens: 16000,
        fallbacks: "default",
        output_config: { effort: "medium", format: { type: "json_schema", schema: task.schema } },
        system: task.system,
        messages: [{ role: "user", content: userText }],
      }),
    });
    if (!res.ok) throw fail("Claude respondió con un error (" + res.status + ")", 502, (await res.text()).slice(0, 300));
    const msg = await res.json();
    if (msg.stop_reason === "refusal") throw fail("La IA no ha podido resumir esta búsqueda", 422);
    if (msg.stop_reason === "max_tokens") throw fail("El resumen salió demasiado largo; prueba con menos artículos", 422);
    return task.normalize(parseOut((msg.content || []).filter(b => b.type === "text").map(b => b.text).join("")));
}
