# Servicio de resumen (Cloudflare Worker)

Guarda la clave de la API de Anthropic fuera de la web pública. La app le envía la pregunta y los resúmenes de los artículos (datos públicos, nunca datos de pacientes) y recibe un resumen con citas.

## Puesta en marcha

1. **Clave de Anthropic**: en console.anthropic.com crea una cuenta, añade saldo en Billing y crea una clave en API Keys. Cópiala: solo se muestra una vez.
2. **Cloudflare**: en dash.cloudflare.com crea una cuenta gratuita y ve a Workers & Pages > Create > Create Worker. Ponle de nombre `fisioevidencia` y pulsa Deploy.
3. Pulsa **Edit code**, borra todo, pega el contenido de `worker.js` y pulsa **Deploy**.
4. En el Worker, ve a **Settings > Variables and Secrets** y añade dos de tipo Secret:
   - `ANTHROPIC_API_KEY`: la clave del paso 1.
   - `ACCESS_CODE`: un código que inventes (por ejemplo, una frase larga).
5. Copia la dirección del Worker (termina en `.workers.dev`).
6. En la app, abre **Ajustes del resumen con IA** al final de la página, pega la dirección y el código, y pulsa Guardar.

## Coste

Unos 0,10 € por resumen con el modelo Claude Opus 5.5. Cada resumen se guarda 30 días en el dispositivo, así que repetir la misma búsqueda no cuesta nada. Cloudflare es gratis hasta 100.000 peticiones al día.
