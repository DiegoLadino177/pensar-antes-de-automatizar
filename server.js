// Servidor mínimo que conecta el chat de IA.html con Claude (API de Anthropic).
// La clave vive SOLO aquí (variable de entorno), nunca en el HTML.
//
// Uso:
//   export ANTHROPIC_API_KEY="sk-ant-..."
//   node server.js
//   Abre http://localhost:3000
//
// GRATIS: usa Gemini (Google) con una clave de https://aistudio.google.com/apikey
//   export GEMINI_API_KEY="..."      (opcional: GEMINI_MODEL, por defecto gemini-3.8-flash)
// Si defines las dos claves, se usa Gemini.
//
// Opcional: CLAUDE_MODEL (por defecto claude-haiku-5-5), PORT (por defecto 3000)

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-5-5';
const API_KEY = process.env.ANTHROPIC_API_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
// Busca IA.html; si se descargó con otro nombre (ej. "IA (2).html"), usa el primer .html de la carpeta
function findPage() {
  const exact = path.join(__dirname, 'IA.html');
  if (fs.existsSync(exact)) return exact;
  const other = fs.readdirSync(__dirname).find((f) => f.toLowerCase().endsWith('.html'));
  return other ? path.join(__dirname, other) : null;
}

const SYSTEM = `Eres el asistente de la página educativa "Pensar antes de Automatizar", un proyecto de Ingeniería de Sistemas sobre inteligencia artificial y sociedad.
Objetivo de la página: formar usuarios conscientes, críticos y responsables frente a la IA. Tiene contenido informativo, un detector de uso responsable (cuestionario de 8 preguntas con clasificación orientativa: uso responsable, moderado o riesgoso) y un simulador de decisiones éticas (4 escenarios: sesgo en selección de personal, privacidad de datos de estudiantes, deepfakes y desinformación, decisiones automatizadas como créditos).
Referentes: UNESCO (2021), OCDE (2024) y NIST AI RMF (2023).
Reglas:
- Responde siempre en español, claro y breve (máximo ~150 palabras salvo que pidan más detalle).
- Puedes responder preguntas variadas y difíciles sobre IA, su impacto social, ética, privacidad, sesgos, empleo, regulación, educación, etc. Si preguntan algo ajeno al tema, responde brevemente y vuelve a conectar con la IA y la sociedad.
- Sé honesto: si no estás seguro o la información puede haber cambiado, dilo.
- Texto plano; puedes usar **negrita** y viñetas con "•". Sin encabezados ni tablas.
- Recuerda cuando sea útil que la responsabilidad final de las decisiones es humana.`;

// Límite simple por IP: 20 mensajes por minuto
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 60000);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > 20;
}

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

http.createServer(async (req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/IA.html')) {
    const page = findPage();
    if (!page) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('No encuentro ningún archivo .html en la carpeta ' + __dirname + '. Pon IA.html junto a server.js.');
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return fs.createReadStream(page).pipe(res);
  }

  if (req.method === 'POST' && req.url === '/api/chat') {
    if (!API_KEY && !GEMINI_KEY) return send(res, 503, { error: 'Falta GEMINI_API_KEY o ANTHROPIC_API_KEY en el servidor.' });
    if (limited((req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim())) return send(res, 429, { error: 'Demasiados mensajes, espera un momento.' });

    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 20000) return send(res, 413, { error: 'Mensaje demasiado largo.' });
    }

    let messages;
    try {
      messages = JSON.parse(body).messages;
      if (!Array.isArray(messages)) throw new Error();
      // Solo roles válidos, últimos 12 mensajes, texto recortado
      messages = messages
        .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
        .slice(-12)
        .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
      if (!messages.length || messages[0].role !== 'user') throw new Error();
    } catch {
      return send(res, 400, { error: 'Solicitud inválida.' });
    }

    try {
      if (GEMINI_KEY) {
        // Si Google está saturado (503) o hay límite momentáneo (429), reintenta hasta 4 veces
        let g, gd;
        for (let intento = 1; intento <= 4; intento++) {
          g = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: SYSTEM }] },
              contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
              generationConfig: { maxOutputTokens: 800 }
            })
          });
          gd = await g.json();
          if (g.ok || (g.status !== 503 && g.status !== 429) || intento === 4) break;
          console.warn(`Gemini ocupado (${g.status}), reintento ${intento}/3...`);
          await new Promise((ok) => setTimeout(ok, 1500 * intento));
        }
        if (!g.ok) {
          console.error('Error de Gemini:', JSON.stringify(gd));
          return send(res, 502, { error: 'La IA no respondió.' });
        }
        const gtext = ((gd.candidates || [])[0]?.content?.parts || []).map((x) => x.text || '').join('\n');
        return send(res, 200, { reply: gtext });
      }
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({ model: MODEL, max_tokens: 700, system: SYSTEM, messages })
      });
      const data = await r.json();
      if (!r.ok) {
        console.error('Error de la API:', data);
        return send(res, 502, { error: 'La IA no respondió.' });
      }
      const reply = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      return send(res, 200, { reply });
    } catch (e) {
      console.error(e);
      return send(res, 502, { error: 'No se pudo contactar a la IA.' });
    }
  }

  send(res, 404, { error: 'No encontrado' });
}).listen(PORT, () => {
  console.log(`Servidor listo en http://localhost:${PORT}`);
  const pg = findPage();
  console.log(pg ? 'Página: ' + path.basename(pg) : '⚠️  No hay ningún .html en ' + __dirname);
  if (GEMINI_KEY) console.log('IA activa: Gemini (' + GEMINI_MODEL + ')');
  else if (API_KEY) console.log('IA activa: Claude (' + MODEL + ')');
  else console.warn('⚠️  Define GEMINI_API_KEY (gratis) o ANTHROPIC_API_KEY. Mientras tanto, el chat usa respuestas locales.');
});
