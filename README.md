# WhatsApp Group Assistant

Plantilla de arquitectura para un asistente de grupos de WhatsApp construido con TypeScript. El proyecto separa conexión, contexto, generación de respuestas, memoria local y voz para que cada parte pueda configurarse por separado.

La copia pública contiene código y documentación genéricos. No incluye sesiones de WhatsApp, conversaciones, audios, bases de datos, claves API ni documentos de contexto reales.

## Funciones

- Conexión a grupos mediante Baileys y sesión local con QR.
- Lista de grupos permitidos; sin grupos configurados, el bot no responde.
- Agrupación de mensajes consecutivos, contexto reciente y límites de frecuencia.
- Respuestas estructuradas en JSON generadas con OpenRouter.
- Historial conversacional local en SQLite.
- Resumen opcional de contexto por participante, desactivado por defecto.
- Transcripción local de audio con Whisper.cpp y ffmpeg, si se instalan por separado.
- Notas de voz salientes opcionales mediante proveedores de TTS.

## Requisitos

- Node.js 22.5 o posterior.
- Una clave de OpenRouter para generar respuestas.
- Para audio entrante: ffmpeg, Whisper.cpp y un modelo compatible, instalados localmente.
- Para voz saliente: ffmpeg y, según el proveedor elegido, sus herramientas o credenciales.

## Puesta en marcha

```powershell
npm install
Copy-Item .env.example .env
```

Edita `.env` y define al menos:

```dotenv
OPENROUTER_API_KEY=tu_clave
ALLOWED_GROUPS=JID_o_nombre_del_grupo
```

`ALLOWED_GROUPS` acepta JID o parte del nombre del grupo, separados por comas. Déjalo vacío para que el bot no procese grupos. No publiques `.env` ni compartas el QR de autenticación.

Después:

```powershell
npm run build
npm start
```

Escanea el QR que aparece en la terminal con WhatsApp en **Dispositivos vinculados**. Las credenciales quedan en `auth_info/` y se reutilizan al reiniciar. Para desconectar la sesión, elimina esa carpeta localmente.

En desarrollo puedes usar `npm run dev`.

## Configuración opcional

- `BOT_NAME`: nombre visible del asistente; por defecto `Asistente`.
- `SILENT_GROUPS`: grupos que se registran localmente sin respuesta.
- `ENABLE_USER_NOTES=true`: habilita resúmenes de contexto de baja sensibilidad por participante. Por defecto está apagado.
- `SPONTANEOUS_LEVEL=1` o `2`: habilita mensajes espontáneos; por defecto está apagado (`0`).
- `WHISPER_BIN`, `WHISPER_MODEL`, `FFMPEG_PATH`: rutas para la transcripción local.
- `TTS_EDGE_VOICE`, `ELEVENLABS_*`, `FISH_AUDIO_*`: selección de voz y credenciales TTS.

Consulta [.env.example](.env.example) y [ARCHITECTURE.md](ARCHITECTURE.md) para más detalle.

## Datos y privacidad

El bot guarda el historial local en `data/bot.db`, la sesión en `auth_info/` y la caché de audio en `tools/cache/`. Esos archivos están excluidos de Git. El contenido de los grupos se envía al proveedor LLM configurado para generar respuestas; configura el bot solo en grupos donde tengas autorización y avisa a sus participantes. El repositorio no trae conversaciones de muestra ni archivos de autenticación.

Baileys conecta mediante una sesión de dispositivo vinculado. Revisa las condiciones del servicio y limita el uso a grupos autorizados.
