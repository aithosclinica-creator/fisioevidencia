# Servicio de resumen (Cloudflare Worker)

Guarda la clave de la IA fuera de la web pública. La app le envía la pregunta y los resúmenes de los artículos (datos públicos, nunca datos de pacientes) y recibe un resumen con citas. Usa **Gemini gratis** por defecto.

## Puesta en marcha

1. **Clave de Gemini (gratis)**: entra en aistudio.google.com con tu cuenta de Google, pulsa **Get API key** y luego **Create API key**. Cópiala.
2. **Cloudflare**: en dash.cloudflare.com crea una cuenta gratuita y ve a Workers & Pages > Create > Create Worker. Ponle de nombre `fisioevidencia` y pulsa Deploy.
3. Pulsa **Edit code**, borra todo, pega el contenido de `worker.js` y pulsa **Deploy**.
4. En el Worker, ve a **Settings > Variables and Secrets** y añade dos de tipo Secret:
   - `GEMINI_API_KEY`: la clave del paso 1.
   - `ACCESS_CODE`: un código que inventes (por ejemplo, una frase larga).
5. Copia la dirección del Worker (termina en `.workers.dev`).
6. En la app, toca **Activar el resumen gratis**, pega la dirección y el código, y pulsa Guardar.

## Límites y privacidad

- El nivel gratuito tiene un límite de peticiones por minuto y por día. Puedes ver el tuyo en aistudio.google.com/rate-limit. Cada resumen se guarda 30 días en el dispositivo, así que repetir una búsqueda no gasta cupo.
- En el nivel gratuito, Google puede usar lo que se envía para mejorar sus productos. Aquí solo se envían resúmenes de artículos públicos.
- Modelo por defecto: `gemini-3.5-flash`. Para cambiarlo, añade una variable de texto `GEMINI_MODEL`.
- Opcional, de pago: si quitas `GEMINI_API_KEY` y añades `ANTHROPIC_API_KEY`, el resumen lo hace Claude (unos 0,10 € por resumen).
