// FisioEvidencia: servicio de resumen de literatura (Cloudflare Worker).
// Guarda la clave de la API de Anthropic fuera de la web pública.
//
// Variables que hay que crear en Cloudflare (Settings > Variables and Secrets):
//   ANTHROPIC_API_KEY  (Secret)  la clave de console.anthropic.com
//   ACCESS_CODE        (Secret)  un código que solo conozcas tú; la app lo pide una vez
//
// Se usa fetch directo porque el editor web de Cloudflare no permite instalar el SDK.

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
- La certeza es una estimación aproximada a partir de resúmenes, no una evaluación GRADE formal.
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
    lagunas: { type: "string", description: "Qué no se sabe o qué falta en esta evidencia" },
  },
  required: ["resumen", "certeza", "hallazgos", "tecnicas", "lagunas"],
  additionalProperties: false,
};

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
    const question = String(body.question || "").slice(0, 300);
    const articles = Array.isArray(body.articles) ? body.articles.slice(0, MAX_ARTICLES) : [];
    if (!question || !articles.length) return json({ error: "Faltan la pregunta o los artículos" }, 400, origin);
    if (hasPII(question)) return json({ error: "La pregunta parece contener datos personales" }, 400, origin);

    const list = articles.map((a, i) =>
      `[${i + 1}] Tipo: ${String(a.type || "").slice(0, 40)} | Año: ${String(a.year || "").slice(0, 4)}\nTítulo: ${String(a.title || "").slice(0, 400)}\nResumen: ${String(a.abstract || "Sin resumen").slice(0, MAX_ABSTRACT)}`
    ).join("\n\n");

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
        output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
        system: SYSTEM,
        messages: [{ role: "user", content: `Pregunta del fisioterapeuta: ${question}\n\nArtículos recuperados (${articles.length}):\n\n${list}` }],
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      return json({ error: "El servicio de IA respondió con un error (" + res.status + ")", detail: detail.slice(0, 300) }, 502, origin);
    }
    const msg = await res.json();
    if (msg.stop_reason === "refusal") return json({ error: "La IA no ha podido resumir esta búsqueda" }, 422, origin);
    if (msg.stop_reason === "max_tokens") return json({ error: "El resumen salió demasiado largo; prueba con menos artículos" }, 422, origin);
    const text = (msg.content || []).filter(b => b.type === "text").map(b => b.text).join("");
    let out;
    try { out = JSON.parse(text); } catch { return json({ error: "La respuesta de la IA no tenía el formato esperado" }, 502, origin); }
    out.n = articles.length;
    out.usage = { input: msg.usage?.input_tokens, output: msg.usage?.output_tokens };
    return json(out, 200, origin);
  },
};
