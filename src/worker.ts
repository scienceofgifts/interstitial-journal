import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { GoogleGenAI, Type } from '@google/genai';
import journalApp from './worker/app';

export type WorkerBindings = {
  GEMINI_API_KEY: string;
  GEMINI_FLASH_LITE_MODEL?: string;
  TRANSCRIPTION_MODEL?: string;
  AUDIO_BUCKET?: any;
  DB?: any;
  ASSETS?: { fetch: (req: Request) => Promise<Response> };
  [key: string]: any;
};

const app = new Hono<{ Bindings: WorkerBindings }>();

// Enable CORS for all incoming API requests
app.use('*', cors());

// Helper to instantiate GoogleGenAI client with Worker environment key
function getGeminiClient(apiKey: string): GoogleGenAI {
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build-interstitial',
      },
    },
  });
}

// ---------------------------------------------------------------------------
// 1. POST /api/tts-reference: Speech synthesis and reference audio generation
// ---------------------------------------------------------------------------
app.post('/api/tts-reference', async (c) => {
  try {
    const apiKey = c.env.GEMINI_API_KEY || (typeof process !== 'undefined' ? process.env?.GEMINI_API_KEY : '');
    if (!apiKey) {
      return c.json({ error: 'GEMINI_API_KEY is not configured in worker environment.' }, 500);
    }

    const body = await c.req.json().catch(() => ({}));
    const rawText = typeof body.text === 'string' ? body.text.trim() : '';
    const text = rawText || 'Take a moment to breathe, ground yourself, and reflect on this transition.';
    const voice = typeof body.voice === 'string' && body.voice.trim() ? body.voice.trim() : 'Kore';

    const ai = getGeminiClient(apiKey);
    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash-lite-tts',
      contents: [
        {
          role: 'user',
          parts: [{ text }],
        },
      ],
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: voice },
          },
        },
      },
    });

    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!base64Audio) {
      return c.json({ error: 'Failed to synthesize reference speech audio from Gemini API.' }, 502);
    }

    return c.json({
      status: 'ok',
      audioBase64: base64Audio,
      mimeType: 'audio/wav',
      text,
      voice,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Error generating TTS reference audio:', message);
    return c.json({ error: `TTS reference synthesis failed: ${message}` }, 500);
  }
});

// ---------------------------------------------------------------------------
// 2. POST /api/conversation-reply: Reflective journal dialogue companion
// ---------------------------------------------------------------------------
app.post('/api/conversation-reply', async (c) => {
  try {
    const apiKey = c.env.GEMINI_API_KEY || (typeof process !== 'undefined' ? process.env?.GEMINI_API_KEY : '');
    if (!apiKey) {
      return c.json({ error: 'GEMINI_API_KEY is not configured in worker environment.' }, 500);
    }

    const body = await c.req.json().catch(() => ({}));
    const userMessage = typeof body.message === 'string' ? body.message.trim() : '';
    const history = Array.isArray(body.history) ? body.history : [];
    const style = typeof body.style === 'string' ? body.style : 'reflective';

    if (!userMessage && history.length === 0) {
      return c.json({ error: 'A message or conversation history is required.' }, 400);
    }

    const ai = getGeminiClient(apiKey);
    const systemInstruction = [
      'You are Interstitial Journal companion, an empathetic, calm, and thoughtful reflection guide.',
      'Your role is to help the user reflect on their day, transitions between tasks, and mental clarity.',
      'Keep responses concise (2 to 4 sentences), grounding, and focused on constructive questions and self-awareness.',
      'Avoid corporate jargon, unsolicited advice, or hollow cheerleading.',
      `Tone preference: ${style}.`,
    ].join('\n');

    const contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];

    for (const item of history.slice(-6)) {
      if (item && typeof item.content === 'string' && item.content.trim()) {
        contents.push({
          role: item.role === 'model' || item.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: item.content.trim() }],
        });
      }
    }

    if (userMessage) {
      contents.push({
        role: 'user',
        parts: [{ text: userMessage }],
      });
    }

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents,
      config: {
        systemInstruction,
        maxOutputTokens: 600,
        temperature: 0.7,
      },
    });

    const reply = (response.text || '').trim();

    return c.json({
      status: 'ok',
      reply: reply || 'I hear your reflection. What is the most important next step for your peace of mind?',
      role: 'model',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Error in conversation reply:', message);
    return c.json({ error: `Conversation reply generation failed: ${message}` }, 500);
  }
});

// ---------------------------------------------------------------------------
// 3. POST /api/analyze-speech: Audio & transcript analysis for pacing & tone
// ---------------------------------------------------------------------------
app.post('/api/analyze-speech', async (c) => {
  try {
    const apiKey = c.env.GEMINI_API_KEY || (typeof process !== 'undefined' ? process.env?.GEMINI_API_KEY : '');
    if (!apiKey) {
      return c.json({ error: 'GEMINI_API_KEY is not configured in worker environment.' }, 500);
    }

    const body = await c.req.json().catch(() => ({}));
    const { audioBase64, mimeType = 'audio/webm', transcript = '', text = '' } = body;
    const inputText = (transcript || text || '').trim();

    if (!audioBase64 && !inputText) {
      return c.json(
        { error: 'Either audioBase64 or a text transcript is required for speech analysis.' },
        400
      );
    }

    const ai = getGeminiClient(apiKey);
    const parts: any[] = [];

    if (audioBase64 && typeof audioBase64 === 'string') {
      const cleanMime = mimeType.split(';')[0].trim();
      parts.push({
        inlineData: {
          mimeType: cleanMime,
          data: audioBase64,
        },
      });
    }

    const promptText = [
      'Analyze the spoken thoughts or journal entry provided.',
      inputText ? `Text content: "${inputText}"` : '',
      'Provide a structured JSON evaluation with the following fields:',
      '1. transcription: The exact faithful words spoken if audio was provided, or repeated text.',
      '2. tone: Emotional and cognitive tone (e.g., contemplative, anxious, energized, calm, determined).',
      '3. clarity: Brief assessment of narrative clarity, pacing, and flow.',
      '4. keyThemes: An array of 2 to 4 recurring themes or focal points.',
      '5. suggestions: An array of 1 to 3 constructive ideas or follow-up prompts for deeper reflection.',
      '6. summary: A single-sentence essence of the entry.',
    ]
      .filter(Boolean)
      .join('\n');

    parts.push({ text: promptText });

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: { parts },
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            transcription: { type: Type.STRING },
            tone: { type: Type.STRING },
            clarity: { type: Type.STRING },
            keyThemes: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
            suggestions: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
            summary: { type: Type.STRING },
          },
          required: ['tone', 'clarity', 'keyThemes', 'suggestions', 'summary'],
        },
      },
    });

    const parsed = JSON.parse(response.text || '{}');

    return c.json({
      status: 'ok',
      analysis: {
        transcription: parsed.transcription || inputText || '',
        tone: parsed.tone || 'Reflective',
        clarity: parsed.clarity || 'Clear and natural speech flow.',
        keyThemes: parsed.keyThemes || ['Daily reflection'],
        suggestions: parsed.suggestions || ['Continue capturing spontaneous thoughts regularly.'],
        summary: parsed.summary || 'A personal thought recorded for later review.',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Error analyzing speech:', message);
    return c.json({ error: `Speech analysis failed: ${message}` }, 500);
  }
});

// ---------------------------------------------------------------------------
// 4. Mount existing journal routes (/api/transcribe, /api/cleanup, /api/entries, etc.)
// ---------------------------------------------------------------------------
app.route('/', journalApp);

// ---------------------------------------------------------------------------
// 5. Cloudflare Workers + Static Assets SPA Fallback
// ---------------------------------------------------------------------------
app.get('*', async (c) => {
  if (c.env.ASSETS) {
    const res = await c.env.ASSETS.fetch(c.req.raw);
    if (res.status !== 404) {
      return res;
    }
    // Return index.html for SPA client-side routing
    return c.env.ASSETS.fetch(new Request(new URL('/index.html', c.req.url), c.req.raw));
  }
  return c.text('Not Found', 404);
});

export default app;
